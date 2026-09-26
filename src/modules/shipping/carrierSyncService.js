'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const carriers = require('./carriers');
const accounts = require('./carrierAccountService');
const {
  applyCarrierStatus,
  flagUnconfirmedCancel,
  TERMINAL_STATUSES,
  CANCEL_CHECKS_MS,
  FLAG_CANCEL_UNCONFIRMED,
} = require('./carrierShipmentService');

/**
 * Reads open carrier shipments from their carriers on a schedule — for
 * carriers whose webhooks can't be relied on alone (capabilities.polling).
 * Run by scripts/sync-carrier-shipments.js.
 *
 * Scheduling lives on the shipment (migration 102): next_poll_at is set when
 * a polled carrier books it, moved forward after every read, and cleared
 * once the shipment is final, too old, or its carrier/connection is gone.
 * Claimed rows get a short lease (next_poll_at pushed ahead, rows locked FOR
 * UPDATE SKIP LOCKED), so overlapping runs never read the same shipment.
 *
 * A failed read backs off: interval x 2^failures, at most a day.
 *
 * The same scan runs the verification checks after a manual-cancel
 * acknowledgement (scheduled by carrierShipmentService): the carrier is
 * asked again ~24h and ~72h later, and if it still has the parcel moving,
 * the order is flagged and audited — our own status stays cancelled. After
 * the last check the shipment is never read again.
 */

const LEASE_MS = 10 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const BULK_CHUNK = 50;

// A check that keeps failing gives up this long after the acknowledgement.
const CANCEL_CHECK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// What a scheduled check counts as a parcel the carrier has not cancelled:
// anything it still has on the road, including one it never collected.
const STILL_ACTIVE = ['created', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered'];

const minutes = (n) => n * 60 * 1000;

function backoffAt(adapter, failures, now) {
  const base = minutes(adapter ? adapter.pollIntervalMinutes : 60);
  return new Date(now.getTime() + Math.min(base * 2 ** failures, MAX_BACKOFF_MS));
}

async function claimDue({ limit, now }) {
  return db.sequelize.query(
    `UPDATE shipments s
        SET next_poll_at = $lease
      WHERE s.id IN (
              SELECT id FROM shipments
               WHERE next_poll_at IS NOT NULL AND next_poll_at <= $now
               ORDER BY next_poll_at
               LIMIT $limit
               FOR UPDATE SKIP LOCKED)
  RETURNING s.id, s.workspace_id AS "workspaceId", s.carrier_code AS "carrierCode",
            s.waybill_number AS "waybillNumber", s.status, s.order_id AS "orderId",
            s.cancel_mode AS "cancelMode", s.cancel_acknowledged_at AS "cancelAcknowledgedAt",
            s.poll_failures AS "pollFailures", s.created_at AS "createdAt"`,
    {
      bind: { now: now.toISOString(), lease: new Date(now.getTime() + LEASE_MS).toISOString(), limit },
      type: QueryTypes.SELECT,
    }
  );
}

const setSchedule = (id, values) => db.Shipment.update(values, { where: { id } });

// --- regular polling -----------------------------------------------------------

async function nextRegularPoll(adapter, row, now) {
  const shipment = await db.Shipment.findByPk(row.id, { attributes: ['id', 'status', 'createdAt'] });
  const tooOld = now - new Date(row.createdAt) > env.carriers.pollMaxAgeDays * 24 * 60 * 60 * 1000;
  if (!shipment || TERMINAL_STATUSES.includes(shipment.status) || tooOld) return null;
  return new Date(now.getTime() + minutes(adapter.pollIntervalMinutes));
}

async function pollSucceeded(adapter, row, result, now, outcome) {
  const { changed } = await applyCarrierStatus(row.workspaceId, row.id, result, { trigger: 'poll' });
  await setSchedule(row.id, {
    nextPollAt: await nextRegularPoll(adapter, row, now),
    lastPolledAt: now,
    pollFailures: 0,
  });
  outcome[changed ? 'changed' : 'unchanged'] += 1;
}

async function pollFailed(adapter, row, now, outcome, reason) {
  const failures = row.pollFailures + 1;
  await setSchedule(row.id, { nextPollAt: backoffAt(adapter, failures, now), pollFailures: failures });
  outcome.failed += 1;
  logger.warn('Carrier poll failed; backing off', {
    shipmentId: row.id,
    carrierCode: row.carrierCode,
    failures,
    reason,
  });
}

async function pollGroup(connection, rows, now, outcome) {
  const { adapter, account, credentials } = connection;
  if (adapter.capabilities.bulkStatus) {
    for (let i = 0; i < rows.length; i += BULK_CHUNK) {
      const chunk = rows.slice(i, i + BULK_CHUNK);
      let results;
      try {
        results = await accounts.withAuthHandling(account, () =>
          adapter.getShipments(credentials, chunk.map((r) => r.waybillNumber))
        );
      } catch (err) {
        for (const row of chunk) await pollFailed(adapter, row, now, outcome, err.message);
        continue;
      }
      for (const row of chunk) {
        const result = results.get(row.waybillNumber);
        if (result) await pollSucceeded(adapter, row, result, now, outcome);
        else await pollFailed(adapter, row, now, outcome, 'not in the carrier\'s bulk answer');
      }
    }
    return;
  }
  for (const row of rows) {
    let result;
    try {
      result = await accounts.withAuthHandling(account, () => adapter.getShipment(credentials, row.waybillNumber));
    } catch (err) {
      await pollFailed(adapter, row, now, outcome, err.message);
      continue;
    }
    await pollSucceeded(adapter, row, result, now, outcome);
  }
}

// --- manual-cancel verification ----------------------------------------------------

function nextCancelCheck(row, now) {
  const ackAt = new Date(row.cancelAcknowledgedAt).getTime();
  const next = CANCEL_CHECKS_MS.map((ms) => ackAt + ms).find((at) => at > now.getTime());
  return next ? new Date(next) : null;
}

async function verifyCancel(connection, row, now, outcome) {
  const { adapter, account, credentials } = connection;
  const ackAt = new Date(row.cancelAcknowledgedAt).getTime();
  let result;
  try {
    result = await accounts.withAuthHandling(account, () => adapter.getShipment(credentials, row.waybillNumber));
  } catch (err) {
    const failures = row.pollFailures + 1;
    const retryAt = backoffAt(adapter, failures, now);
    const giveUp = retryAt.getTime() > ackAt + CANCEL_CHECK_WINDOW_MS;
    await setSchedule(row.id, { nextPollAt: giveUp ? null : retryAt, pollFailures: failures });
    outcome.failed += 1;
    logger.warn('Manual-cancel check could not read the carrier', {
      shipmentId: row.id,
      carrierCode: row.carrierCode,
      failures,
      gaveUp: giveUp,
      reason: err.message,
    });
    return;
  }

  const check = CANCEL_CHECKS_MS.filter((ms) => ackAt + ms <= now.getTime()).length || 1;
  if (STILL_ACTIVE.includes(result.status)) {
    await flagUnconfirmedCancel(row, result, { trigger: 'cancel_check', check });
    outcome.flagged += 1;
    logger.warn('Carrier still has a parcel the merchant cancelled by hand; order flagged', {
      shipmentId: row.id,
      orderId: row.orderId,
      carrierCode: row.carrierCode,
      reportedStatus: result.status,
    });
  } else {
    outcome.cancelConfirmed += 1;
  }
  await setSchedule(row.id, { nextPollAt: nextCancelCheck(row, now), lastPolledAt: now, pollFailures: 0 });
}

// --- the run --------------------------------------------------------------------

const isCancelCheck = (row) => row.status === 'cancelled' && row.cancelMode === 'manual_ack' && row.cancelAcknowledgedAt;

async function loadGroupConnection(workspaceId, carrierCode) {
  const adapter = await carriers.adapterFor(carrierCode, workspaceId);
  if (!adapter) return { stop: 'carrier_unavailable' };
  try {
    return { connection: await accounts.loadConnection(workspaceId, carrierCode) };
  } catch (err) {
    if (err.code === 'CARRIER_NOT_CONNECTED') return { stop: 'not_connected' };
    return { error: err };
  }
}

/**
 * One batch: claims up to `limit` due shipments and reads them.
 * @returns {{ claimed, changed, unchanged, failed, stopped, flagged, cancelConfirmed }}
 */
async function syncDueOnce({ limit = env.carriers.syncBatchSize, now = new Date() } = {}) {
  const outcome = { claimed: 0, changed: 0, unchanged: 0, failed: 0, stopped: 0, flagged: 0, cancelConfirmed: 0 };
  const rows = await claimDue({ limit, now });
  outcome.claimed = rows.length;

  const groups = new Map();
  for (const row of rows) {
    const key = `${row.workspaceId}:${row.carrierCode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  for (const group of groups.values()) {
    const { workspaceId, carrierCode } = group[0];
    const loaded = await loadGroupConnection(workspaceId, carrierCode);
    if (loaded.stop) {
      // The carrier is gone for this store, or the account was disconnected:
      // nothing left to read with.
      await db.Shipment.update({ nextPollAt: null }, { where: { id: group.map((r) => r.id) } });
      outcome.stopped += group.length;
      continue;
    }
    if (loaded.error) {
      for (const row of group) await pollFailed(null, row, now, outcome, loaded.error.message);
      continue;
    }

    const checks = group.filter(isCancelCheck);
    const regular = group.filter((row) => !isCancelCheck(row));
    for (const row of checks) await verifyCancel(loaded.connection, row, now, outcome);

    const pollable = [];
    for (const row of regular) {
      if (!loaded.connection.adapter.capabilities.polling || TERMINAL_STATUSES.includes(row.status)) {
        await setSchedule(row.id, { nextPollAt: null });
        outcome.stopped += 1;
      } else {
        pollable.push(row);
      }
    }
    if (pollable.length) await pollGroup(loaded.connection, pollable, now, outcome);
  }
  return outcome;
}

/** Batches until one comes back short (or `maxBatches`). */
async function syncDue({ limit = env.carriers.syncBatchSize, maxBatches = 20, now } = {}) {
  const batches = [];
  for (let i = 0; i < maxBatches; i += 1) {
    const batch = await syncDueOnce({ limit, now: now || new Date() });
    batches.push(batch);
    if (batch.claimed < limit) break;
  }
  const total = batches.reduce((sum, b) => {
    for (const [key, value] of Object.entries(b)) sum[key] = (sum[key] || 0) + value;
    return sum;
  }, {});
  return { batches: batches.length, ...total };
}

module.exports = {
  syncDue,
  syncDueOnce,
  FLAG_CANCEL_UNCONFIRMED,
  STILL_ACTIVE,
};
