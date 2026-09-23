'use strict';

/**
 * The one definition of an order's pipeline stage — the tab a merchant finds
 * it under on the orders screen.
 *
 * It is derived in SQL, never stored. The order's real state lives in three
 * independent columns (confirmation / financial / fulfillment, see
 * models/order.js) plus the shipment rows, and every one of them is written
 * by a different module. A stored `stage` column would be a fourth copy of
 * that truth, written from four places, and the first missed write would show
 * the merchant a tab count that disagrees with the tab's own contents — a bug
 * nobody would notice until a parcel sat in the wrong list for a week.
 * Deriving it means the list, the counts and the order detail cannot drift
 * apart: they all read the expression below.
 *
 * Both the CASE and the lateral join assume the orders table is aliased `o`.
 *
 * Precedence is top to bottom, first match wins:
 *
 *   cancelled         cancelled_at set, or the COD call ended in a rejection
 *   returned          the parcel came back
 *   delivered         the parcel arrived
 *   delivery_failed   the courier could not deliver it
 *   out_for_delivery  with the courier, out on the round
 *   shipped           collected by the courier, in transit
 *   needs_follow_up   COD call went unanswered or the customer postponed
 *   pending_confirmation  waiting on the COD call, or on a prepaid payment
 *   ready_to_ship     everything else: confirmed (or paid) and still here
 */

// Every key the expression below can produce. The list endpoint validates
// `stage` against it and the counts endpoint zero-fills with it, so a key
// added here without a matching CASE arm would simply always count zero.
const STAGES = [
  'pending_confirmation',
  'needs_follow_up',
  'ready_to_ship',
  'shipped',
  'out_for_delivery',
  'delivery_failed',
  'delivered',
  'returned',
  'cancelled',
];

/**
 * The latest shipment that still counts, as `ls.status`.
 *
 * LATERAL rather than a correlated subquery repeated inside the CASE: the
 * CASE tests the shipment status six times, and a correlated subquery would
 * be six lookups per order row where this is one.
 *
 * "Latest" is the most recently created non-cancelled shipment, `id` breaking
 * a created_at tie. An order can have several — a COD upsell that missed the
 * waybill is appended as a second parcel, and a failed delivery is often
 * re-sent — and the merchant's question ("where is this order right now?") is
 * answered by the newest one. Cancelled shipments are excluded outright: a
 * cancelled waybill is not where the order is, and an order whose only
 * shipment was cancelled correctly falls back to being ready to ship.
 */
const LATEST_SHIPMENT_JOIN = `
    LEFT JOIN LATERAL (
      SELECT s.status
        FROM shipments s
       WHERE s.order_id = o.id
         AND s.status <> 'cancelled'
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT 1
    ) ls ON TRUE`;

/** `FROM` clause every stage-aware query shares. */
const ORDERS_WITH_STAGE_FROM = `orders o${LATEST_SHIPMENT_JOIN}`;

const STAGE_SQL = `CASE
      WHEN o.cancelled_at IS NOT NULL OR o.confirmation_state = 'rejected' THEN 'cancelled'

      -- While a live shipment exists it is the most recent thing anyone knows
      -- about the order, so it outranks the order's own fulfillment_state —
      -- which still says 'fulfilled' from a previous parcel after a re-send.
      WHEN ls.status = 'returned' THEN 'returned'
      WHEN ls.status = 'delivered' THEN 'delivered'
      WHEN ls.status = 'failed' THEN 'delivery_failed'
      WHEN ls.status = 'out_for_delivery' THEN 'out_for_delivery'
      WHEN ls.status IN ('picked_up', 'in_transit') THEN 'shipped'
      -- 'created' is deliberately absent: a created shipment is a printed
      -- waybill, and the parcel is still on the merchant's desk. The rest of
      -- the codebase already reads it that way — SHIPMENT_IN_MOTION in
      -- orderService excludes it, so an order with one can still be edited
      -- and cancelled, and cancelling the order cancels that shipment. It
      -- therefore falls through to ready_to_ship below.

      -- No shipment in play: what the order itself records.
      WHEN ls.status IS NULL AND o.fulfillment_state = 'returned' THEN 'returned'
      WHEN ls.status IS NULL AND o.fulfillment_state = 'fulfilled' THEN 'delivered'

      -- Nothing has shipped: where the confirmation call stands.
      WHEN o.confirmation_state IN ('unreachable', 'postponed') THEN 'needs_follow_up'
      -- A confirmation task is only ever created for COD (see
      -- orderService.createOrder), so a card/wallet/bank order's
      -- confirmation_state stays 'pending' for life. Reading that as "waiting
      -- on a call" would park every prepaid order in the New tab forever, so
      -- a prepaid order that has been paid is not waiting on anything and
      -- falls through to ready_to_ship. An unpaid one genuinely is new.
      WHEN o.confirmation_state = 'pending'
           AND NOT (o.payment_method <> 'cod' AND o.financial_state IN ('paid', 'partially_paid'))
        THEN 'pending_confirmation'

      ELSE 'ready_to_ship'
    END`;

module.exports = { STAGES, STAGE_SQL, LATEST_SHIPMENT_JOIN, ORDERS_WITH_STAGE_FROM };
