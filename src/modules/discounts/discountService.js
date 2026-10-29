'use strict';

const db = require('../../db/models');
const { applyBasisPoints } = require('../../core/utils/money');
const { AppError } = require('../../core/errors/AppError');
const rules = require('./discountRules');

/**
 * Validates a discount code against a priced cart and returns the discount
 * amount (in minor units) to apply, WITHOUT redeeming it yet. Redemption
 * (which enforces usage limits atomically) happens in redeem(), called
 * inside the same order-creation transaction so a usage-limit check and the
 * increment that enforces it can never race. `transaction` is that order
 * transaction, so these reads do not need a second pooled connection.
 *
 * `lines` ([{ productId, lineTotalAmount, freeGift? }]) are the priced lines:
 * a code limited to some products or collections takes its percentage (or
 * caps its fixed amount) on those lines only. Without them the whole
 * subtotal is used.
 *
 * `who` ({ phoneNormalized, email, deviceId }) is the shopper, for the
 * coupon's for-whom rules (discountRules.assertCustomer); with neither it nor
 * `customerId` (a preview) those are checked when the order is placed.
 */
async function evaluate(workspaceId, code, { subtotal, productIds, lines = null, customerId, funnelId, who = null, transaction }) {
  if (!code) return { discount: null, amount: 0 };

  const discount = await db.Discount.findOne({ where: { workspaceId, code, status: ['active', 'disabled'] }, transaction });
  if (!discount) throw new AppError('INVALID_DISCOUNT_CODE', 'Discount code is invalid', 422);
  // Paused by the merchant: said as such, not as a wrong code.
  if (discount.status === 'disabled') throw new AppError('DISCOUNT_DISABLED', 'Discount code is paused', 422);

  const now = new Date();
  if (discount.startsAt && discount.startsAt > now) throw new AppError('DISCOUNT_NOT_STARTED', 'Discount code is not yet active', 422);
  if (discount.endsAt && discount.endsAt < now) throw new AppError('DISCOUNT_EXPIRED', 'Discount code has expired', 422);
  if (!rules.scheduleOpen(discount.schedule, now)) {
    throw new AppError('DISCOUNT_NOT_ACTIVE_NOW', 'Discount code does not work at this time', 422, [{ field: 'code', schedule: discount.schedule }]);
  }
  if (discount.minimumSubtotal && subtotal < discount.minimumSubtotal) {
    throw new AppError('DISCOUNT_MINIMUM_NOT_MET', 'Order subtotal does not meet the discount minimum', 422, [
      { field: 'items', minimumAmount: Number(discount.minimumSubtotal), subtotal, remainingAmount: Number(discount.minimumSubtotal) - subtotal },
    ]);
  }
  const eligible = await eligibleProducts(discount, productIds, transaction);
  if (eligible && eligible.size === 0) {
    throw new AppError('DISCOUNT_NOT_APPLICABLE', 'Discount code does not apply to items in this order', 422);
  }
  // Excluded products, offers and sale items left out; the minimum number of pieces.
  rules.assertLines(discount, eligible, lines);
  if (discount.funnelRestrictions.length && (!funnelId || !discount.funnelRestrictions.includes(funnelId))) {
    throw new AppError('DISCOUNT_NOT_APPLICABLE', 'Discount code does not apply to this funnel', 422);
  }
  // A personal code: only the customers it was made for. An unknown shopper
  // (the storefront's preview) is checked when the order is placed.
  if ((discount.customerRestrictions || []).length && customerId && !discount.customerRestrictions.includes(customerId)) {
    throw new AppError('DISCOUNT_NOT_APPLICABLE', 'Discount code does not apply to this customer', 422);
  }
  if (discount.usageLimit !== null && discount.usageCount >= discount.usageLimit) {
    throw new AppError('DISCOUNT_USAGE_LIMIT_REACHED', 'Discount code has reached its usage limit', 422);
  }
  // Phones, VIP tiers, first order / returning customers, and the per-customer limit.
  await rules.assertCustomer(discount, { customerId, ...(who || {}) }, { transaction });

  // A buy-X-get-Y code needs enough covered units in the cart to give one away.
  if (discount.type === 'buy_x_get_y') {
    const offer = buyXGetY(discount, eligible, lines);
    if (!offer) throw new AppError('DISCOUNT_NOT_APPLICABLE', 'Discount code does not apply to items in this order', 422);
    if (offer.amount <= 0) {
      throw new AppError('DISCOUNT_QUANTITY_NOT_MET', 'Add more items to use this discount code', 422, [
        { field: 'items', buyQuantity: offer.buyQuantity, getQuantity: offer.getQuantity, units: offer.units, remainingUnits: Math.max(0, offer.buyQuantity + offer.getQuantity - offer.units) },
      ]);
    }
    return { discount, amount: offer.amount };
  }
  return { discount, amount: amountOn(discount, eligible, lines, subtotal) };
}

/**
 * A buy_x_get_y discount's settings: buy `buyQuantity` units, get
 * `getQuantity` more at `getDiscountBasisPoints` off (10000 = free, the
 * default). null when they are missing or broken.
 */
function buyXGetYConfig(discount) {
  const c = discount.buyXGetYConfig || {};
  const buyQuantity = Number(c.buyQuantity);
  const getQuantity = Number(c.getQuantity);
  const bp = c.getDiscountBasisPoints === undefined || c.getDiscountBasisPoints === null ? 10000 : Number(c.getDiscountBasisPoints);
  if (!Number.isInteger(buyQuantity) || buyQuantity < 1 || !Number.isInteger(getQuantity) || getQuantity < 1) return null;
  if (!Number.isInteger(bp) || bp < 1 || bp > 10000) return null;
  return { buyQuantity, getQuantity, getDiscountBasisPoints: bp };
}

/**
 * What a buy_x_get_y discount takes off the priced lines: the covered units
 * (the code's products or collections, else every line; never a free gift)
 * are counted, every full group of buy + get units gives `getQuantity` units
 * away, and the cheapest units are the ones given, at the price the line is
 * sold at (after any bundle tier). Returns { amount, units, buyQuantity,
 * getQuantity }, or null when the discount's settings are broken.
 */
function buyXGetY(discount, eligible, lines) {
  const config = buyXGetYConfig(discount);
  if (!config) return null;
  const groups = [];
  let units = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    // Product units, not offers: an offer line's quantity is the bundles bought, its shipping rule holds the units
    // they contain (orders/orderService.priceLine; also on lines rebuilt for an edit or an upsell).
    const quantity = Number(line.shippingRule && line.shippingRule.units) || Number(line.quantity);
    const total = Number(line.lineTotalAmount);
    if (!(quantity > 0) || !rules.lineCovered(discount, eligible, line)) continue;
    // The line's total spread over its units in whole minor units.
    const base = Math.floor(total / quantity);
    const extra = total - base * quantity;
    groups.push({ price: base, count: quantity - extra }, { price: base + 1, count: extra });
    units += quantity;
  }
  let free = Math.floor(units / (config.buyQuantity + config.getQuantity)) * config.getQuantity;
  let value = 0;
  for (const group of groups.filter((g) => g.count > 0).sort((a, b) => a.price - b.price)) {
    if (free <= 0) break;
    const take = Math.min(free, group.count);
    value += take * group.price;
    free -= take;
  }
  return { amount: applyBasisPoints(value, config.getDiscountBasisPoints), units, buyQuantity: config.buyQuantity, getQuantity: config.getQuantity };
}

/** What a discount takes off these lines: a buy-X-get-Y one by units, the others on the covered subtotal. */
function amountOn(discount, eligible, lines, subtotal) {
  if (discount.type === 'buy_x_get_y') {
    const offer = buyXGetY(discount, eligible, lines);
    return offer ? offer.amount : 0;
  }
  return amountFor(discount, coveredSubtotal(discount, eligible, lines, subtotal));
}

/**
 * The products of `productIds` a product- or collection-limited discount
 * covers: in its product list, or linked to one of its collections (smart
 * collections keep their links in product_collections too). null when the
 * discount is not limited, so it covers the whole order.
 */
async function eligibleProducts(discount, productIds, transaction) {
  const products = discount.productRestrictions || [];
  const collections = discount.collectionRestrictions || [];
  if (!products.length && !collections.length) return null;
  const eligible = new Set((productIds || []).filter((id) => products.includes(id)));
  const rest = [...new Set(productIds || [])].filter((id) => !eligible.has(id));
  if (collections.length && rest.length) {
    const links = await db.ProductCollection.findAll({
      where: { productId: rest, collectionId: collections },
      attributes: ['productId'],
      raw: true,
      transaction,
    });
    for (const link of links) eligible.add(link.productId);
  }
  return eligible;
}

/** The part of the order a limited discount works on: its covered lines' totals (free gifts never count). */
function eligibleSubtotal(eligible, lines, subtotal) {
  if (!eligible || !Array.isArray(lines)) return subtotal;
  return lines.filter((l) => !l.freeGift && eligible.has(l.productId)).reduce((sum, l) => sum + Number(l.lineTotalAmount), 0);
}

/** eligibleSubtotal with the coupon's own line rules too: excluded products, offers, sale items (discountRules.lineCovered). */
function coveredSubtotal(discount, eligible, lines, subtotal) {
  if (!Array.isArray(lines)) return subtotal;
  return lines.filter((l) => rules.lineCovered(discount, eligible, l)).reduce((sum, l) => sum + Number(l.lineTotalAmount), 0);
}

/**
 * amountFor on priced lines: the whole subtotal, or only the covered lines'
 * for a product- or collection-limited discount. For an order whose lines
 * change after the code was redeemed (items edited, an upsell joined).
 */
async function amountForLines(discount, lines, transaction) {
  const subtotal = lines.reduce((sum, l) => sum + Number(l.lineTotalAmount), 0);
  const eligible = await eligibleProducts(discount, lines.filter((l) => !l.freeGift).map((l) => l.productId), transaction);
  return amountOn(discount, eligible, lines, subtotal);
}

/**
 * What a code takes off `subtotal`. A free_shipping code makes the order ship
 * free (orders/orderService.createOrder) and a buy_x_get_y one is worked out
 * on the lines (buyXGetY / amountOn); this only covers the subtotal-level
 * percentage / fixed cases. Also used when an order's subtotal changes after the code was
 * redeemed (an upsell joined to it), so the same code is not checked again.
 */
function amountFor(discount, subtotal) {
  // A percentage stops at the coupon's cap (maxDiscountAmount), when it has one.
  if (discount.type === 'percentage') return rules.capped(discount, applyBasisPoints(subtotal, discount.value));
  if (discount.type === 'fixed') return Math.min(Number(discount.value), subtotal);
  return 0;
}

/**
 * Redeems a discount inside the caller's transaction: increments usageCount
 * and inserts a DiscountRedemption row, using SELECT ... FOR UPDATE on the
 * discount row so two concurrent checkouts racing for the last remaining
 * use of a limited discount cannot both succeed.
 *
 * `allowOverLimit` is for a prepaid order redeemed only once its payment is
 * confirmed (orders/orderCompletion.js): the code was valid when the shopper
 * placed the order and they were charged the discounted price, so the use is
 * recorded even if the limit ran out while they were paying.
 *
 * The per-customer limit and the first-order / returning rules are checked
 * again here, after the row lock: two orders racing for a customer's last use
 * (or their "first" order) are taken one after the other, and the second sees
 * the first.
 */
async function redeem(discountId, { orderId, customerId, amountAllocated }, transaction, { allowOverLimit = false } = {}) {
  const discount = await db.Discount.findByPk(discountId, { lock: transaction.LOCK.UPDATE, transaction });
  if (!allowOverLimit && discount.usageLimit !== null && discount.usageCount >= discount.usageLimit) {
    throw new AppError('DISCOUNT_USAGE_LIMIT_REACHED', 'Discount code has reached its usage limit', 422);
  }
  if (!allowOverLimit && (discount.perCustomerLimit !== null || discount.audience === 'new' || discount.audience === 'existing')) {
    const order = await db.Order.findByPk(orderId, { attributes: ['id', 'contactSnapshot', 'deviceId'], transaction });
    const contact = (order && order.contactSnapshot) || {};
    await rules.assertCustomer(
      { ...discount.toJSON(), customerPhones: [], vipTierIds: [] },
      { customerId, email: contact.email || null, deviceId: order ? order.deviceId : null },
      { exceptOrderId: orderId, transaction }
    );
  }
  await discount.update({ usageCount: discount.usageCount + 1 }, { transaction });
  await db.DiscountRedemption.create(
    { workspaceId: discount.workspaceId, discountId, orderId, customerId, amountAllocated },
    { transaction }
  );
}

module.exports = { evaluate, redeem, amountFor, amountOn, amountForLines, eligibleProducts, eligibleSubtotal, coveredSubtotal, buyXGetYConfig, buyXGetY };
