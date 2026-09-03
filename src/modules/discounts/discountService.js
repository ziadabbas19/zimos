'use strict';

const db = require('../../db/models');
const { applyBasisPoints } = require('../../core/utils/money');
const { AppError } = require('../../core/errors/AppError');

/**
 * Validates a discount code against a priced cart and returns the discount
 * amount (in minor units) to apply, WITHOUT redeeming it yet. Redemption
 * (which enforces usage limits atomically) happens in redeem(), called
 * inside the same order-creation transaction so a usage-limit check and the
 * increment that enforces it can never race.
 */
async function evaluate(workspaceId, code, { subtotal, productIds, collectionIds, customerId, funnelId }) {
  if (!code) return { discount: null, amount: 0 };

  const discount = await db.Discount.findOne({ where: { workspaceId, code, status: 'active' } });
  if (!discount) throw new AppError('INVALID_DISCOUNT_CODE', 'Discount code is invalid', 422);

  const now = new Date();
  if (discount.startsAt && discount.startsAt > now) throw new AppError('DISCOUNT_NOT_STARTED', 'Discount code is not yet active', 422);
  if (discount.endsAt && discount.endsAt < now) throw new AppError('DISCOUNT_EXPIRED', 'Discount code has expired', 422);
  if (discount.minimumSubtotal && subtotal < discount.minimumSubtotal) {
    throw new AppError('DISCOUNT_MINIMUM_NOT_MET', 'Order subtotal does not meet the discount minimum', 422);
  }
  if (discount.productRestrictions.length && !discount.productRestrictions.some((id) => productIds.includes(id))) {
    throw new AppError('DISCOUNT_NOT_APPLICABLE', 'Discount code does not apply to items in this order', 422);
  }
  if (discount.funnelRestrictions.length && (!funnelId || !discount.funnelRestrictions.includes(funnelId))) {
    throw new AppError('DISCOUNT_NOT_APPLICABLE', 'Discount code does not apply to this funnel', 422);
  }
  if (discount.usageLimit !== null && discount.usageCount >= discount.usageLimit) {
    throw new AppError('DISCOUNT_USAGE_LIMIT_REACHED', 'Discount code has reached its usage limit', 422);
  }
  if (discount.perCustomerLimit !== null && customerId) {
    const used = await db.DiscountRedemption.count({ where: { discountId: discount.id, customerId } });
    if (used >= discount.perCustomerLimit) {
      throw new AppError('DISCOUNT_PER_CUSTOMER_LIMIT_REACHED', 'You have already used this discount code', 422);
    }
  }

  let amount = 0;
  if (discount.type === 'percentage') amount = applyBasisPoints(subtotal, discount.value);
  else if (discount.type === 'fixed') amount = Math.min(discount.value, subtotal);
  // free_shipping and buy_x_get_y are applied by the caller against
  // shipping/line totals respectively using discount.buyXGetYConfig; amount
  // here only covers the subtotal-level percentage/fixed cases.

  return { discount, amount };
}

/**
 * Redeems a discount inside the caller's transaction: increments usageCount
 * and inserts a DiscountRedemption row, using SELECT ... FOR UPDATE on the
 * discount row so two concurrent checkouts racing for the last remaining
 * use of a limited discount cannot both succeed.
 */
async function redeem(discountId, { orderId, customerId, amountAllocated }, transaction) {
  const discount = await db.Discount.findByPk(discountId, { lock: transaction.LOCK.UPDATE, transaction });
  if (discount.usageLimit !== null && discount.usageCount >= discount.usageLimit) {
    throw new AppError('DISCOUNT_USAGE_LIMIT_REACHED', 'Discount code has reached its usage limit', 422);
  }
  await discount.update({ usageCount: discount.usageCount + 1 }, { transaction });
  await db.DiscountRedemption.create(
    { workspaceId: discount.workspaceId, discountId, orderId, customerId, amountAllocated },
    { transaction }
  );
}

module.exports = { evaluate, redeem };
