'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { zonedParts } = require('../../core/utils/zonedMonth');

/*
 * The merchant's controls on a coupon (migration 730), checked by
 * discountService.evaluate / redeem and couponExtras' automatic discounts.
 * Every default is the old behaviour, so a coupon that sets none of them
 * passes every check here unchanged.
 *
 *   when      schedule: days of the week and a time window, Cairo time
 *   on what   excludedProductIds; appliesToDiscounted (lines already below
 *             their list price: a sale price or a quantity bundle);
 *             combinesWithOffers (offer, order bump and upsell lines);
 *             minQuantity of the covered pieces
 *   for whom  audience any | new | existing; customerPhones; vipTierIds
 *   how much  maxDiscountAmount caps a percentage; appliesToShipping adds the
 *             delivery fee
 *   how often strictCustomerLimit: per_customer_limit also counts the e-mail
 *             and the device of the customer's earlier orders with the code
 *
 * "New customer" = no earlier order of the store under their phone (their
 * customer row) that was not cancelled or rejected; with strictCustomerLimit
 * their device's earlier orders count too. A test order never counts.
 *
 * Every refusal carries its own code, so the shopper is told why.
 */

const TIME_ZONE = 'Africa/Cairo';

const refuse = (code, message, details) => new AppError(code, message, 422, details);

/** Day of week (0 = Sunday) and minutes since midnight in Cairo. */
function cairoClock(now) {
  const p = zonedParts(now, TIME_ZONE);
  return { weekday: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(), minutes: p.hour * 60 + p.minute };
}

/**
 * Whether the weekly schedule has the coupon on at `now`. No schedule = always.
 * A window whose end is before its start runs past midnight (22:00-02:00), and
 * belongs to the day it starts on.
 */
function scheduleOpen(schedule, now = new Date()) {
  if (!schedule || typeof schedule !== 'object') return true;
  const days = Array.isArray(schedule.days) && schedule.days.length ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  const start = Number.isInteger(schedule.startMinute) ? schedule.startMinute : 0;
  const end = Number.isInteger(schedule.endMinute) ? schedule.endMinute : 24 * 60;
  const { weekday, minutes } = cairoClock(now);
  if (start <= end) return days.includes(weekday) && minutes >= start && minutes < end;
  const yesterday = (weekday + 6) % 7;
  return (days.includes(weekday) && minutes >= start) || (days.includes(yesterday) && minutes < end);
}

/** A line sold below its list price already: a sale price, or a quantity bundle's tier. */
const alreadyDiscounted = (line) => Boolean(line.onSale) || Number(line.lineDiscountAmount) > 0;
/** A line that is an offer: a pack or bundle offer, an order bump, an upsell. */
const isOfferLine = (line) => Boolean(line.offerId || line.isOrderBump || line.isUpsell);

/**
 * Whether one priced line is covered by the coupon: never a free gift; in its
 * products/collections (`eligible`, null = all); not excluded; and not an
 * offer or an already-discounted line when the coupon leaves those out.
 */
function lineCovered(discount, eligible, line) {
  if (!line || line.freeGift) return false;
  if (eligible && !eligible.has(line.productId)) return false;
  if ((discount.excludedProductIds || []).includes(line.productId)) return false;
  if (discount.combinesWithOffers === false && isOfferLine(line)) return false;
  if (discount.appliesToDiscounted === false && alreadyDiscounted(line)) return false;
  return true;
}

/** Pieces of a line: an offer line's quantity is the packs bought; its shipping rule holds the pieces. */
const piecesOf = (line) => Number(line.shippingRule && line.shippingRule.units) || Number(line.quantity) || 0;

/**
 * The lines-based checks of evaluate(): something left to discount once the
 * offer / sale / excluded lines are out, and the minimum number of pieces.
 * `lines` null (a caller with no priced lines) skips them.
 */
function assertLines(discount, eligible, lines) {
  if (!Array.isArray(lines)) return;
  const covered = lines.filter((line) => lineCovered(discount, eligible, line));
  if (covered.length === 0) {
    const excluded = discount.excludedProductIds || [];
    const leftOut = lines.some((line) => !line.freeGift && (!eligible || eligible.has(line.productId)) && !excluded.includes(line.productId));
    // Its products are there, but only as offers or sale items: say that, not "not for these items".
    if (leftOut) throw refuse('DISCOUNT_NOT_COMBINABLE', 'Discount code does not apply to offers or items already on sale in this order');
    throw refuse('DISCOUNT_NOT_APPLICABLE', 'Discount code does not apply to items in this order');
  }
  if (discount.minQuantity) {
    const pieces = covered.reduce((sum, line) => sum + piecesOf(line), 0);
    if (pieces < discount.minQuantity) {
      throw refuse('DISCOUNT_MIN_QUANTITY_NOT_MET', 'Add more items to use this discount code', [
        { field: 'items', minQuantity: discount.minQuantity, quantity: pieces, remainingQuantity: discount.minQuantity - pieces },
      ]);
    }
  }
}

/** A percentage coupon's cap. */
function capped(discount, amount) {
  const max = discount.maxDiscountAmount === null || discount.maxDiscountAmount === undefined ? null : Number(discount.maxDiscountAmount);
  return max !== null && discount.type === 'percentage' ? Math.min(amount, max) : amount;
}

/**
 * What the coupon takes off the delivery fee when it applies to shipping too:
 * a percentage takes its share of the fee (within what its cap leaves), a
 * fixed amount what the items did not use. 0 for any other coupon.
 */
function shippingPart(discount, itemsAmount, shippingAmount) {
  const fee = Math.max(0, Number(shippingAmount) || 0);
  if (!discount || !discount.appliesToShipping || fee === 0) return 0;
  if (discount.type === 'percentage') {
    const share = Math.round((fee * Number(discount.value || 0)) / 10000);
    const max = discount.maxDiscountAmount === null || discount.maxDiscountAmount === undefined ? null : Number(discount.maxDiscountAmount);
    return Math.max(0, Math.min(fee, share, max === null ? share : max - itemsAmount));
  }
  if (discount.type === 'fixed') return Math.max(0, Math.min(fee, Number(discount.value || 0) - itemsAmount));
  return 0;
}

/** The customer's earlier orders that make them "existing": not cancelled, not rejected, not a test. */
async function hasEarlierOrder(workspaceId, { customerId, deviceId, strict }, exceptOrderId, transaction) {
  if (!customerId && !(strict && deviceId)) return false;
  const [row] = await db.sequelize.query(
    `SELECT 1 AS found FROM orders o
      WHERE o.workspace_id = :workspaceId AND o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected' AND o.is_test = false
        AND (${exceptOrderId ? 'o.id <> :exceptOrderId AND ' : ''}(o.customer_id = :customerId ${strict && deviceId ? 'OR o.device_id = :deviceId' : ''}))
      LIMIT 1`,
    { replacements: { workspaceId, customerId: customerId || null, deviceId: deviceId || null, exceptOrderId: exceptOrderId || null }, type: QueryTypes.SELECT, transaction }
  );
  return Boolean(row);
}

/** Uses of the coupon by this customer (with strictCustomerLimit: by their e-mail or device too), other than `exceptOrderId`. */
async function usesBy(discount, { customerId, email, deviceId }, exceptOrderId, transaction) {
  const strict = discount.strictCustomerLimit === true;
  const emailKey = strict && email ? String(email).trim().toLowerCase() : null;
  const device = strict && deviceId ? String(deviceId) : null;
  if (!customerId && !emailKey && !device) return 0;
  const [row] = await db.sequelize.query(
    `SELECT COUNT(*)::int AS n FROM discount_redemptions dr
       ${emailKey || device ? 'LEFT JOIN orders o ON o.id = dr.order_id' : ''}
      WHERE dr.discount_id = :discountId ${exceptOrderId ? 'AND dr.order_id <> :exceptOrderId' : ''}
        AND (dr.customer_id = :customerId
             ${emailKey ? "OR lower(o.contact_snapshot ->> 'email') = :emailKey" : ''}
             ${device ? 'OR o.device_id = :device' : ''})`,
    { replacements: { discountId: discount.id, customerId: customerId || null, emailKey, device, exceptOrderId: exceptOrderId || null }, type: QueryTypes.SELECT, transaction }
  );
  return row.n;
}

/**
 * The for-whom checks. `who` = { customerId, phoneNormalized, email, deviceId };
 * an unknown shopper (a preview without a phone) is checked when the order is
 * placed. `exceptOrderId`: the order being redeemed, inside its own transaction.
 */
async function assertCustomer(discount, who, { exceptOrderId = null, transaction } = {}) {
  const { customerId = null, phoneNormalized = null, email = null, deviceId = null } = who || {};
  if (!customerId && !phoneNormalized) return;
  const phones = discount.customerPhones || [];
  if (phones.length && !phones.includes(phoneNormalized)) {
    throw refuse('DISCOUNT_NOT_ELIGIBLE', 'Discount code is not available to this customer');
  }
  if ((discount.vipTierIds || []).length) {
    const workspace = await db.Workspace.findByPk(discount.workspaceId, { attributes: ['id', 'settings'], transaction });
    const { tier } = await require('../vipTiers').tierOf(workspace, customerId);
    if (!tier || !discount.vipTierIds.includes(String(tier.id))) {
      throw refuse('DISCOUNT_NOT_ELIGIBLE', 'Discount code is not available to this customer');
    }
  }
  if (discount.audience === 'new' || discount.audience === 'existing') {
    const earlier = await hasEarlierOrder(discount.workspaceId, { customerId, deviceId, strict: discount.strictCustomerLimit === true }, exceptOrderId, transaction);
    if (discount.audience === 'new' && earlier) throw refuse('DISCOUNT_FIRST_ORDER_ONLY', 'Discount code is for a first order only');
    if (discount.audience === 'existing' && !earlier) throw refuse('DISCOUNT_RETURNING_ONLY', 'Discount code is for returning customers only');
  }
  if (discount.perCustomerLimit !== null && discount.perCustomerLimit !== undefined) {
    const used = await usesBy(discount, { customerId, email, deviceId }, exceptOrderId, transaction);
    if (used >= discount.perCustomerLimit) {
      throw refuse('DISCOUNT_PER_CUSTOMER_LIMIT_REACHED', 'You have already used this discount code');
    }
  }
}

// What an order keeps of its coupon's rules, so a later change to the coupon
// never reprices it (an upsell joining it, its items edited).
const FROZEN = [
  'type',
  'value',
  'buyXGetYConfig',
  'productRestrictions',
  'collectionRestrictions',
  'excludedProductIds',
  'maxDiscountAmount',
  'appliesToShipping',
  'appliesToDiscounted',
  'combinesWithOffers',
];

// BIGINT columns come back from the database as strings; the snapshot keeps numbers.
const NUMERIC = new Set(['value', 'maxDiscountAmount']);

function frozenRules(discount) {
  const out = {};
  for (const key of FROZEN) {
    const value = discount[key];
    out[key] = value === undefined || value === null ? null : NUMERIC.has(key) ? Number(value) : value;
  }
  return out;
}

/**
 * The coupon as the order was placed with it: its snapshot's rules over the
 * live row. An order placed before rules were kept has none and reads the
 * live row, as before.
 */
function asPlaced(discount, discountsSnapshot) {
  if (!discount) return discount;
  const entry = (discountsSnapshot || []).find((d) => d && d.kind !== 'bundle' && d.rules && (d.discountId === discount.id || (d.code && d.code === discount.code)));
  if (!entry) return discount;
  const plain = typeof discount.toJSON === 'function' ? discount.toJSON() : { ...discount };
  return { ...plain, ...entry.rules };
}

/** The delivery-fee part of the order's coupon, as placed (0 when none): kept as it was, never above the new fee. */
function placedShippingPart(discountsSnapshot, shippingAmount) {
  const entry = (discountsSnapshot || []).find((d) => d && d.kind !== 'bundle' && Number(d.shippingAmount) > 0);
  return entry ? Math.min(Number(entry.shippingAmount), Math.max(0, Number(shippingAmount) || 0)) : 0;
}

module.exports = {
  TIME_ZONE,
  scheduleOpen,
  lineCovered,
  alreadyDiscounted,
  isOfferLine,
  assertLines,
  capped,
  shippingPart,
  hasEarlierOrder,
  usesBy,
  assertCustomer,
  frozenRules,
  asPlaced,
  placedShippingPart,
};
