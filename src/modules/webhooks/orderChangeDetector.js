'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { STAGE_SQL, ORDERS_WITH_STAGE_FROM } = require('../orders/orderStage');
const orderService = require('../orders/orderService');
const { serializeOrders } = require('../publicApi/publicOrderOptions');
const { subscribes } = require('./webhookEvents');
const orderLock = require('../orders/orderLock');
const { capPayload } = require('./webhookPayloadCap');

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
 *
 * A locked order (orders/orderLock, ORDERS_LOCK_ENABLED) is not sent while it
 * is locked: it gets a row in webhook_order_holds instead, and its snapshot is
 * left as it was — the last state actually sent, or none. When it opens (the
 * store renews, tops up, the fee is paid…) `releaseHeld`, on the next pass,
 * runs it through the same comparison as a change made now: never sent → its
 * order.created, as if it had just been placed; sent before → one
 * order.status_changed when its state moved meanwhile, nothing when it did
 * not. order.created's event id is per order, so it is never queued twice for
 * an endpoint.
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

/**
 * The ids among `ids` that are locked now (orders/orderLock). Nothing is read
 * while the switch is off.
 */
async function lockedNow(ids, transaction) {
  const locked = new Set();
  if (!orderLock.enabled() || ids.length === 0) return locked;
  const orders = await db.Order.findAll({ where: { id: ids }, attributes: orderLock.ORDER_ATTRIBUTES, transaction });
  const byWorkspace = new Map();
  for (const order of orders) {
    if (!byWorkspace.has(order.workspaceId)) byWorkspace.set(order.workspaceId, []);
    byWorkspace.get(order.workspaceId).push(order);
  }
  for (const [workspaceId, list] of byWorkspace) {
    const ctx = await orderLock.contextFor(workspaceId, { transaction });
    for (const id of await orderLock.lockedIds(ctx, list, { transaction })) locked.add(id);
  }
  return locked;
}

/** Events and snapshots for one page of changed orders. */
async function processPage(candidates, now, transaction) {
  const changedAt = new Map(candidates.map((c) => [c.order_id, new Date(c.changed_at)]));
  const ids = [...changedAt.keys()];
  const [rows, snapshots] = await Promise.all([
    currentStates(ids, transaction),
    db.WebhookOrderState.findAll({ where: { orderId: ids }, transaction }),
  ]);
  const locked = await lockedNow(ids, transaction);
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
  const holds = [];
  for (const row of rows) {
    const current = stateOf(row);
    const signature = signatureOf(current);
    const snapshot = snapshotById.get(row.id);
    if (snapshot && snapshot.signature === signature) continue;
    // Locked: nothing sent, the snapshot left as last sent; releaseHeld sends it once it opens.
    if (locked.has(row.id)) {
      holds.push({ orderId: row.id, workspaceId: row.workspace_id, heldAt: now, checkedAt: now });
      continue;
    }

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
  // endpoints hear about it. An order that locked between the two reads (its
  // store's last fee spent meanwhile) is held like any locked one: its
  // snapshot is not moved on, so releaseHeld sends it when it opens.
  const orderIds = [...new Set(pending.map((p) => p.row.id))];
  const orders = new Map();
  for (const orderId of orderIds) {
    const row = rows.find((r) => r.id === orderId);
    const order = await orderService.getOrder(row.workspace_id, orderId);
    if (!order.contactLocked) {
      const [serialized] = await serializeOrders(row.workspace_id, [order]);
      orders.set(orderId, serialized);
      continue;
    }
    holds.push({ orderId, workspaceId: row.workspace_id, heldAt: now, checkedAt: now });
    const at = newSnapshots.findIndex((s) => s.orderId === orderId);
    if (at >= 0) newSnapshots.splice(at, 1);
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
      payload: capPayload({ id: eventId, type, createdAt: now.toISOString(), workspaceId: row.workspace_id, data }),
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
  // The first change seen while locked keeps its held_at.
  if (holds.length > 0) await db.WebhookOrderHold.bulkCreate(holds, { ignoreDuplicates: true, transaction });
  return { scanned: rows.length, events: deliveries.length, held: holds.length };
}

// A held order is looked at again at most this often.
const RECHECK_MS = 15 * 1000;

/**
 * The held orders that have opened since: their events go out now, through
 * processPage as a change made at `now` (order.created when never sent,
 * order.status_changed when the state moved since the last one sent, nothing
 * when it did not), and their holds go. The ones still locked are looked at
 * again after RECHECK_MS. One transaction, the holds taken FOR UPDATE SKIP
 * LOCKED, so two runners never release the same order. Cheap when there is
 * none: one indexed read.
 */
async function releaseHeld({ now = new Date(), limit = BATCH_SIZE } = {}) {
  return db.sequelize.transaction(async (transaction) => {
    const holds = await db.sequelize.query(
      `SELECT order_id FROM webhook_order_holds
        WHERE checked_at <= :cutoff
        ORDER BY checked_at ASC
        LIMIT :limit
        FOR UPDATE SKIP LOCKED`,
      { replacements: { cutoff: new Date(now.getTime() - RECHECK_MS), limit }, type: QueryTypes.SELECT, transaction }
    );
    if (holds.length === 0) return { released: 0, stillHeld: 0, events: 0 };
    const ids = holds.map((h) => h.order_id);
    const locked = await lockedNow(ids, transaction);
    const open = ids.filter((id) => !locked.has(id));
    const still = ids.filter((id) => locked.has(id));
    if (still.length > 0) await db.WebhookOrderHold.update({ checkedAt: now }, { where: { orderId: still }, transaction });
    let events = 0;
    if (open.length > 0) {
      await db.WebhookOrderHold.destroy({ where: { orderId: open }, transaction });
      const page = await processPage(
        open.map((id) => ({ order_id: id, changed_at: now })),
        now,
        transaction
      );
      events = page.events;
    }
    return { released: open.length, stillHeld: still.length, events };
  });
}

module.exports = { scanOnce, releaseHeld, OVERLAP_MS, BATCH_SIZE, RECHECK_MS };
