'use strict';

const asyncHandler = require('express-async-handler');
const logger = require('../../core/utils/logger');
const { AuthorizationError } = require('../../core/errors/AppError');
const { PERMISSIONS } = require('../../core/security/permissions');

/**
 * POST /orders/:orderId/cancel with SPEC §4.4's cancellation options:
 * `notifyCustomer` (the order.cancelled event carries it; see
 * notifications/orderEmailService) and `refundAmount` — what to give back,
 * refunded right after the cancellation commits, through the same path as
 * POST /orders/:id/refunds (refunds.manage, checked before anything changes).
 *
 * The cancellation stands when the refund fails (a gateway refusal, an
 * amount above what was paid): the answer carries `refundError` and the
 * merchant refunds from the payments card.
 */
const handler = asyncHandler(async (req, res) => {
  const { workspaceId } = req.tenant;
  const { refundAmount, notifyCustomer, ...cancel } = req.body;
  if (refundAmount && !req.tenant.hasPermission(PERMISSIONS.REFUNDS_MANAGE)) {
    throw new AuthorizationError(`Missing required permission: ${PERMISSIONS.REFUNDS_MANAGE}`);
  }
  const order = await require('./orderService').cancelOrder(workspaceId, req.params.orderId, { ...cancel, notifyCustomer }, req);
  // Every answer below carries the order through the lock (orders/orderLock).
  const shown = async (o) => require('./orderLock').presentOrder(workspaceId, typeof o.toJSON === 'function' ? o.toJSON() : o);
  if (!refundAmount) return res.json({ order: await shown(order) });

  if (notifyCustomer !== undefined) req.notifyCustomer = notifyCustomer;
  try {
    const refund = await require('../payments/paymentService').processRefund(
      workspaceId,
      order.id,
      { amount: refundAmount, reason: cancel.reason ? String(cancel.reason).slice(0, 300) : undefined },
      req
    );
    const fresh = await require('../../db/models').Order.findByPk(order.id);
    return res.json({ order: await shown(fresh || order), refund });
  } catch (err) {
    if (!err.isOperational) logger.error('Refund after cancellation failed', { workspaceId, orderId: order.id, message: err.message });
    return res.json({
      order: await shown(order),
      refundError: { code: err.isOperational ? err.code : 'INTERNAL_SERVER_ERROR', message: err.isOperational ? err.message : 'The refund could not be made' },
    });
  }
});

module.exports = { handler };
