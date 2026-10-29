'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');

/*
 * Which reviews count in a rating, and what the merchant is told about each
 * reviewer's purchase. Decided when read, so a review sent while its order was
 * on the way starts counting the day the order is delivered.
 *
 * A review counts in the stars a shopper sees when all of these hold:
 *   - the merchant published it (status 'approved', with or without its text);
 *   - it is linked to an order of this store that was delivered (fulfilled, or
 *     a shipment marked delivered: the rule reviewService used before) and
 *     not cancelled or rejected;
 *   - for a product review, that order holds the product.
 * Anything else (no purchase, an order still on its way, a cancelled one, a
 * review the merchant added by hand) can be published but never moves the
 * average.
 */

/** SQL true when the review aliased `r` comes from a delivered purchase. Binds nothing. */
function deliveredPurchaseSql(r = 'r') {
  return `EXISTS (
    SELECT 1 FROM orders ro
     WHERE ro.id = ${r}.order_id AND ro.workspace_id = ${r}.workspace_id
       AND ro.cancelled_at IS NULL AND ro.confirmation_state <> 'rejected'
       AND (ro.fulfillment_state = 'fulfilled'
            OR EXISTS (SELECT 1 FROM shipments rs WHERE rs.order_id = ro.id AND rs.status = 'delivered'))
       AND (${r}.kind = 'store'
            OR EXISTS (SELECT 1 FROM order_items ri WHERE ri.order_id = ro.id AND ri.product_id = ${r}.product_id)))`;
}

const EMPTY = () => ({ average: null, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });

function summarize(rows) {
  const out = EMPTY();
  let sum = 0;
  for (const row of rows) {
    const n = Number(row.n);
    out.distribution[row.rating] = n;
    out.count += n;
    sum += n * Number(row.rating);
  }
  out.average = out.count ? Math.round((sum / out.count) * 10) / 10 : null;
  return out;
}

/** The rating a shopper sees for one product: { average, count, distribution }. */
async function productRating(workspaceId, productId) {
  const rows = await db.sequelize.query(
    `SELECT r.rating, COUNT(*)::int AS n FROM reviews r
      WHERE r.workspace_id = :workspaceId AND r.kind = 'product' AND r.product_id = :productId
        AND r.status = 'approved' AND ${deliveredPurchaseSql('r')}
      GROUP BY r.rating`,
    { replacements: { workspaceId, productId }, type: QueryTypes.SELECT }
  );
  return summarize(rows);
}

/** Ratings of many products at once: Map productId → { average, count }. Products with none are left out. */
async function productRatings(workspaceId, productIds) {
  const ids = [...new Set((productIds || []).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db.sequelize.query(
    `SELECT r.product_id, ROUND(AVG(r.rating)::numeric, 1)::float AS average, COUNT(*)::int AS count FROM reviews r
      WHERE r.workspace_id = :workspaceId AND r.kind = 'product' AND r.product_id IN (:ids)
        AND r.status = 'approved' AND ${deliveredPurchaseSql('r')}
      GROUP BY r.product_id`,
    { replacements: { workspaceId, ids }, type: QueryTypes.SELECT }
  );
  return new Map(rows.map((row) => [row.product_id, { average: Number(row.average), count: row.count }]));
}

/** The store's own rating (store reviews): { average, count, distribution }. */
async function storeRating(workspaceId) {
  const rows = await db.sequelize.query(
    `SELECT r.rating, COUNT(*)::int AS n FROM reviews r
      WHERE r.workspace_id = :workspaceId AND r.kind = 'store' AND r.status = 'approved' AND ${deliveredPurchaseSql('r')}
      GROUP BY r.rating`,
    { replacements: { workspaceId }, type: QueryTypes.SELECT }
  );
  return summarize(rows);
}

/** The ids among `reviewIds` that come from a delivered purchase (the "verified buyer" mark). */
async function verifiedIds(workspaceId, reviewIds) {
  const ids = [...new Set((reviewIds || []).filter(Boolean))];
  if (ids.length === 0) return new Set();
  const rows = await db.sequelize.query(
    `SELECT r.id FROM reviews r WHERE r.workspace_id = :workspaceId AND r.id IN (:ids) AND ${deliveredPurchaseSql('r')}`,
    { replacements: { workspaceId, ids }, type: QueryTypes.SELECT }
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * Where an order stands for the merchant's review list:
 *   delivered | ordered (placed, not delivered yet) | cancelled | returned.
 * Cancelled wins over everything, then delivered (the same rule as above).
 */
function orderState(order) {
  if (order.cancelled_at || order.confirmation_state === 'rejected') return 'cancelled';
  if (order.fulfillment_state === 'fulfilled' || order.has_delivered) return 'delivered';
  if (order.fulfillment_state === 'returned') return 'returned';
  return 'ordered';
}

/** Map orderId → { id, orderNumber, state } for the orders the reviews point at. */
async function orderStates(workspaceId, orderIds) {
  const ids = [...new Set((orderIds || []).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db.sequelize.query(
    `SELECT o.id, o.order_number, o.cancelled_at, o.confirmation_state, o.fulfillment_state,
            EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.id AND s.status = 'delivered') AS has_delivered
       FROM orders o WHERE o.workspace_id = :workspaceId AND o.id IN (:ids)`,
    { replacements: { workspaceId, ids }, type: QueryTypes.SELECT }
  );
  return new Map(rows.map((row) => [row.id, { id: row.id, orderNumber: row.order_number, state: orderState(row) }]));
}

const STATE_RANK = { delivered: 0, ordered: 1, returned: 2, cancelled: 3 };

/**
 * The order a new review is linked to: the reviewer's (customer's) order that
 * holds the product (any order for a store review), the best one first —
 * delivered, then on its way, then returned, then cancelled; newest first
 * among equals. null when they have none.
 */
async function bestOrderFor(workspaceId, customerId, productId, transaction) {
  if (!customerId) return null;
  const rows = await db.sequelize.query(
    `SELECT o.id, o.order_number, o.cancelled_at, o.confirmation_state, o.fulfillment_state, o.created_at,
            EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.id AND s.status = 'delivered') AS has_delivered
       FROM orders o
      WHERE o.workspace_id = :workspaceId AND o.customer_id = :customerId
        ${productId ? 'AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.product_id = :productId)' : ''}
      ORDER BY o.created_at DESC
      LIMIT 50`,
    { replacements: { workspaceId, customerId, productId: productId || null }, type: QueryTypes.SELECT, transaction }
  );
  let best = null;
  for (const row of rows) {
    const state = orderState(row);
    if (!best || STATE_RANK[state] < STATE_RANK[best.state]) best = { id: row.id, orderNumber: row.order_number, state };
  }
  return best;
}

module.exports = { deliveredPurchaseSql, productRating, productRatings, storeRating, verifiedIds, orderStates, orderState, bestOrderFor };
