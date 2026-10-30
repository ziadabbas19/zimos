'use strict';

const db = require('../../db/models');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { add } = require('../../core/utils/money');
const inventoryService = require('../inventory/inventoryService');
const discountService = require('../discounts/discountService');
const { calculateShippingAmount } = require('../shipping/shippingPricing');
const { calculateTax, taxableLines } = require('../tax/taxService');
const { recordAudit } = require('../audit/auditService');
const { assertNotShipped } = require('./shipmentLifecycle');
const { applyBundleTiers } = require('../bundles/bundlePricing');
const orderService = require('./orderService');

/**
 * Editing an order's items before it ships (SPEC §4.4 "Editing"): add
 * products, change quantities, remove lines — with the price difference
 * shown before anything is saved.
 *
 * The request is the whole new list of lines. A line the order already has
 * (same variant and offer) keeps the price it was sold at, whatever the
 * catalogue says today; a new line is priced from the catalogue like any
 * order line. The order is then priced again as createOrder would price it:
 * the discount code on the new subtotal, shipping (weight, free-shipping
 * threshold), tax, total. Stock follows in the same transaction — more is
 * reserved, less is released — and the invoice is brought to the new total.
 *
 * The preview is the same code run in a transaction that is rolled back, so
 * it cannot disagree with the save and it reports the same errors (out of
 * stock, a product no longer for sale).
 *
 * Refused on a cancelled order, once the parcel has left, and once money has
 * been received: a paid order is corrected with a refund, not by editing it.
 */

const keyOf = (line) => `${line.variantId}|${line.offerId || ''}`;

const totalsOf = (order) => ({
  subtotalAmount: String(order.subtotalAmount),
  discountAmount: String(order.discountAmount),
  shippingAmount: String(order.shippingAmount),
  taxAmount: String(order.taxAmount),
  totalAmount: String(order.totalAmount),
});

/** What a line holds in stock: its offer's lines × quantity, or its variant × quantity. */
async function consumedBy(workspaceId, line, transaction) {
  if (!line.variantId) return [];
  const facts = await orderService
    .priceLine(workspaceId, { variantId: line.variantId, offerId: line.offerId, quantity: line.quantity }, transaction, { forSale: false })
    .catch(() => null);
  return facts ? facts.consumedInventory : [{ variantId: line.variantId, quantity: line.quantity }];
}

async function apply(workspaceId, orderId, requested, req, transaction) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!order) throw new NotFoundError('Order');
  if (order.cancelledAt || order.confirmationState === 'rejected') {
    throw new AppError('ORDER_CANCELLED', 'This order is cancelled', 409);
  }
  await assertNotShipped(order, transaction);
  // A courier booking collects the amount it was given: cancel it before the items change.
  await require('../shipping/carrierShipmentService').assertNoCarrierBooking(order.id, transaction);
  if (Number(order.amountPaid) > 0) {
    throw new AppError('ORDER_ALREADY_PAID', 'This order has been paid; correct it with a refund instead of editing its items', 409);
  }

  const seen = new Set();
  for (const line of requested) {
    if (seen.has(keyOf(line))) {
      throw new ValidationError([{ field: 'items', message: 'The same product and offer appears twice; change its quantity instead' }]);
    }
    seen.add(keyOf(line));
  }

  const existing = await db.OrderItem.findAll({ where: { orderId: order.id }, order: [['createdAt', 'ASC'], ['id', 'ASC']], transaction });
  // A combo's lines share its price; editing them one by one would break it (modules/combos).
  if (existing.some((item) => item.comboKey)) {
    throw new AppError('ORDER_HAS_COMBO', "An order with a combo cannot have its items edited; cancel it and place it again", 409);
  }
  const before = totalsOf(order);
  const beforeItems = existing.map((i) => ({ name: i.productNameSnapshot, quantity: i.quantity }));
  const existingByKey = new Map();
  for (const item of existing) if (!existingByKey.has(keyOf(item))) existingByKey.set(keyOf(item), item);

  // ---- stock: what the order held, what it will hold
  const held = new Map();
  for (const item of existing) {
    for (const c of await consumedBy(workspaceId, item, transaction)) held.set(c.variantId, (held.get(c.variantId) || 0) + c.quantity);
  }

  // ---- the new lines
  const lines = [];
  for (const wanted of requested) {
    const kept = existingByKey.get(keyOf(wanted));
    if (kept) {
      const facts = await orderService
        .priceLine(workspaceId, wanted, transaction, { forSale: false })
        .catch(() => null);
      lines.push({
        kept,
        productId: kept.productId,
        // What decides whether a bundle tier covers the line (bundlePricing.applyBundleTiers).
        offerId: kept.offerId,
        isOrderBump: kept.isOrderBump,
        isUpsell: kept.isUpsell,
        // A free gift never unlocks a tier: a labelled plain line at 0.
        freeGift: !kept.offerId && Number(kept.unitPriceAmount) === 0 && Boolean(kept.offerNameSnapshot),
        quantity: wanted.quantity,
        unitPriceAmount: Number(kept.unitPriceAmount),
        // Full price here; the bundle tiers below take their saving off again, unless the product
        // is untouched (below).
        lineTotalAmount: Number(kept.unitPriceAmount) * wanted.quantity,
        lineDiscountAmount: 0,
        consumedInventory: facts ? facts.consumedInventory : [{ variantId: kept.variantId, quantity: wanted.quantity }],
        shippingOverride: facts ? facts.shippingOverride : null,
        weightUnits: facts
          ? facts.weightUnits
          : [{ weightGrams: kept.unitWeightGrams === null ? null : Number(kept.unitWeightGrams), quantity: 1, weightless: false }],
        shippingRule: facts ? facts.shippingRule : { mode: undefined, extraAmount: undefined, units: wanted.quantity },
      });
    } else {
      const priced = await orderService.priceLine(workspaceId, wanted, transaction);
      lines.push({ ...priced, kept: null, lineTotalAmount: Number(priced.lineTotalAmount) });
    }
  }

  // ---- which products the edit touches: a line added, removed or with a new quantity. Lines of any other
  // product keep their stored price and bundle saving as sold, even if the bundle has changed or ended since;
  // a bundle entry of the order is priced again only when one of its products is touched.
  const touched = new Set();
  for (const line of lines) if (!line.kept || line.kept.quantity !== line.quantity) touched.add(line.productId);
  const keptItemIds = new Set(lines.filter((l) => l.kept).map((l) => l.kept.id));
  for (const item of existing) if (!keptItemIds.has(item.id)) touched.add(item.productId);
  const oldBundles = (order.discountsSnapshot || []).filter((d) => d && d.kind === 'bundle');
  const productsOf = (entry) => (Array.isArray(entry.productIds) ? entry.productIds : [entry.productId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const entry of oldBundles) {
      if (productsOf(entry).some((id) => touched.has(id)) && !productsOf(entry).every((id) => touched.has(id))) {
        for (const id of productsOf(entry)) touched.add(id);
        grew = true;
      }
    }
  }
  for (const line of lines) {
    if (!line.kept || touched.has(line.productId)) continue;
    line.frozen = true;
    line.lineTotalAmount = Number(line.kept.lineTotalAmount);
    line.lineDiscountAmount = Number(line.kept.lineDiscountAmount) || 0;
  }

  const wantedStock = new Map();
  for (const line of lines) {
    for (const c of line.consumedInventory) wantedStock.set(c.variantId, (wantedStock.get(c.variantId) || 0) + c.quantity);
  }
  const variantIds = [...new Set([...held.keys(), ...wantedStock.keys()])].sort();
  const actorUserId = req.user.id;
  for (const variantId of variantIds) {
    const delta = (wantedStock.get(variantId) || 0) - (held.get(variantId) || 0);
    const movement = { workspaceId, variantId, quantity: Math.abs(delta), referenceType: 'order_edited', referenceId: order.id, actorUserId };
    if (delta > 0) await inventoryService.reserve(movement, transaction);
    else if (delta < 0) await inventoryService.release(movement, transaction);
  }

  // ---- price the order again
  // Quantity bundles priced again on the new quantities, as createOrder prices them.
  const bundleSnapshots = await applyBundleTiers(workspaceId, lines.filter((l) => !l.frozen), transaction);
  // The bundle entries of untouched products stay as sold, free shipping included.
  const keptBundles = oldBundles.filter((entry) => !productsOf(entry).some((id) => touched.has(id)));
  for (const entry of keptBundles) {
    if (entry.freeShipping !== true) continue;
    for (const line of lines) {
      if (line.frozen && line.shippingRule && productsOf(entry).includes(line.productId)) line.shippingRule = { ...line.shippingRule, mode: 'free', extraAmount: null };
    }
  }
  // Free shipping the order was given when placed (a free-shipping code) still holds for every line.
  if ((order.shippingSnapshot || {}).freeShippingGranted === true) {
    for (const line of lines) if (line.shippingRule) line.shippingRule = { ...line.shippingRule, mode: 'free', extraAmount: null };
  }
  const subtotal = add(...lines.map((l) => l.lineTotalAmount));
  const totalQuantity = lines.reduce((sum, l) => sum + l.quantity, 0);
  // A free-shipping code beats an offer's own shipping price.
  const offerShippingOverride = orderService.couponShipsFree(order) ? null : lines.find((l) => l.shippingOverride)?.shippingOverride || null;

  let discountAmount = Number(order.discountAmount);
  let discountsSnapshot = [...keptBundles, ...bundleSnapshots, ...(order.discountsSnapshot || []).filter((d) => !d || d.kind !== 'bundle')];
  let placed = null;
  const redemption = await db.DiscountRedemption.findOne({ where: { orderId: order.id }, transaction });
  const discountRules = require('../discounts/discountRules');
  if (redemption) {
    // The code as the order was placed with it (its snapshot's rules), not as it stands now.
    const discount = discountRules.asPlaced(await db.Discount.findByPk(redemption.discountId, { transaction }), discountsSnapshot);
    placed = discount;
    if (discount) {
      // A product- or collection-limited code still covers only its lines.
      discountAmount = await discountService.amountForLines(discount, lines, transaction);
      discountsSnapshot = discountsSnapshot.map((d) => (d.code === discount.code ? { ...d, amount: discountAmount } : d));
    }
  } else {
    placed = await orderService.placedDiscount(order, transaction);
  }
  discountAmount = Math.min(discountAmount, subtotal);

  const address = order.shippingAddressSnapshot || null;
  // Shipping the merchant typed in by hand stays as typed.
  const manualShipping = order.shippingSnapshot && order.shippingSnapshot.rule === 'offer_override' && !offerShippingOverride;
  const shipping = await calculateShippingAmount(workspaceId, {
    country: address ? address.country : null,
    region: address ? address.province : null,
    subtotal,
    totalQuantity,
    offerShippingOverride: manualShipping ? { amount: Number(order.shippingAmount) } : offerShippingOverride,
    weightLines: lines.map((l) => ({ quantity: l.quantity, units: l.weightUnits })),
    productLines: lines.map((l) => l.shippingRule),
    transaction,
  });
  // The shipping option the shopper picked, at its price for the new order; standard when the store no
  // longer offers it. Shipping typed in by hand stays as typed.
  const keptShipping = order.shippingSnapshot || {};
  const option = !manualShipping && keptShipping.option && keptShipping.option.key
    ? await require('../shipping/shippingOptions').choose(workspaceId, keptShipping.option.key, shipping, transaction).catch(() => null)
    : null;
  const shippingAmount = option ? option.amount : shipping.amount;
  const { taxAmount } = await calculateTax(workspaceId, {
    country: address ? address.country : null,
    region: address ? address.province : null,
    // Taxed on what the shopper pays: the order's discount comes off first.
    lines: await taxableLines(lines, discountAmount, placed, transaction),
    shippingAmount,
    transaction,
  });
  // The delivery-fee part of the order's coupon stays what it was (never above the new fee).
  if (redemption && placed) {
    discountAmount += discountRules.placedShippingPart(discountsSnapshot, shippingAmount);
    await redemption.update({ amountAllocated: discountAmount }, { transaction });
  }
  const totalAmount = subtotal - discountAmount + shippingAmount + taxAmount;

  // ---- write the lines
  const keptIds = new Set(lines.filter((l) => l.kept).map((l) => l.kept.id));
  for (const item of existing) {
    if (keptIds.has(item.id)) continue;
    await db.CustomerUpload.update({ orderItemId: null }, { where: { orderItemId: item.id }, transaction });
    await item.destroy({ transaction });
  }
  const items = [];
  for (const [index, line] of lines.entries()) {
    if (line.kept) {
      await line.kept.update(
        { quantity: line.quantity, lineDiscountAmount: line.lineDiscountAmount || 0, lineTotalAmount: line.lineTotalAmount, unitWeightGrams: shipping.lineWeights[index] },
        { transaction }
      );
      items.push(line.kept);
    } else {
      items.push(
        await db.OrderItem.create(
          {
            orderId: order.id,
            productId: line.productId,
            variantId: line.variantId,
            offerId: line.offerId,
            productNameSnapshot: line.productName,
            variantOptionsSnapshot: line.variantOptions,
            skuSnapshot: line.sku,
            offerNameSnapshot: line.offerName,
            quantity: line.quantity,
            unitPriceAmount: line.unitPriceAmount,
            unitCostAmount: line.unitCostAmount,
            lineDiscountAmount: line.lineDiscountAmount || 0,
            lineTotalAmount: line.lineTotalAmount,
            unitWeightGrams: shipping.lineWeights[index],
          },
          { transaction }
        )
      );
    }
  }

  await order.update(
    {
      subtotalAmount: subtotal,
      discountAmount,
      discountsSnapshot,
      shippingAmount,
      taxAmount,
      totalAmount,
      totalWeightGrams: shipping.weightGrams,
      weightTierSnapshot: shipping.tier,
      weightEstimated: shipping.weightEstimated,
      // Only the option is re-priced; the zone, pickup and granted free shipping stay.
      ...(keptShipping.option ? { shippingSnapshot: { ...keptShipping, option: option ? option.snapshot : undefined } } : {}),
    },
    { transaction }
  );

  const invoice = await db.Invoice.findOne({ where: { orderId: order.id }, order: [['issuedAt', 'DESC']], transaction });
  if (invoice) {
    await invoice.update(
      {
        totalAmount,
        lineItems: items.map((i) => ({
          name: i.productNameSnapshot,
          quantity: i.quantity,
          unitPriceAmount: i.unitPriceAmount,
          lineTotalAmount: i.lineTotalAmount,
        })),
      },
      { transaction }
    );
  }

  const after = totalsOf(order);
  await recordAudit({
    workspaceId,
    actorUserId,
    action: 'order.items_update',
    entityType: 'Order',
    entityId: order.id,
    before: { ...before, items: beforeItems },
    after: { ...after, items: items.map((i) => ({ name: i.productNameSnapshot, quantity: i.quantity })) },
    req,
    transaction,
  });

  return {
    currency: order.currency,
    before,
    after,
    differenceAmount: String(Number(after.totalAmount) - Number(before.totalAmount)),
    items: items.map((i) => ({
      id: i.id,
      variantId: i.variantId,
      offerId: i.offerId,
      name: i.productNameSnapshot,
      options: i.variantOptionsSnapshot,
      offerName: i.offerNameSnapshot,
      quantity: i.quantity,
      unitPriceAmount: String(i.unitPriceAmount),
      lineTotalAmount: String(i.lineTotalAmount),
    })),
  };
}

class PreviewDone extends Error {
  constructor(result) {
    super('preview');
    this.result = result;
  }
}

/** POST /orders/:id/items/preview — what saving would do, saved nowhere. */
async function previewItems(workspaceId, orderId, { items }, req) {
  try {
    await db.sequelize.transaction(async (transaction) => {
      throw new PreviewDone(await apply(workspaceId, orderId, items, req, transaction));
    });
  } catch (err) {
    if (err instanceof PreviewDone) return err.result;
    throw err;
  }
  throw new Error('unreachable');
}

/** PUT /orders/:id/items */
async function updateItems(workspaceId, orderId, { items }, req) {
  await db.sequelize.transaction((transaction) => apply(workspaceId, orderId, items, req, transaction));
  return orderService.getOrder(workspaceId, orderId);
}

/**
 * POST /orders/:id/refund-quote — the amount a refund of these lines comes
 * to: each line's price for the units returned, less its share of the
 * order's discount. Shipping is not included. The merchant may still change
 * the amount before refunding (POST /orders/:id/refunds does the refund).
 */
async function refundQuote(workspaceId, orderId, { lines }) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, include: [{ model: db.OrderItem, as: 'items' }] });
  if (!order) throw new NotFoundError('Order');
  const byId = new Map(order.items.map((i) => [i.id, i]));
  const subtotal = Number(order.subtotalAmount);
  const discount = Number(order.discountAmount);
  let amount = 0;
  const out = [];
  for (const line of lines) {
    const item = byId.get(line.orderItemId);
    if (!item) throw new ValidationError([{ field: 'lines.orderItemId', message: 'Order item is not on this order' }]);
    if (line.quantity > item.quantity) {
      throw new ValidationError([{ field: 'lines.quantity', message: `At most ${item.quantity} can be refunded for this line` }]);
    }
    const gross = Number(item.unitPriceAmount) * line.quantity;
    const share = subtotal > 0 ? Math.round((discount * gross) / subtotal) : 0;
    amount += gross - share;
    out.push({ orderItemId: item.id, name: item.productNameSnapshot, quantity: line.quantity, amount: String(gross - share) });
  }
  const refundable = Math.max(0, Number(order.amountPaid) - Number(order.amountRefunded));
  return { currency: order.currency, amount: String(amount), refundableAmount: String(refundable), lines: out };
}

module.exports = { previewItems, updateItems, refundQuote };
