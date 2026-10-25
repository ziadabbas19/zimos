'use strict';

const crypto = require('crypto');
const net = require('net');
const { Op } = require('sequelize');
const db = require('../../db/models');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const { recordAudit } = require('../audit/auditService');
const visitorGate = require('../risk/visitorGate');
const orderLock = require('../orders/orderLock');

/**
 * The store's blacklist (`blocked_entries`, migration 140).
 *
 * An entry blocks one identifier for one scope:
 *
 *   orders  an order carrying it is flagged `blacklisted_customer`, and
 *           refused when the store's rules say blocked customers are refused
 *   otp     no verification code is sent to it
 *   visit   the visitor does not see the store at all
 *
 * A (phone, orders) entry and customers.is_blacklisted are one fact kept in
 * two places: blocking a customer writes the entry (syncFromCustomer), and
 * adding or deleting the entry updates the customer if that phone has one.
 * Neither path calls the other's service, so there is no loop.
 */

const TYPES = ['phone', 'ip', 'email', 'device', 'name_address'];
const SCOPES = ['orders', 'otp', 'visit'];

const LIST_LIMIT_DEFAULT = 50;
const IMPORT_MAX_ROWS = 2000;

const WITH_AUTHOR = [{ model: db.User, as: 'createdBy', attributes: ['id', 'fullName', 'email'], required: false }];

function invalid(field, message) {
  return new ValidationError([{ field, message }]);
}

/** Lowercase, Arabic letter forms folded, punctuation and repeated spaces dropped. */
function normalizeText(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function normalizeIp(raw) {
  const ip = String(raw || '').trim().toLowerCase().replace(/^::ffff:/, '');
  return net.isIP(ip) ? ip : null;
}

/** The value a name + address pair is stored and matched under, or null when either is blank. */
function nameAddressValue(name, address) {
  const n = normalizeText(name);
  const a = normalizeText(address);
  if (!n || !a) return null;
  return crypto.createHash('sha256').update(`${n}|${a}`).digest('hex');
}

/**
 * The (value, label) an identifier is stored under. Throws a 422 naming the
 * field when the input cannot be that kind of identifier.
 */
function normalizeIdentifier({ type, value, name, address }) {
  if (type === 'phone') {
    const phone = normalizePhone(value);
    if (!phone) throw invalid('value', 'Enter a valid phone number');
    return { value: phone, label: String(value).trim() };
  }
  if (type === 'ip') {
    const ip = normalizeIp(value);
    if (!ip) throw invalid('value', 'Enter a valid IP address');
    return { value: ip, label: ip };
  }
  if (type === 'email') {
    const email = String(value || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) throw invalid('value', 'Enter a valid email address');
    return { value: email, label: email };
  }
  if (type === 'device') {
    const device = String(value || '').trim();
    if (device.length < 8 || device.length > 128) throw invalid('value', 'Enter a device ID of 8 to 128 characters');
    return { value: device, label: device };
  }
  if (type === 'name_address') {
    const hashed = nameAddressValue(name, address);
    if (!hashed) throw invalid('name', 'Enter both a name and an address');
    return { value: hashed, label: `${String(name).trim()} — ${String(address).trim()}`.slice(0, 600) };
  }
  throw invalid('type', 'Unknown entry type');
}

function serializeEntry(entry, customerId = null) {
  return {
    id: entry.id,
    type: entry.type,
    value: entry.value,
    label: entry.label,
    scope: entry.scope,
    reason: entry.reason,
    createdById: entry.createdByUserId,
    createdBy: entry.createdBy ? entry.createdBy.fullName || entry.createdBy.email : null,
    createdAt: entry.createdAt,
    // The customer a phone entry belongs to, when that phone has ordered.
    customerId,
  };
}

function auditState(entry) {
  return { type: entry.type, value: entry.value, label: entry.label, scope: entry.scope, reason: entry.reason };
}

// True for an entry that is not the phone of a customer who comes hidden (orders/orderLock.customerVisibleSql).
const phoneShownSql = (ctx) => `("BlockedEntry"."type" <> 'phone' OR NOT EXISTS (
  SELECT 1 FROM customers bc
   WHERE bc.workspace_id = "BlockedEntry"."workspace_id" AND bc.phone_normalized = "BlockedEntry"."value"
     AND NOT ${orderLock.customerVisibleSql(ctx, 'bc')}))`;

async function customerIdsByPhone(workspaceId, entries, transaction) {
  const phones = entries.filter((e) => e.type === 'phone').map((e) => e.value);
  if (phones.length === 0) return new Map();
  const customers = await db.Customer.findAll({
    where: { workspaceId, phoneNormalized: phones },
    attributes: ['id', 'phoneNormalized'],
    transaction,
  });
  return new Map(customers.map((c) => [c.phoneNormalized, c.id]));
}

/**
 * Newest first, keyset-paged: `cursor` is the last entry id of the previous
 * page. `counts` is the number of entries per type under the same scope
 * filter, for the type chips of the screen.
 */
async function listEntries(workspaceId, { type, scope, q, limit = LIST_LIMIT_DEFAULT, cursor } = {}) {
  const lockCtx = await orderLock.contextFor(workspaceId);
  const where = { workspaceId };
  if (type) where.type = type;
  if (scope) where.scope = scope;
  if (q) {
    const term = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const phone = normalizePhone(q);
    const byNumber = [
      { label: { [Op.iLike]: term } },
      { value: { [Op.iLike]: term } },
      ...(phone ? [{ type: 'phone', value: phone }] : []),
    ];
    where[Op.or] = [
      { reason: { [Op.iLike]: term } },
      // The phone of a customer who comes hidden (orders/orderLock) is never found by its number.
      orderLock.isOpenContext(lockCtx) ? { [Op.or]: byNumber } : { [Op.and]: [{ [Op.or]: byNumber }, db.sequelize.literal(phoneShownSql(lockCtx))] },
    ];
  }
  const and = [];
  if (cursor) {
    const anchor = await db.BlockedEntry.findOne({ where: { id: cursor, workspaceId }, attributes: ['id', 'createdAt'] });
    if (!anchor) throw invalid('cursor', 'Unknown cursor');
    and.push({
      [Op.or]: [{ createdAt: { [Op.lt]: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { [Op.lt]: anchor.id } }],
    });
  }
  if (and.length) where[Op.and] = and;

  const [rows, grouped] = await Promise.all([
    db.BlockedEntry.findAll({
      where,
      include: WITH_AUTHOR,
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: limit + 1,
    }),
    db.BlockedEntry.findAll({
      where: { workspaceId, ...(scope ? { scope } : {}) },
      attributes: ['type', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'count']],
      group: ['type'],
      raw: true,
    }),
  ]);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const customers = await customerIdsByPhone(workspaceId, page);
  const hidden = await orderLock.lockedCustomerIds(lockCtx, workspaceId, [...customers.values()]);
  const counts = Object.fromEntries(TYPES.map((t) => [t, 0]));
  for (const row of grouped) counts[row.type] = Number(row.count);

  return {
    entries: page.map((e) => {
      const customerId = e.type === 'phone' ? customers.get(e.value) || null : null;
      if (!customerId || !hidden.has(customerId)) return serializeEntry(e, customerId);
      // A hidden customer's phone: the entry shows, its number and the customer do not.
      return { ...serializeEntry(e, null), value: orderLock.MASK, label: e.label ? orderLock.MASK : e.label, contactLocked: true };
    }),
    nextCursor: hasMore ? page[page.length - 1].id : null,
    counts,
  };
}

/**
 * Mirrors a (phone, orders) entry onto the customer with that phone, if the
 * store has one. A phone that never ordered needs no customer row: order
 * creation reads the entries themselves (findOrderMatch).
 */
async function mirrorOntoCustomer(workspaceId, phoneNormalized, { blocked, reason }, transaction) {
  const customer = await db.Customer.findOne({ where: { workspaceId, phoneNormalized }, transaction });
  if (!customer) return null;
  if (blocked) {
    await customer.update(
      {
        isBlacklisted: true,
        blacklistReason: reason || customer.blacklistReason,
        blacklistedAt: customer.isBlacklisted && customer.blacklistedAt ? customer.blacklistedAt : new Date(),
      },
      { transaction }
    );
  } else if (customer.isBlacklisted) {
    await customer.update({ isBlacklisted: false, blacklistReason: null, blacklistedAt: null }, { transaction });
  }
  return customer;
}

/** Inserts the entry, or updates the reason of the one already there. No audit: the callers write it. */
async function upsertEntry(workspaceId, { type, scope, value, label, reason }, userId, transaction) {
  const [entry, created] = await db.BlockedEntry.findOrCreate({
    where: { workspaceId, type, scope, value },
    defaults: { workspaceId, type, scope, value, label, reason: reason || null, createdByUserId: userId || null },
    transaction,
  });
  if (!created && reason && reason !== entry.reason) await entry.update({ reason }, { transaction });
  return { entry, created };
}

/**
 * Blocks one identifier for one or more scopes. Returns the entries in the
 * order of `scopes`, and `created: true` when at least one of them is new.
 */
async function addEntry(workspaceId, { type = 'phone', value, name, address, scope, scopes, reason }, req) {
  const wanted = [...new Set(scopes && scopes.length ? scopes : [scope || 'orders'])];
  const identifier = normalizeIdentifier({ type, value, name, address });

  return db.sequelize.transaction(async (transaction) => {
    const entries = [];
    let anyCreated = false;
    let customerId = null;
    for (const entryScope of wanted) {
      const { entry, created } = await upsertEntry(
        workspaceId,
        { type, scope: entryScope, ...identifier, reason },
        req.user.id,
        transaction
      );
      if (type === 'phone' && entryScope === 'orders') {
        const customer = await mirrorOntoCustomer(workspaceId, identifier.value, { blocked: true, reason }, transaction);
        if (customer) customerId = customer.id;
      }
      if (created) {
        anyCreated = true;
        await recordAudit({
          workspaceId,
          actorUserId: req.user.id,
          action: 'blocklist.entry_added',
          entityType: 'BlockedEntry',
          entityId: entry.id,
          after: auditState(entry),
          req,
          transaction,
        });
      }
      entries.push(entry);
    }
    // A customer who comes hidden is not named: the answer would tie the typed phone to them (orders/orderLock).
    if (customerId && (await orderLock.lockedCustomerIds(await orderLock.contextFor(workspaceId, { transaction }), workspaceId, [customerId], { transaction })).size > 0) {
      customerId = null;
    }
    return { created: anyCreated, entries: entries.map((e) => serializeEntry(e, e.type === 'phone' ? customerId : null)) };
  }).then((result) => {
    visitorGate.forgetWorkspace(workspaceId);
    return result;
  });
}

async function removeEntry(workspaceId, entryId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const entry = await db.BlockedEntry.findOne({ where: { id: entryId, workspaceId }, transaction });
    if (!entry) throw new NotFoundError('Blocked entry');
    const before = auditState(entry);
    await entry.destroy({ transaction });
    if (entry.type === 'phone' && entry.scope === 'orders') {
      await mirrorOntoCustomer(workspaceId, entry.value, { blocked: false }, transaction);
    }
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'blocklist.entry_removed',
      entityType: 'BlockedEntry',
      entityId: entryId,
      before,
      req,
      transaction,
    });
    return { success: true };
  }).then((result) => {
    visitorGate.forgetWorkspace(workspaceId);
    return result;
  });
}

/**
 * Called by customerService.applyBlacklist, inside its transaction when it
 * has one: keeps the (phone, orders) entry in step with the customer.
 */
async function syncFromCustomer(customer, { isBlacklisted, reason }, req, transaction) {
  const key = { workspaceId: customer.workspaceId, type: 'phone', scope: 'orders', value: customer.phoneNormalized };
  if (!isBlacklisted) {
    await db.BlockedEntry.destroy({ where: key, transaction });
    return;
  }
  await upsertEntry(
    customer.workspaceId,
    { ...key, label: customer.phoneRaw || customer.phoneNormalized, reason },
    req && req.user ? req.user.id : null,
    transaction
  );
}

// ------------------------------------------------------------------ import --

/** Splits CSV text into rows of fields. Handles quotes, doubled quotes, CRLF and `;` as a separator. */
function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const separator = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === separator) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((f) => f.trim())).filter((r) => r.some((f) => f !== ''));
}

const HEADER_NAMES = ['type', 'value', 'phone', 'ip', 'email', 'scope', 'reason', 'name', 'address'];

/**
 * Imports entries from CSV text. With a header row the columns are read by
 * name (type, value, scope, reason, name, address; `phone`, `ip` and `email`
 * are accepted in place of `value`). Without one, the first column is the
 * value and the second, if present, the reason. Missing type, scope and
 * reason fall back to the defaults of the request.
 *
 * Bad lines are reported and skipped; the rest are imported.
 */
async function importCsv(workspaceId, { csv, type: defaultType = 'phone', scope: defaultScope = 'orders', reason: defaultReason }, req) {
  const rows = parseCsv(csv);
  if (rows.length === 0) throw invalid('csv', 'The file is empty');

  const first = rows[0].map((f) => f.toLowerCase());
  const hasHeader = first.some((f) => HEADER_NAMES.includes(f));
  const columns = hasHeader ? first : null;
  const dataRows = hasHeader ? rows.slice(1) : rows;
  if (dataRows.length > IMPORT_MAX_ROWS) throw invalid('csv', `A file can hold at most ${IMPORT_MAX_ROWS} rows`);

  const pick = (row, name) => {
    if (!columns) return undefined;
    const index = columns.indexOf(name);
    return index === -1 ? undefined : row[index] || undefined;
  };

  const result = { imported: 0, updated: 0, skipped: 0, errors: [] };
  await db.sequelize.transaction(async (transaction) => {
    for (let i = 0; i < dataRows.length; i += 1) {
      const row = dataRows[i];
      const line = i + (hasHeader ? 2 : 1);
      try {
        const type = (pick(row, 'type') || defaultType).toLowerCase();
        const scope = (pick(row, 'scope') || defaultScope).toLowerCase();
        if (!TYPES.includes(type)) throw invalid('type', `Unknown type "${type}"`);
        if (!SCOPES.includes(scope)) throw invalid('scope', `Unknown scope "${scope}"`);
        const value = columns ? pick(row, 'value') || pick(row, type) : row[0];
        const reason = (columns ? pick(row, 'reason') : row[1]) || defaultReason || null;
        const identifier = normalizeIdentifier({ type, value, name: pick(row, 'name'), address: pick(row, 'address') });
        const { created } = await upsertEntry(
          workspaceId,
          { type, scope, ...identifier, reason: reason ? reason.slice(0, 300) : null },
          req.user.id,
          transaction
        );
        if (type === 'phone' && scope === 'orders') {
          await mirrorOntoCustomer(workspaceId, identifier.value, { blocked: true, reason }, transaction);
        }
        if (created) result.imported += 1;
        else result.updated += 1;
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        result.skipped += 1;
        if (result.errors.length < 50) result.errors.push({ line, message: err.details[0].message });
      }
    }
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'blocklist.imported',
      entityType: 'BlockedEntry',
      after: { imported: result.imported, updated: result.updated, skipped: result.skipped },
      req,
      transaction,
    });
  });
  visitorGate.forgetWorkspace(workspaceId);
  return result;
}

// ---------------------------------------------------------------- matching --

/**
 * The first entry of `scope` that matches any of the given identifiers, or
 * null. Every identifier is optional; raw values are normalized here.
 */
async function findMatch(workspaceId, scope, { phoneNormalized, phone, email, ip, deviceId, fullName, addressLine } = {}, transaction) {
  const pairs = [];
  const phoneValue = phoneNormalized || (phone ? normalizePhone(phone) : null);
  if (phoneValue) pairs.push({ type: 'phone', value: phoneValue });
  if (email) pairs.push({ type: 'email', value: String(email).trim().toLowerCase() });
  const ipValue = ip ? normalizeIp(ip) : null;
  if (ipValue) pairs.push({ type: 'ip', value: ipValue });
  if (deviceId) pairs.push({ type: 'device', value: String(deviceId).trim() });
  const nameAddress = nameAddressValue(fullName, addressLine);
  if (nameAddress) pairs.push({ type: 'name_address', value: nameAddress });
  if (pairs.length === 0) return null;

  return db.BlockedEntry.findOne({ where: { workspaceId, scope, [Op.or]: pairs }, transaction });
}

module.exports = {
  TYPES,
  SCOPES,
  IMPORT_MAX_ROWS,
  normalizeIp,
  normalizeText,
  normalizeIdentifier,
  listEntries,
  addEntry,
  removeEntry,
  importCsv,
  syncFromCustomer,
  findMatch,
};
