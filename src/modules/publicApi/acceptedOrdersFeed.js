'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const orderService = require('../orders/orderService');
const { ACCEPTED_SQL, ACCEPTED_AT_SQL, VIA_SQL } = require('../orders/orderAccepted');
const { serializeOrders } = require('./publicOrderOptions');

/**
 * The accepted orders an API key has not acknowledged yet (PUBLIC_API_ACK_ENABLED):
 * how a till or kitchen system that cannot receive webhooks — it sits behind
 * a local network — takes new orders. It asks every few seconds, takes each
 * order, and acknowledges it (POST /public/orders/ack); an acknowledged order
 * is not offered to that key again, and an order it crashed before
 * acknowledging is offered again. Each key has its own receipts: two systems
 * with two keys both get every order.
 *
 *   GET /public/orders/accepted?since=&limit=&cursor=
 *
 * "Accepted" is orders/orderAccepted.js: confirmed (COD, manual transfer) or
 * paid online, not cancelled. Oldest acceptance first. `since` (ISO time,
 * default the later of the key's creation and 7 days ago, at most 30 days
 * back) bounds how far back the feed looks, so a new key does not receive the
 * store's history. `cursor` pages through one answer without acknowledging;
 * an integration that acknowledges what it took can always ask from the start.
 *
 * Only the key's own store, by construction: every query names the key's
 * workspace, and a receipt is written only for an order of that workspace.
 */

const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const encodeCursor = (row) => Buffer.from(JSON.stringify({ at: row.accepted_at_key, id: row.id })).toString('base64url');

// Postgres' own text of a timestamptz: 2026-10-24 12:30:05.123456+00 (or +05:30).
const PG_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:[+-](\d{2})(?::?(\d{2}))?|Z)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A time Postgres will cast without an error: real calendar date, real clock time, real offset. */
function validTime(text) {
  const m = PG_TIME.exec(text);
  if (!m) return false;
  const [year, month, day, hour, minute, second, offHour = '0', offMinute = '0'] = m.slice(1).map((v) => (v === undefined ? undefined : Number(v)));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  return hour < 24 && minute < 60 && second < 60 && Number(offHour) < 16 && Number(offMinute) < 60;
}

/**
 * The cursor handed out by a previous answer, or 400 INVALID_CURSOR. Checked
 * whole here, so a cursor someone edited is refused before the database ever
 * casts it (a time like 2026-13-45 would otherwise fail inside Postgres).
 */
function decodeCursor(cursor) {
  try {
    const value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    // `at` is Postgres' own text of the time (microseconds and all), handed back as it was given.
    if (value && typeof value.at === 'string' && validTime(value.at) && typeof value.id === 'string' && UUID.test(value.id)) return value;
  } catch {
    // fall through
  }
  throw new AppError('INVALID_CURSOR', 'Invalid cursor: use nextCursor exactly as a previous answer gave it', 400);
}

function windowStart(apiKey, since, now) {
  const earliest = new Date(now.getTime() - MAX_LOOKBACK_DAYS * DAY_MS);
  if (since) {
    const at = new Date(since);
    if (at < earliest) throw new ValidationError([{ field: 'since', message: `"since" can go back at most ${MAX_LOOKBACK_DAYS} days` }]);
    return at;
  }
  const lookback = new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * DAY_MS);
  return new Date(Math.max(lookback.getTime(), new Date(apiKey.createdAt).getTime()));
}

async function listUnacked(workspaceId, apiKey, { since, limit = 50, cursor } = {}, { now = new Date() } = {}) {
  const from = windowStart(apiKey, since, now);
  const after = cursor ? decodeCursor(cursor) : null;
  const rows = await db.sequelize.query(
    `SELECT o.id, ${ACCEPTED_AT_SQL} AS accepted_at, (${ACCEPTED_AT_SQL})::text AS accepted_at_key, ${VIA_SQL} AS via
       FROM orders o
      WHERE o.workspace_id = :workspaceId
        -- What the index (workspace_id, updated_at) serves (migration 719). Safe as a
        -- first cut: confirmed_at and completed_at are written by Sequelize updates
        -- that move updated_at with them, so an order accepted since :from was
        -- updated since :from.
        AND o.updated_at >= :from
        AND o.archived_at IS NULL
        AND ${ACCEPTED_SQL}
        AND ${ACCEPTED_AT_SQL} >= :from
        AND NOT EXISTS (SELECT 1 FROM api_key_order_acks k WHERE k.api_key_id = :apiKeyId AND k.order_id = o.id)
        ${after ? `AND (${ACCEPTED_AT_SQL}, o.id) > (CAST(:afterAt AS timestamptz), CAST(:afterId AS uuid))` : ''}
      ORDER BY 2, o.id
      LIMIT :limit`,
    {
      replacements: { workspaceId, apiKeyId: apiKey.id, from, limit: limit + 1, afterAt: after ? after.at : null, afterId: after ? after.id : null },
      type: QueryTypes.SELECT,
    }
  );
  const page = rows.slice(0, limit);
  // The page read whole the way the orders list reads it (ids ≤ 100), then put back in feed order.
  const loaded = page.length ? (await orderService.listOrders(workspaceId, { ids: page.map((r) => r.id).join(','), limit: page.length, archived: 'include' })).orders : [];
  const byId = new Map((await serializeOrders(workspaceId, loaded)).map((o) => [o.id, o]));
  const orders = page.filter((r) => byId.has(r.id)).map((r) => ({ ...byId.get(r.id), acceptedAt: r.accepted_at, acceptedVia: r.via }));
  return { orders, nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null, since: from.toISOString() };
}

/**
 * Records that this key received these orders. Orders of another store, or
 * that do not exist, are listed as `unknown` and nothing is written for them.
 * Acknowledging twice keeps the first time.
 */
async function acknowledge(workspaceId, apiKey, orderIds) {
  const ids = [...new Set(orderIds)];
  const own = await db.Order.findAll({ where: { id: ids, workspaceId }, attributes: ['id'] });
  const known = new Set(own.map((o) => o.id));
  if (known.size > 0) {
    await db.ApiKeyOrderAck.bulkCreate(
      [...known].map((orderId) => ({ apiKeyId: apiKey.id, orderId })),
      { ignoreDuplicates: true }
    );
  }
  const rows = known.size ? await db.ApiKeyOrderAck.findAll({ where: { apiKeyId: apiKey.id, orderId: [...known] } }) : [];
  return {
    acked: rows.map((r) => ({ orderId: r.orderId, ackedAt: r.ackedAt })),
    unknown: ids.filter((id) => !known.has(id)),
  };
}

/** One order: 404 when it is not this store's. */
async function acknowledgeOne(workspaceId, apiKey, orderId) {
  const result = await acknowledge(workspaceId, apiKey, [orderId]);
  if (result.acked.length === 0) throw new NotFoundError('Order');
  return result.acked[0];
}

module.exports = { listUnacked, acknowledge, acknowledgeOne, decodeCursor, MAX_LOOKBACK_DAYS, DEFAULT_LOOKBACK_DAYS };
