'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');

/**
 * When an order counts as accepted: the moment a kitchen, a till or an
 * accounting sheet should take it. Read from the states the order already
 * has — there is no "accepted" state, and nothing here writes one.
 *
 *   confirmed            an order that goes through confirmation (cash on
 *                        delivery, or a manual transfer whose proof staff
 *                        review) once it is confirmed: at confirmed_at
 *   paid                 an order paid online (a gateway, or a transfer staff
 *                        recorded) once it is paid in full, refunds after
 *                        that included: at completed_at, when the payment
 *                        made it a sale (orderCompletion.js)
 *
 * A cancelled order is not accepted, whatever it was before. One definition
 * for the webhook event order.accepted (webhooks/webhookFanout.js), the
 * public API's accepted-orders feed (publicApi/acceptedOrdersFeed.js) and the
 * accepted-orders export (orderExportService.js). The SQL assumes the orders
 * alias `o`.
 */

const PAID_SQL = "('paid', 'partially_refunded', 'refunded')";

// A manual transfer (InstaPay, wallet) the shopper sends proof for is
// confirmed like COD; one staff recorded by hand has no such row.
const THROUGH_CONFIRMATION_SQL = `(o.payment_method = 'cod' OR EXISTS (SELECT 1 FROM order_manual_payments amp WHERE amp.order_id = o.id))`;

const ACCEPTED_SQL = `(o.cancelled_at IS NULL AND (
    (o.confirmation_state = 'confirmed' AND ${THROUGH_CONFIRMATION_SQL})
    OR (NOT ${THROUGH_CONFIRMATION_SQL} AND o.financial_state IN ${PAID_SQL})
  ))`;

const ACCEPTED_AT_SQL = `(CASE WHEN ${THROUGH_CONFIRMATION_SQL} THEN o.confirmed_at ELSE COALESCE(o.completed_at, o.updated_at) END)`;

const VIA_SQL = `(CASE WHEN ${THROUGH_CONFIRMATION_SQL} THEN 'confirmation' ELSE 'payment' END)`;

/** { accepted, via: 'confirmation' | 'payment', acceptedAt } for one order of the store, or null. */
async function acceptanceOf(workspaceId, orderId, transaction) {
  const [row] = await db.sequelize.query(
    `SELECT ${ACCEPTED_SQL} AS accepted, ${VIA_SQL} AS via, ${ACCEPTED_AT_SQL} AS accepted_at
       FROM orders o
      WHERE o.id = :orderId AND o.workspace_id = :workspaceId`,
    { replacements: { orderId, workspaceId }, type: QueryTypes.SELECT, transaction }
  );
  if (!row) return null;
  return { accepted: Boolean(row.accepted), via: row.via, acceptedAt: row.accepted_at || null };
}

module.exports = { ACCEPTED_SQL, ACCEPTED_AT_SQL, VIA_SQL, THROUGH_CONFIRMATION_SQL, acceptanceOf };
