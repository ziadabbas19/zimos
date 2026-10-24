'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { STAGE_SQL, ORDERS_WITH_STAGE_FROM } = require('../orders/orderStage');
const orderService = require('../orders/orderService');
const { serializeOrder } = require('../publicApi/publicOrderSerializer');
const { subscribes } = require('./webhookEvents');

/**
 * Turns order changes into webhook deliveries — without any order writer
 * knowing it exists (see migration 117 for why it observes rather than being
 * called).
 *
 * One pass:
 *
 *   1. Takes the 'orders' cursor row with FOR UPDATE SKIP LOCKED. Another
 *      scanner holding it means that scanner is doing this pass; this one
 *      returns straight away.
 *   2. Lists the orders whose row, or any of whose shipments, has an
 *      updated_at inside (cursor − OVERLAP, now] — only in workspaces with an
 *      active endpoint, so a store without webhooks costs nothing. The list
 *      is read in pages of BATCH_SIZE, keyset on (changed_at, order_id), until
 *      a page comes back short; only then does the cursor move to now. (It
 *      used to stop at a full batch and move the cursor to that batch's last
 *      time — but 500 orders changed inside one minute, by a bulk action or a
 *      settlement, put that time inside the next pass's overlap, so every
 *      pass re-read the same 500 and the cursor never moved again.)
 *   3. Derives each one's state the way the orders screen does
 *      (orders/orderStage.js) — stage, the three state machines and the
 *      latest shipment's status — and compares it with the snapshot from the
 *      last time it was seen (webhook_order_states).
 *   4. For each difference, writes one delivery per subscribed endpoint, and
 *      stores the new snapshot. The dispatcher sends them.
 *
 * OVERLAP: a transaction stamps updated_at when it writes, but becomes
 * visible when it commits — a slow commit can land "behind" a cursor that
 * already moved past its timestamp. Re-reading the last minute on every pass
 * catches those, and costs nothing when nothing changed: an unchanged
 * signature produces no event.
 *
 * Which event an endpoint gets:
 *
 *   order seen before, state differs    order.status_changed, with `previous`
 *   order never seen, placed after the  order.created
 *     endpoint was added
 *   order never seen, older than the    order.status_changed with previous
 *     endpoint (an order from before     null — its state is news, its
 *     webhooks, changing now)            previous state isn't known
 */

const CURSOR_NAME = 'orders';
const OVERLAP_MS = 60 * 1000;
const FIRST_LOOKBACK_MS = 5 * 60 * 1000;
const BATCH_SIZE = 500;

function stateOf(row) {
  return {
    stage: row.stage,
    confirmationState: row.confirmation_state,
    financialState: row.financial_state,
    fulfillmentState: row.fulfillment_state,
    shipmentStatus: row.shipment_status || null,
  };
}

const signatureOf = (state) => Object.values(state).map((v) => (v === null ? '-' : v)).join('|');
const shortHash = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
const changedKeys = (previous, current) =>
  previous ? Object.keys(current).filter((key) => previous[key] !== current[key]) : Object.keys(current);

async function takeCursor(now, transaction) {
  await db.sequelize.query(
    `INSERT INTO webhook_scan_cursors (name, scanned_until, created_at, updated_at)
     VALUES (:name, :since, :now, :now)
     ON CONFLICT (name) DO NOTHING`,
    { replacements: { name: CURSOR_NAME, since: new Date(now.getTime() - FIRST_LOOKBACK_MS), now }, transaction }
  );
  return db.WebhookScanCursor.findOne({
    where: { name: CURSOR_NAME },
    transaction,
    lock: transaction.LOCK.UPDATE,
    skipLocked: true,
  });
}

// One page of the window, after the (changed_at, order_id) the previous page
// ended on. changed_at_key is the time as Postgres text, microseconds and all:
// a JS Date keeps only milliseconds, and a key rounded down would let the
// rows sharing that millisecond come back on the next page forever.
async function changedOrders({ since, until, limit, after = null }, transaction) {
  return db.sequelize.query(
    `WITH active AS (
       SELECT DISTINCT workspace_id FROM webhook_endpoints WHERE is_active
     ), changed AS (
       SELECT o.id AS order_id, o.updated_at AS changed_at
         FROM orders o JOIN active a ON a.workspace_id = o.workspace_id
        WHERE o.updated_at > :since AND o.updated_at <= :until
       UNION ALL
       SELECT s.order_id, s.updated_at
         FROM shipments s JOIN active a ON a.workspace_id = s.workspace_id
        WHERE s.updated_at > :since AND s.updated_at <= :until
     )
     SELECT g.order_id, g.changed_at, g.changed_at::text AS changed_at_key
       FROM (SELECT order_id, MAX(changed_at) AS changed_at FROM changed GROUP BY order_id) g
      ${after ? 'WHERE (g.changed_at, g.order_id) > (CAST(:afterAt AS timestamptz), CAST(:afterId AS uuid))' : ''}
      ORDER BY g.changed_at, g.order_id
      LIMIT :limit`,
    {
      replacements: { since, until, limit, afterAt: after ? after.at : null, afterId: after ? after.orderId : null },
      type: QueryTypes.SELECT,
      transaction,
    }
  );
}

async function currentStates(orderIds, transaction) {
  return db.sequelize.query(
    `SELECT o.id, o.workspace_id, o.created_at,
            o.confirmation_state, o.financial_state, o.fulfillment_state,
            ${STAGE_SQL} AS stage, ls.status AS shipment_status
       FROM ${ORDERS_WITH_STAGE_FROM}
      WHERE o.id IN (:ids)`,
    { replacements: { ids: orderIds }, type: QueryTypes.SELECT, transaction }
  );
}

/** One pass. Returns what it did, for the logs and the tests. */
async function scanOnce({ now = new Date(), limit = BATCH_SIZE } = {}) {
  // Most of the time, on most servers, no store has an endpoint yet: skip the
  // whole pass for one cheap query. The cursor still moves on, so the first
  // endpoint ever added doesn't receive every change made before it existed.
  const anyActive = await db.WebhookEndpoint.findOne({ where: { isActive: true }, attributes: ['id'] });
  if (!anyActive) {
    await db.WebhookScanCursor.update({ scannedUntil: now }, { where: { name: CURSOR_NAME } });
    return { skipped: false, scanned: 0, events: 0 };
  }

  return db.sequelize.transaction(async (transaction) => {
    const cursor = await takeCursor(now, transaction);
    if (!cursor) return { skipped: true, scanned: 0, events: 0 };

    const since = new Date(cursor.scannedUntil.getTime() - OVERLAP_MS);
    let scanned = 0;
    let events = 0;
    let pages = 0;
    let after = null;
    for (;;) {
      const candidates = await changedOrders({ since, until: now, limit, after }, transaction);
      pages += 1;
      if (candidates.length > 0) {
        const page = await processPage(candidates, now, transaction);
        scanned += page.scanned;
        events += page.events;
        const last = candidates[candidates.length - 1];
        after = { at: last.changed_at_key, orderId: last.order_id };
      }
      if (candidates.length < limit) break;
    }
    // The whole window is read: the next pass starts from now (less the overlap).
    await cursor.update({ scannedUntil: now }, { transaction });
    return { skipped: false, scanned, events, pages };
  });
}

/** Events and snapshots for one page of changed orders. */
async function processPage(candidates, now, transaction) {
  const changedAt = new Map(candidates.map((c) => [c.order_id, new Date(c.changed_at)]));
  const ids = [...changedAt.keys()];
  const [rows, snapshots] = await Promise.all([
    currentStates(ids, transaction),
    db.WebhookOrderState.findAll({ where: { orderId: ids }, transaction }),
  ]);
  const snapshotById = new Map(snapshots.map((s) => [s.orderId, s]));

  const workspaceIds = [...new Set(rows.map((r) => r.workspace_id))];
  const endpoints = await db.WebhookEndpoint.findAll({
    where: { workspaceId: workspaceIds, isActive: true },
    transaction,
  });
  const endpointsByWorkspace = new Map();
  for (const endpoint of endpoints) {
    if (!endpointsByWorkspace.has(endpoint.workspaceId)) endpointsByWorkspace.set(endpoint.workspaceId, []);
    endpointsByWorkspace.get(endpoint.workspaceId).push(endpoint);
  }

  const pending = []; // { endpoint, type, row, previous, current }
  const newSnapshots = [];
  for (const row of rows) {
    const current = stateOf(row);
    const signature = signatureOf(current);
    const snapshot = snapshotById.get(row.id);
    if (snapshot && snapshot.signature === signature) continue;

    for (const endpoint of endpointsByWorkspace.get(row.workspace_id) || []) {
      let type = 'order.status_changed';
      if (!snapshot && new Date(row.created_at) >= endpoint.createdAt) type = 'order.created';
      if (!subscribes(endpoint, type)) continue;
      pending.push({ endpoint, type, row, previous: snapshot ? snapshot.state : null, current, signature });
    }
    newSnapshots.push({ orderId: row.id, workspaceId: row.workspace_id, signature, state: current });
  }

  // An endpoint with a filter only hears about its funnels / products.
  if (pending.some((p) => p.endpoint.filter)) {
    const { orderSubject } = require('./webhookFanout');
    const { matchesFilter } = require('./webhookFilter');
    const subjects = new Map();
    const kept = [];
    for (const p of pending) {
      if (p.endpoint.filter) {
        if (!subjects.has(p.row.id)) subjects.set(p.row.id, await orderSubject(p.row.workspace_id, p.row.id));
        if (!matchesFilter(p.endpoint, subjects.get(p.row.id) || {})) continue;
      }
      kept.push(p);
    }
    pending.length = 0;
    pending.push(...kept);
  }

  // The order as the public API shows it, once per order however many
  // endpoints hear about it.
  // A locked order (orders/orderLock) is not sent at all: its customer's
  // details are hidden. Its snapshot is still kept, as for any order read.
  const orderIds = [...new Set(pending.map((p) => p.row.id))];
  const orders = new Map();
  for (const orderId of orderIds) {
    const row = rows.find((r) => r.id === orderId);
    const order = await orderService.getOrder(row.workspace_id, orderId);
    if (!order.contactLocked) orders.set(orderId, serializeOrder(order));
  }

  const deliveries = pending.filter(({ row }) => orders.has(row.id)).map(({ endpoint, type, row, previous, current, signature }) => {
    const eventId =
      type === 'order.created'
        ? `order.created:${row.id}`
        : `order.status_changed:${row.id}:${changedAt.get(row.id).getTime()}:${shortHash(signature)}`;
    const data = type === 'order.created'
      ? { order: orders.get(row.id), current }
      : { order: orders.get(row.id), previous, current, changed: changedKeys(previous, current) };
    return {
      workspaceId: row.workspace_id,
      endpointId: endpoint.id,
      eventId,
      eventType: type,
      payload: { id: eventId, type, createdAt: now.toISOString(), workspaceId: row.workspace_id, data },
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: now,
    };
  });

  if (deliveries.length > 0) {
    // (endpoint_id, event_id) is unique: a window read twice enqueues nothing twice.
    await db.WebhookDelivery.bulkCreate(deliveries, { ignoreDuplicates: true, transaction });
  }
  if (newSnapshots.length > 0) {
    await db.WebhookOrderState.bulkCreate(newSnapshots, {
      updateOnDuplicate: ['signature', 'state', 'updatedAt'],
      transaction,
    });
  }
  return { scanned: rows.length, events: deliveries.length };
}

module.exports = { scanOnce, OVERLAP_MS, BATCH_SIZE };
