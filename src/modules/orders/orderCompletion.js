'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { createInvoiceForOrder } = require('../invoices/invoiceService');
const discountService = require('../discounts/discountService');

/**
 * What happens when an order becomes a real sale, in one place.
 *
 * A COD order is a sale the moment it is placed, so createOrder runs both
 * halves at creation. A prepaid order is not a sale until the gateway says the
 * money arrived: until then it is a reservation the shopper may walk away
 * from, and it must not issue an invoice, use up a discount, count towards the
 * customer's orders or convert their cart and abandoned checkout. It runs both
 * halves when the payment is confirmed (see payments/onlinePaymentService).
 *
 * In the transaction that makes it a sale:
 *   - the invoice
 *   - the discount redemption (when the order used a code)
 *   - customer.totalOrders + 1
 *   - orders.completed_at, which is what makes this run at most once
 *
 * After that transaction commits (bookkeeping about the order, never part of
 * it — a failure is logged, not thrown):
 *   - the cart the order came from is marked converted
 *   - the autosaved checkout sessions for this shopper are converted
 */

/**
 * @param {object} order     the Order row, with `items` loaded or loadable
 * @param {object} options
 * @param {object} [options.discount]  { discountId, amountAllocated } — omitted when no code was used
 * @param {boolean} [options.lateRedemption]  the code was checked when the order was placed but is
 *        only redeemed now, after the shopper paid; a code that ran out in between is still recorded
 *        (the shopper was charged the discounted price) rather than failing a captured payment
 * @returns {Promise<boolean>} false when the order was already completed
 */
async function completeOrderInTransaction(order, { discount = null, lateRedemption = false } = {}, transaction) {
  if (order.completedAt) return false;

  if (discount && discount.discountId) {
    await discountService.redeem(
      discount.discountId,
      { orderId: order.id, customerId: order.customerId, amountAllocated: discount.amountAllocated },
      transaction,
      { allowOverLimit: lateRedemption }
    );
  }

  if (!order.items) {
    order.items = await db.OrderItem.findAll({ where: { orderId: order.id }, transaction });
  }
  await createInvoiceForOrder(order, transaction);

  await db.Customer.increment('totalOrders', { by: 1, where: { id: order.customerId }, transaction });

  await order.update({ completedAt: new Date() }, { transaction });
  return true;
}

/**
 * The post-commit half. `cartId` is the cart the order came from (storefront
 * cart checkout only); `checkoutSessionId` is the storefront's hint for the
 * autosaved session. Sessions matching the order's phone are converted either
 * way. Never throws.
 */
async function afterOrderCompleted(workspaceId, order, { cartId = null, checkoutSessionId = null } = {}) {
  if (cartId) {
    try {
      await require('../cart/cartService').markConverted(cartId, order.id);
    } catch (err) {
      logger.error('Could not mark a cart converted', { workspaceId, orderId: order.id, message: err.message });
    }
  }
  // Required here, not at the top: checkoutSessionService prices lines with
  // orderService.priceLine, and orderService requires this module.
  await require('../checkoutSessions/checkoutSessionService').convertAfterOrder(workspaceId, order, {
    checkoutSessionId,
  });
}

module.exports = { completeOrderInTransaction, afterOrderCompleted };
