'use strict';

const db = require('../../db/models');
const { normalizePhone } = require('../../core/utils/phone');
const { GOVERNORATES } = require('../shipping/governorates');
const orderService = require('./orderService');

/**
 * What the dashboard's "Create order" screen needs around POST /orders
 * (SPEC §4.5): find the customer by phone, and see the price before saving.
 */

/** Rolled back on purpose: carries the priced order out of the transaction. */
class PreviewDone extends Error {
  constructor(result) {
    super('preview');
    this.result = result;
  }
}

/**
 * Prices a manual order exactly as POST /orders would — the same function,
 * run inside a transaction that is then rolled back, so nothing is created,
 * reserved or numbered and the preview can never disagree with the order.
 * Errors the real order would raise (out of stock, unknown code, a product
 * that is no longer for sale) are raised here too.
 */
async function preview(workspaceId, payload, req) {
  const body = {
    ...payload,
    // A preview may come before the customer is typed in.
    contact: payload.contact && payload.contact.phone ? payload.contact : { fullName: 'Preview', phone: '01000000000' },
  };
  try {
    await db.sequelize.transaction(async (transaction) => {
      const { order, items } = await orderService.createOrder(workspaceId, body, req, {
        transaction,
        shippingOverride: shippingOverrideOf(payload),
      });
      throw new PreviewDone({
        currency: order.currency,
        subtotalAmount: String(order.subtotalAmount),
        discountAmount: String(order.discountAmount),
        shippingAmount: String(order.shippingAmount),
        taxAmount: String(order.taxAmount),
        totalAmount: String(order.totalAmount),
        shippingSnapshot: order.shippingSnapshot,
        items: items.map((i) => ({
          variantId: i.variantId,
          offerId: i.offerId,
          name: i.productNameSnapshot,
          options: i.variantOptionsSnapshot,
          offerName: i.offerNameSnapshot,
          quantity: i.quantity,
          unitPriceAmount: String(i.unitPriceAmount),
          lineTotalAmount: String(i.lineTotalAmount),
        })),
      });
    });
  } catch (err) {
    if (err instanceof PreviewDone) return err.result;
    throw err;
  }
  throw new Error('unreachable');
}

/** `shippingAmount` typed by staff replaces the calculated shipping. */
function shippingOverrideOf(payload) {
  return payload.shippingAmount === undefined || payload.shippingAmount === null ? null : { amount: payload.shippingAmount };
}

/**
 * The customer behind a phone number, with their last address and how their
 * orders went — or null. Any spelling of the number finds them.
 */
async function customerByPhone(workspaceId, phone) {
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) return null;
  const customer = await db.Customer.findOne({ where: { workspaceId, phoneNormalized } });
  if (!customer) return null;
  const orderLock = require('./orderLock');
  const lastOrder = await db.Order.findOne({
    where: { workspaceId, customerId: customer.id },
    order: [['createdAt', 'DESC']],
    attributes: [...new Set([...orderLock.ORDER_ATTRIBUTES, 'orderNumber', 'shippingAddressSnapshot', 'contactSnapshot', 'createdAt'])],
  });
  // A customer known only from locked orders comes hidden, and so does the
  // address of a locked last order (orders/orderLock). The typed phone is the merchant's own.
  const ctx = await orderLock.contextFor(workspaceId);
  const hidden = (await orderLock.lockedCustomerIds(ctx, workspaceId, [customer.id])).has(customer.id);
  const lastLocked = lastOrder ? (await orderLock.lockedIds(ctx, [lastOrder])).has(lastOrder.id) : false;
  const shown = (value) => (hidden && value ? orderLock.MASK : value);
  return {
    id: customer.id,
    fullName: shown(customer.fullName),
    phone: customer.phoneRaw || phone,
    alternatePhone: shown(customer.alternatePhone),
    email: shown(customer.email),
    isBlacklisted: customer.isBlacklisted,
    // A hidden customer's history would tie the typed phone to their locked orders: none of it.
    totalOrders: hidden ? null : customer.totalOrders || 0,
    totalRejectedOrders: hidden ? null : customer.totalRejectedOrders || 0,
    ...(ctx.enabled ? { contactLocked: hidden } : {}),
    lastAddress: lastOrder ? (lastLocked ? orderLock.maskAddress(lastOrder.shippingAddressSnapshot) : lastOrder.shippingAddressSnapshot) : null,
    lastOrder: lastOrder && !hidden ? { id: lastOrder.id, orderNumber: lastOrder.orderNumber, createdAt: lastOrder.createdAt } : null,
  };
}

function options() {
  return { governorates: GOVERNORATES.map((g) => ({ code: g.code, ar: g.ar, en: g.en })) };
}

module.exports = { preview, customerByPhone, options, shippingOverrideOf };
