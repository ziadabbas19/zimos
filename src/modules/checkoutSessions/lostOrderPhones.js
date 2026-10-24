'use strict';

const asyncHandler = require('express-async-handler');
const Joi = require('joi');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * Lost orders and phone masking (SPEC §3.4-8). The list and the export show
 * phones partly hidden to anyone without customers.reveal_sensitive, as the
 * orders and customers lists do. Reaching the shopper still works: the row's
 * WhatsApp / Call actions ask for the one number here, and every such ask is
 * in the activity log — the same deal as opening an order page.
 */

const isMasked = (phone) => typeof phone === 'string' && phone.includes('*');

/** The phone this lost order was captured with. */
function phoneOf(session) {
  const stored = session.contactFields || {};
  const payload = (session.checkoutPayload && session.checkoutPayload.contact) || {};
  return stored.phone || payload.phone || (session.phoneNormalized !== 'unknown' ? session.phoneNormalized : null) || null;
}

const schema = {
  params: Joi.object({ workspaceId: Joi.string().uuid().required(), sessionId: Joi.string().uuid().required() }),
};

// POST /workspaces/:ws/checkout-sessions/:sessionId/reveal-phone → { phone }
const reveal = asyncHandler(async (req, res) => {
  const session = await db.CheckoutSession.findOne({ where: { id: req.params.sessionId, workspaceId: req.tenant.workspaceId } });
  if (!session) throw new NotFoundError('CheckoutSession');
  // Hidden while new orders are locked (402 ORDER_LOCKED, orders/orderLock).
  await require('../orders/orderLock').assertPendingOpen(req.tenant.workspaceId);
  await recordAudit({
    workspaceId: req.tenant.workspaceId,
    actorUserId: req.user.id,
    action: 'lost_order.reveal_phone',
    entityType: 'CheckoutSession',
    entityId: session.id,
    req,
  });
  res.json({ phone: phoneOf(session) });
});

module.exports = { isMasked, phoneOf, schema, reveal };
