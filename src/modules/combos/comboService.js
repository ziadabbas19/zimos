'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { effectiveVariantPrice } = require('../catalog/productPage');
const { toPublicVariant } = require('../storefront/publicProduct');
const pricing = require('./comboPricing');

/*
 * Combos, staff side (products.manage) and what the storefront shows of them.
 *
 * A combo is saved only when it can be sold as described:
 *   - two products at least, every one of this store, each with its variant
 *     or "the shopper picks" (pickVariant), at most MAX_COMPONENTS;
 *   - no product that needs the shopper's input (a required custom field or
 *     menu group): a combo has nowhere to ask for it;
 *   - a fixed price never above what its components cost, an amount off
 *     never their whole price, a percentage at most 100% — against the
 *     cheapest choice of every "shopper picks" component.
 * A component whose product or variant is deleted for good (product_id /
 * variant_id SET NULL) or no longer for sale makes the combo unavailable,
 * never cheaper.
 */

const err = (code, message, details) => new AppError(code, message, 422, details);

async function assertComposition(workspaceId, data, transaction) {
  const items = data.items || [];
  if (items.length > pricing.MAX_COMPONENTS) throw err('VALIDATION_ERROR', `At most ${pricing.MAX_COMPONENTS} products in a combo`);
  if (new Set(items.map((i) => i.productId)).size < 2) {
    throw err('COMBO_NEEDS_TWO_PRODUCTS', 'A combo holds at least two different products', [{ field: 'items' }]);
  }
  let minFull = 0;
  for (const [index, item] of items.entries()) {
    const product = await db.Product.findOne({ where: { id: item.productId, workspaceId }, attributes: ['id', 'name', 'customFields', 'pageSettings'], transaction });
    if (!product) throw err('PRODUCT_NOT_FOUND', 'A product of the combo is not in this store', [{ field: `items[${index}].productId` }]);
    if ((product.customFields || []).some((f) => f && f.required)) {
      throw err('COMBO_PRODUCT_NEEDS_INPUT', `"${product.name}" asks the shopper for details, so it cannot be in a combo`, [{ field: `items[${index}].productId` }]);
    }
    const groups = await db.ProductOptionGroup.count({ where: { workspaceId, productId: product.id, active: true, [Op.or]: [{ required: true }, { minSelect: { [Op.gt]: 0 } }] }, transaction });
    if (groups > 0) {
      throw err('COMBO_PRODUCT_NEEDS_INPUT', `"${product.name}" has options the shopper must pick, so it cannot be in a combo`, [{ field: `items[${index}].productId` }]);
    }
    const where = { workspaceId, productId: product.id, status: 'active', ...(item.pickVariant ? {} : { id: item.variantId || null }) };
    if (!item.pickVariant && !item.variantId) throw err('COMBO_VARIANT_REQUIRED', 'Choose the option, or let the shopper pick it', [{ field: `items[${index}].variantId` }]);
    const variants = await db.ProductVariant.findAll({ where, transaction });
    if (variants.length === 0) throw err('COMBO_VARIANT_REQUIRED', 'This option is not one of the product\'s', [{ field: `items[${index}].variantId` }]);
    const cheapest = Math.min(...variants.map((v) => Number(effectiveVariantPrice(v, product).priceAmount)));
    minFull += cheapest * (item.quantity || 1);
  }
  const value = Number(data.priceValue);
  if (data.pricingMode === 'fixed_price' && value > minFull) {
    throw err('COMBO_PRICE_ABOVE_TOTAL', 'The combo would cost more than its products bought apart', [{ field: 'priceValue', componentsTotal: minFull }]);
  }
  if (data.pricingMode === 'amount_off' && value >= minFull) {
    throw err('COMBO_PRICE_ABOVE_TOTAL', 'The amount off is the whole price of the products', [{ field: 'priceValue', componentsTotal: minFull }]);
  }
  if (data.pricingMode === 'percent_off' && (value < 1 || value > 10000)) {
    throw err('VALIDATION_ERROR', 'A percentage is between 0.01% and 100%', [{ field: 'priceValue' }]);
  }
  return { componentsTotal: minFull, total: pricing.comboUnitTotal(data.pricingMode, value, minFull) };
}

async function replaceItems(comboId, items, transaction) {
  await db.ProductComboItem.destroy({ where: { comboId }, transaction });
  for (const [position, item] of items.entries()) {
    await db.ProductComboItem.create(
      { comboId, productId: item.productId, variantId: item.pickVariant ? null : item.variantId, pickVariant: Boolean(item.pickVariant), quantity: item.quantity || 1, position },
      { transaction }
    );
  }
}

/** A combo as the dashboard shows it: its components, and what it costs at the cheapest choices now. */
async function present(workspaceId, combo) {
  const items = [];
  let full = 0;
  let available = true;
  for (const item of combo.items || []) {
    const variants = item.productId
      ? await db.ProductVariant.findAll({ where: { workspaceId, productId: item.productId, status: 'active', ...(item.pickVariant ? {} : { id: item.variantId || null }) } })
      : [];
    if (!item.product || item.product.status !== 'active' || variants.length === 0) available = false;
    const prices = variants.map((v) => Number(effectiveVariantPrice(v, item.product || {}).priceAmount));
    if (prices.length) full += Math.min(...prices) * item.quantity;
    items.push({
      id: item.id,
      productId: item.productId,
      productName: item.product ? item.product.name : null,
      productStatus: item.product ? item.product.status : null,
      variantId: item.variantId,
      variantOptions: !item.pickVariant && variants[0] ? variants[0].optionValues : null,
      pickVariant: item.pickVariant,
      quantity: item.quantity,
    });
  }
  return {
    id: combo.id,
    name: combo.name,
    description: combo.description,
    imageUrl: combo.imageUrl,
    status: combo.status,
    pricingMode: combo.pricingMode,
    priceValue: Number(combo.priceValue),
    showOnProductIds: combo.showOnProductIds || [],
    items,
    // At the cheapest choice of every component the shopper picks.
    price: { full, total: pricing.comboUnitTotal(combo.pricingMode, combo.priceValue, full) },
    available,
    createdAt: combo.createdAt,
    updatedAt: combo.updatedAt,
  };
}

async function list(workspaceId, { status } = {}) {
  const combos = await db.ProductCombo.findAll({
    where: { workspaceId, ...(status ? { status } : { status: { [Op.ne]: 'archived' } }) },
    include: [{ model: db.ProductComboItem, as: 'items', include: [{ model: db.Product, as: 'product', attributes: ['id', 'name', 'status'] }] }],
    order: [
      ['position', 'ASC'],
      ['createdAt', 'DESC'],
      [{ model: db.ProductComboItem, as: 'items' }, 'position', 'ASC'],
    ],
  });
  const out = [];
  for (const combo of combos) out.push(await present(workspaceId, combo));
  return out;
}

async function get(workspaceId, comboId) {
  const combo = await pricing.loadCombo(workspaceId, comboId);
  if (!combo) throw new NotFoundError('Combo');
  return present(workspaceId, combo);
}

async function create(workspaceId, data, req) {
  return db.sequelize.transaction(async (transaction) => {
    await assertComposition(workspaceId, data, transaction);
    const { items, ...fields } = data;
    const combo = await db.ProductCombo.create({ ...fields, workspaceId, imageUrl: fields.imageUrl || null, description: fields.description || null }, { transaction });
    await replaceItems(combo.id, items, transaction);
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'combo.create', entityType: 'ProductCombo', entityId: combo.id, after: data, req, transaction });
    return combo.id;
  }).then((id) => get(workspaceId, id));
}

async function update(workspaceId, comboId, data, req) {
  return db.sequelize.transaction(async (transaction) => {
    const combo = await pricing.loadCombo(workspaceId, comboId, transaction);
    if (!combo) throw new NotFoundError('Combo');
    const before = await present(workspaceId, combo);
    const next = {
      pricingMode: data.pricingMode || combo.pricingMode,
      priceValue: data.priceValue !== undefined ? data.priceValue : Number(combo.priceValue),
      items: data.items || combo.items.map((i) => ({ productId: i.productId, variantId: i.variantId, pickVariant: i.pickVariant, quantity: i.quantity })),
    };
    // A combo already being sold is checked again whole; an archived one may keep its broken parts.
    if ((data.status || combo.status) !== 'archived') await assertComposition(workspaceId, next, transaction);
    const { items, ...fields } = data;
    await combo.update(fields, { transaction });
    if (items) await replaceItems(combo.id, items, transaction);
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'combo.update', entityType: 'ProductCombo', entityId: combo.id, before, after: data, req, transaction });
    return combo.id;
  }).then((id) => get(workspaceId, id));
}

/** Archived, never deleted: orders keep its name on their lines, and a cart line naming it stops selling. */
async function archive(workspaceId, comboId, req) {
  const combo = await db.ProductCombo.findOne({ where: { id: comboId, workspaceId } });
  if (!combo) throw new NotFoundError('Combo');
  await combo.update({ status: 'archived' });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'combo.archive', entityType: 'ProductCombo', entityId: combo.id, after: { status: 'archived' }, req });
  return { archived: true, id: combo.id };
}

/** The form's live price: what these components cost and what the combo would. */
async function preview(workspaceId, data) {
  return assertComposition(workspaceId, data);
}

// ----------------------------------------------------------------- public --

/**
 * The active combos a product's page shows (those listing it, or holding it
 * when they list no page): each component with its product, the variant or
 * the variants the shopper picks from, the combo's price at the first
 * in-stock choice, and whether it can be bought at all.
 */
async function forProduct(workspaceId, productId) {
  const env = require('../../config/env');
  if (!env.combos.enabled) return [];
  if (await require('../billing/growthFeatures').locked(workspaceId, 'combos')) return [];
  const candidates = await db.ProductCombo.findAll({
    where: {
      workspaceId,
      status: 'active',
      [Op.or]: [
        { showOnProductIds: { [Op.contains]: [productId] } },
        db.sequelize.literal(`(cardinality("ProductCombo"."show_on_product_ids") = 0 AND EXISTS (SELECT 1 FROM product_combo_items ci WHERE ci.combo_id = "ProductCombo"."id" AND ci.product_id = ${db.sequelize.escape(productId)}))`),
      ],
    },
    include: [
      {
        model: db.ProductComboItem,
        as: 'items',
        include: [{ model: db.Product, as: 'product', attributes: ['id', 'name', 'slug', 'status', 'media', 'pageSettings'] }],
      },
    ],
    order: [
      ['position', 'ASC'],
      ['createdAt', 'ASC'],
      [{ model: db.ProductComboItem, as: 'items' }, 'position', 'ASC'],
    ],
  });
  const out = [];
  for (const combo of candidates) {
    let available = true;
    let full = 0;
    const items = [];
    for (const item of combo.items) {
      const variants = item.productId
        ? await db.ProductVariant.findAll({ where: { workspaceId, productId: item.productId, status: 'active', ...(item.pickVariant ? {} : { id: item.variantId || null }) }, order: [['createdAt', 'ASC']] })
        : [];
      const shown = variants.map((v) => toPublicVariant(v, item.product));
      const first = shown.find((v) => v.inStock) || null;
      if (!item.product || item.product.status !== 'active' || !first) available = false;
      if (first) full += Number(first.priceAmount) * item.quantity;
      const media = item.product && Array.isArray(item.product.media) ? item.product.media : [];
      items.push({
        id: item.id,
        quantity: item.quantity,
        pickVariant: item.pickVariant,
        product: item.product ? { id: item.product.id, name: item.product.name, slug: item.product.slug, imageUrl: (media[0] && (media[0].url || media[0].src)) || null } : null,
        variants: shown,
      });
    }
    out.push({
      id: combo.id,
      name: combo.name,
      description: combo.description,
      imageUrl: combo.imageUrl,
      pricingMode: combo.pricingMode,
      priceValue: Number(combo.priceValue),
      items,
      // At the first in-stock choice of every component; the order prices it again.
      price: { full, total: pricing.comboUnitTotal(combo.pricingMode, combo.priceValue, full), saving: full - pricing.comboUnitTotal(combo.pricingMode, combo.priceValue, full) },
      available,
    });
  }
  return out;
}

/**
 * A cart line for a combo: the combo resolved for its selection, priced now.
 * { unitPrice, combo: { id, name, items[] }, unavailable }.
 */
async function cartLine(workspaceId, comboId, selection) {
  try {
    const combo = await pricing.activeCombo(workspaceId, comboId);
    const components = await pricing.resolveComponents(workspaceId, combo, selection);
    const price = pricing.priceComponents(combo, components);
    return {
      unitPrice: price.total,
      fullUnitPrice: price.full,
      combo: {
        id: combo.id,
        name: combo.name,
        items: components.map(({ item, variant }) => ({ itemId: item.id, productId: item.productId, productName: item.product.name, variantId: variant.id, optionValues: variant.optionValues, quantity: item.quantity })),
      },
      firstVariantId: components[0].variant.id,
      unavailable: false,
    };
  } catch (e) {
    if (e instanceof AppError && (e.statusCode === 404 || e.statusCode === 422)) return { unavailable: true, reason: e.code };
    throw e;
  }
}

module.exports = { assertComposition, list, get, create, update, archive, preview, forProduct, cartLine, present };
