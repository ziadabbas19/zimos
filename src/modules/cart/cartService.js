'use strict';

const { effectiveVariantPrice } = require('../catalog/productPage');

const crypto = require('crypto');
const db = require('../../db/models');
const { NotFoundError, AppError } = require('../../core/errors/AppError');
const { toPublicVariant } = require('../storefront/storefrontService');
const { resolveCustomizations, sameCustomizations, snapshotToInput, bindUploadsToCart } = require('../catalog/customFields');
const { customFieldsDelta } = require('../catalog/customFieldPricing');
const productTests = require('../catalog/productTests');
const menuOptions = require('../catalog/menuOptions');

function generateGuestToken() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Resolves the cart for a guest token, creating one if the token is missing
 * or doesn't match an active cart in THIS workspace. A guest token from
 * another workspace never resolves here — carts are workspace-scoped like
 * everything else, so a token can't be replayed across tenants.
 */
async function getOrCreateCart(workspaceId, guestToken) {
  if (guestToken) {
    const existing = await db.Cart.findOne({ where: { workspaceId, guestToken, status: 'active' } });
    if (existing) return existing;
  }
  const token = generateGuestToken();
  return db.Cart.create({ workspaceId, guestToken: token, status: 'active' });
}

async function getCart(workspaceId, cartId) {
  const cart = await db.Cart.findOne({
    where: { id: cartId, workspaceId },
    include: [
      {
        model: db.CartItem,
        as: 'items',
        include: [
          // The product rides along for its countdown offer (catalog/productPage.js).
          { model: db.ProductVariant, as: 'variant', include: [{ model: db.Product, as: 'product', attributes: ['id', 'pageSettings', 'customFields'] }] },
          { model: db.Offer, as: 'offer' },
        ],
      },
    ],
    // Lines in the order they were added. Without it Postgres may return a line
    // it just updated (a merged add, a new quantity) after the others.
    order: [
      [{ model: db.CartItem, as: 'items' }, 'createdAt', 'ASC'],
      [{ model: db.CartItem, as: 'items' }, 'id', 'ASC'],
    ],
  });
  if (!cart) throw new NotFoundError('Cart');
  // A product A/B test prices plain lines for whoever filled the cart (catalog/productTests.js).
  const testPrices = await productTests.visitorPrices(workspaceId, (cart.items || []).filter((i) => !i.offerId).map((i) => i.variantId), cart.visitorId);
  // Quantity bundles lower the lines they cover, as they will on the order.
  const optionIndex = await menuOptions.choiceIndex(workspaceId, (cart.items || []).map((i) => i.selectedOptions));
  const totals = withComputedTotals(cart, testPrices, optionIndex);
  await priceCombos(workspaceId, cart, totals);
  return require('../bundles/bundlePricing').applyToCartTotals(workspaceId, cart, totals);
}

/**
 * A combo's line (modules/combos) at the combo's price now, with what it
 * holds; one that can no longer be bought (archived, a product gone, combos
 * off) shows `unavailable` and counts nothing. The checkout prices it again.
 */
async function priceCombos(workspaceId, cart, totals) {
  const rows = cart.items || [];
  if (!rows.some((row) => row.comboId)) return;
  const comboService = require('../combos/comboService');
  for (const [index, item] of totals.items.entries()) {
    const row = rows[index];
    if (!row || !row.comboId) continue;
    const line = await comboService.cartLine(workspaceId, row.comboId, row.comboSelection);
    const unit = line.unavailable ? 0 : line.unitPrice;
    Object.assign(item, {
      comboId: row.comboId,
      comboSelection: row.comboSelection || [],
      combo: line.unavailable ? null : line.combo,
      unavailable: Boolean(line.unavailable),
      fullUnitPrice: line.unavailable ? null : line.fullUnitPrice,
      currentUnitPrice: unit,
      priceChanged: !line.unavailable && Number(unit) !== Number(row.unitPriceSnapshot),
      lineTotal: Number(unit) * item.quantity,
    });
  }
  totals.subtotal = totals.items.reduce((sum, i) => sum + i.lineTotal, 0);
}

/** A whole combo as one cart line; the same combo with the same picks adds to its line. */
async function addCombo(workspaceId, cartId, { comboId, comboSelection, quantity }) {
  const pricing = require('../combos/comboPricing');
  const combo = await pricing.activeCombo(workspaceId, comboId);
  const components = await pricing.resolveComponents(workspaceId, combo, comboSelection);
  const price = pricing.priceComponents(combo, components);
  // Only the components the shopper picks, in the combo's order: the same picks are the same line.
  const selection = components.filter(({ item }) => item.pickVariant).map(({ item, variant }) => ({ itemId: item.id, variantId: variant.id }));
  const lines = await db.CartItem.findAll({ where: { cartId, comboId: combo.id } });
  const existing = lines.find((line) => JSON.stringify(line.comboSelection || []) === JSON.stringify(selection));
  if (existing) {
    await existing.update({ quantity: existing.quantity + quantity, unitPriceSnapshot: price.total });
  } else {
    await db.CartItem.create({ cartId, variantId: components[0].variant.id, comboId: combo.id, comboSelection: selection, quantity, unitPriceSnapshot: price.total });
  }
  return getCart(workspaceId, cartId);
}

/**
 * Cart totals shown to the shopper are computed fresh from live catalog
 * prices on every read — never trusted from unitPriceSnapshot, which exists
 * only so the UI can show "price changed since you added this" banners.
 * The authoritative price is always resolved again at checkout time inside
 * orderService, exactly like every other entry point into order creation.
 */
function withComputedTotals(cart, testPrices = new Map(), optionIndex = new Map()) {
  const items = (cart.items || []).map((item) => {
    const listUnit = item.offer
      ? item.offer.priceAmount
      : testPrices.has(item.variantId)
        ? testPrices.get(item.variantId)
        : effectiveVariantPrice(item.variant, item.variant.product).priceAmount;
    // Priced custom fields (catalog/customFieldPricing.js), as the order will charge them.
    const fieldsDelta = customFieldsDelta(item.variant && item.variant.product && item.variant.product.customFields, item.customizations);
    // Menu options, at their current prices (catalog/menuOptions.js).
    const options = menuOptions.priceFromIndex(item.selectedOptions, optionIndex);
    const extras = fieldsDelta + options.delta;
    const currentUnitPrice = extras ? Number(listUnit) + extras : listUnit;
    return {
      id: item.id,
      variantId: item.variantId,
      offerId: item.offerId,
      quantity: item.quantity,
      unitPriceSnapshot: item.unitPriceSnapshot,
      currentUnitPrice,
      priceChanged: Number(currentUnitPrice) !== Number(item.unitPriceSnapshot),
      lineTotal: Number(currentUnitPrice) * item.quantity,
      variant: item.variant ? toPublicVariant(item.variant) : null,
      isOrderBump: item.isOrderBump,
      // The shopper's answers, labels included; photos by upload id only.
      customizations: item.customizations || null,
      // The menu options picked, with current names and prices; null when none.
      options: options.snapshot,
      selectedOptions: item.selectedOptions || null,
    };
  });
  const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
  return {
    id: cart.id,
    guestToken: cart.guestToken,
    currency: cart.currency,
    status: cart.status,
    items,
    subtotal,
  };
}

async function addItem(workspaceId, cartId, { variantId, offerId, quantity, customizations, options, visitorId, comboId, comboSelection }) {
  if (comboId) return addCombo(workspaceId, cartId, { comboId, comboSelection, quantity });
  // A draft or archived product isn't for sale, even if its variant row is active.
  const variant = await db.ProductVariant.findOne({
    where: { id: variantId, workspaceId, status: 'active' },
    include: [{ model: db.Product, as: 'product', where: { status: 'active' }, attributes: ['id', 'customFields'] }],
  });
  if (!variant) throw new NotFoundError('ProductVariant');

  // Checked against the product's fields as the shopper adds it; checked again
  // at checkout. A photo must be this visitor's, or already in this cart.
  const snapshot = await resolveCustomizations(variant.product, customizations, {
    workspaceId,
    visitorId,
    cartId,
    enforceRequired: true,
  });

  // Menu options: checked against the product's menu now (required groups included), and again at checkout.
  const picked = await menuOptions.resolveSelection(workspaceId, variant.productId, options, { enforceRequired: true });

  // The cart is priced for whoever last added to it (catalog/productTests.js).
  if (visitorId) await db.Cart.update({ visitorId }, { where: { id: cartId, workspaceId } });
  const testPrice = offerId ? undefined : (await productTests.visitorPrices(workspaceId, [variantId], visitorId)).get(variantId);
  let unitPrice = testPrice !== undefined ? testPrice : variant.priceAmount;
  if (offerId) {
    const offer = await db.Offer.findOne({ where: { id: offerId, workspaceId, productId: variant.productId, status: 'active' } });
    if (!offer) throw new NotFoundError('Offer');
    unitPrice = offer.priceAmount;
  }
  const fieldsDelta = customFieldsDelta(variant.product.customFields, snapshot);
  if (fieldsDelta) unitPrice = Number(unitPrice) + fieldsDelta;
  if (picked.deltaPerUnit) unitPrice = Number(unitPrice) + picked.deltaPerUnit;

  // The same product with different answers ("Ahmed" / "Sara" engraved) is a
  // line of its own; only identical ones add up.
  const candidates = await db.CartItem.findAll({ where: { cartId, variantId, offerId: offerId || null, comboId: null } });
  const existing = candidates.find(
    (line) => sameCustomizations(line.customizations, snapshot) && menuOptions.sameSelection(line.selectedOptions, picked.input)
  );
  // The product's maximum per order (catalog/purchaseLimits.js).
  await require('../catalog/purchaseLimits').assertCartMax(workspaceId, cartId, variantId, (existing ? existing.quantity : 0) + quantity, existing ? existing.id : null, offerId || null);
  if (existing) {
    await existing.update({ quantity: existing.quantity + quantity, unitPriceSnapshot: unitPrice });
  } else {
    await db.CartItem.create({
      cartId,
      variantId,
      offerId: offerId || null,
      quantity,
      unitPriceSnapshot: unitPrice,
      customizations: snapshot,
      selectedOptions: picked.input,
    });
  }
  await bindUploadsToCart(snapshot, cartId);

  return getCart(workspaceId, cartId);
}

async function updateItemQuantity(workspaceId, cartId, itemId, quantity) {
  const item = await db.CartItem.findOne({ where: { id: itemId, cartId } });
  if (!item) throw new NotFoundError('CartItem');
  if (quantity <= 0) {
    await item.destroy();
  } else {
    // A combo's limits are its products', checked at checkout on each of them.
    if (!item.comboId) await require('../catalog/purchaseLimits').assertCartMax(workspaceId, cartId, item.variantId, quantity, item.id, item.offerId || null);
    await item.update({ quantity });
  }
  return getCart(workspaceId, cartId);
}

async function removeItem(workspaceId, cartId, itemId) {
  const item = await db.CartItem.findOne({ where: { id: itemId, cartId } });
  if (!item) throw new NotFoundError('CartItem');
  await item.destroy();
  return getCart(workspaceId, cartId);
}

/** Used by the checkout endpoint to turn cart rows into orderService's item shape. */
async function toOrderItems(workspaceId, cartId) {
  const cart = await db.Cart.findOne({ where: { id: cartId, workspaceId, status: 'active' }, include: [{ model: db.CartItem, as: 'items' }] });
  if (!cart) throw new NotFoundError('Cart');
  if (!cart.items || cart.items.length === 0) {
    throw new AppError('EMPTY_CART', 'Cart has no items', 422);
  }
  return {
    cart,
    items: cart.items.map((i) => ({
      variantId: i.variantId,
      offerId: i.offerId || undefined,
      quantity: i.quantity,
      // Re-checked against the product when the order is made.
      customizations: snapshotToInput(i.customizations),
      // Checked and priced again from the menu when the order is made.
      options: i.selectedOptions || undefined,
      // A whole combo: the checkout turns it into its components (combos/comboPricing.expandItems).
      comboId: i.comboId || undefined,
      comboSelection: i.comboSelection || undefined,
    })),
  };
}

async function markConverted(workspaceId, cartId, orderId) {
  await db.Cart.update({ status: 'converted' }, { where: { id: cartId, workspaceId } });
}

module.exports = { getOrCreateCart, getCart, addItem, updateItemQuantity, removeItem, toOrderItems, markConverted };
