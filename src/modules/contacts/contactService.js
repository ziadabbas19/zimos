'use strict';

const db = require('../../db/models');
const { QueryTypes } = require('sequelize');
const { scoped } = require('../../core/utils/scopedRepository');
const { normalizePhone } = require('../../core/utils/phone');
const { AppError, NotFoundError, ConflictError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { rulesSchema, STATS_CTE, DELIVERY_RATE_SQL, toSql } = require('./segmentRules');

/**
 * Contacts (SPEC §18.4): the customers table read as "everyone the store
 * knows" — buyers and leads — with their order facts computed from the live
 * orders (segmentRules.STATS_CTE) rather than kept in counters that drift.
 */

const MAX_TAGS = 50;
const EXPORT_LIMIT = 10000;

/** Trimmed, lower-cased, de-duplicated; a tag is at most 60 characters. */
function cleanTags(tags) {
  const seen = new Set();
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
    if (tag) seen.add(tag);
  }
  return [...seen].slice(0, MAX_TAGS);
}

function encodeCursor(row) {
  return Buffer.from(`${new Date(row.created_at).toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor) {
  const [at, id] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new AppError('INVALID_CURSOR', 'The cursor is not valid', 400);
  }
  return { at, id };
}

function view(row) {
  const orders = row.orders_count || 0;
  return {
    id: row.id,
    type: orders > 0 ? 'customer' : 'lead',
    fullName: row.full_name,
    phoneNormalized: row.phone_normalized,
    phoneRaw: row.phone_raw,
    email: row.email,
    tags: row.tags || [],
    source: row.source,
    marketingConsent: row.marketing_consent,
    isBlacklisted: row.is_blacklisted,
    ordersCount: orders,
    totalSpent: String(row.total_spent || 0),
    lastOrderAt: row.last_order_at || null,
    deliveredCount: row.delivered_count || 0,
    closedCount: row.closed_count || 0,
    deliveryRate: row.delivery_rate === null || row.delivery_rate === undefined ? null : Number(row.delivery_rate),
    governorate: row.governorate || null,
    createdAt: row.created_at,
  };
}

async function loadSegmentRules(workspaceId, segmentId) {
  const segment = await scoped(db.Segment, workspaceId, 'Segment').findByPkOrThrow(segmentId);
  const { value } = rulesSchema.validate(segment.rules || {}, { stripUnknown: true });
  return value;
}

/** WHERE clause + replacements shared by the list, the count and the export. */
async function buildFilter(workspaceId, { q, type, tag, consent, segmentId, rules } = {}) {
  const conditions = ['c.workspace_id = :workspaceId'];
  const replacements = { workspaceId };

  const add = (built) => {
    conditions.push(...built.conditions);
    Object.assign(replacements, built.replacements);
  };
  add(toSql({ type, includeTags: tag ? [String(tag).trim().toLowerCase()] : undefined, marketingConsent: consent }, 'f'));
  if (segmentId) add(toSql(await loadSegmentRules(workspaceId, segmentId), 'seg'));
  if (rules) add(toSql(rules, 'adhoc'));

  const text = String(q || '').trim();
  if (text) {
    const parts = ['c.full_name ILIKE :qLike', 'c.email ILIKE :qLike'];
    replacements.qLike = `%${text.replace(/[\\%_]/g, '\\$&')}%`;
    const digits = text.replace(/\D/g, '');
    if (digits.length >= 3) {
      parts.push('c.phone_normalized LIKE :qPhone');
      // A local number typed with its leading 0 is stored with the country code.
      replacements.qPhone = `%${digits.replace(/^0+/, '')}%`;
    }
    // Never found by the details it hides (orders/orderLock; TRUE while nothing is locked).
    const orderLock = require('../orders/orderLock');
    const visible = orderLock.customerVisibleSql(await orderLock.contextFor(workspaceId), 'c');
    conditions.push(visible === 'TRUE' ? `(${parts.join(' OR ')})` : `(${parts.join(' OR ')}) AND ${visible}`);
  }
  return { where: conditions.join('\n       AND '), replacements };
}

const SELECT_SQL = `SELECT c.id, c.full_name, c.phone_normalized, c.phone_raw, c.email, c.tags, c.source,
           c.marketing_consent, c.is_blacklisted, c.created_at,
           s.orders_count, s.total_spent, s.last_order_at, s.delivered_count, s.closed_count, s.governorate,
           ${DELIVERY_RATE_SQL} AS delivery_rate
      FROM customers c
      LEFT JOIN stats s ON s.customer_id = c.id`;

async function listContacts(workspaceId, params = {}) {
  const limit = params.limit || 50;
  const { where, replacements } = await buildFilter(workspaceId, params);

  let page = '';
  if (params.cursor) {
    const { at, id } = decodeCursor(params.cursor);
    page = 'AND (c.created_at, c.id) < (:cursorAt, :cursorId)';
    Object.assign(replacements, { cursorAt: at, cursorId: id });
  }

  const rows = await db.sequelize.query(
    `WITH ${STATS_CTE}
     ${SELECT_SQL}
     WHERE ${where} ${page}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT :limit`,
    { replacements: { ...replacements, limit: limit + 1 }, type: QueryTypes.SELECT }
  );
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);

  // A contact known only from locked orders comes hidden (orders/orderLock).
  const contacts = await require('../orders/orderLock').presentCustomers(workspaceId, pageRows.map(view));
  const result = { contacts, nextCursor: hasMore ? encodeCursor(pageRows[pageRows.length - 1]) : null };
  // The total and the lead/customer split belong to the first page only.
  if (!params.cursor) Object.assign(result, await countContacts(workspaceId, params));
  return result;
}

async function countContacts(workspaceId, params = {}) {
  const { where, replacements } = await buildFilter(workspaceId, params);
  const [row] = await db.sequelize.query(
    `WITH ${STATS_CTE}
     SELECT COUNT(*)::int AS total,
            (COUNT(*) FILTER (WHERE COALESCE(s.orders_count, 0) = 0))::int AS leads,
            (COUNT(*) FILTER (WHERE c.marketing_consent))::int AS consenting
       FROM customers c
       LEFT JOIN stats s ON s.customer_id = c.id
      WHERE ${where}`,
    { replacements, type: QueryTypes.SELECT }
  );
  return { total: row.total, leads: row.leads, customers: row.total - row.leads, consenting: row.consenting };
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // A cell a spreadsheet would run as a formula is made plain text.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function exportContacts(workspaceId, params, req) {
  const { where, replacements } = await buildFilter(workspaceId, params);
  const rows = await db.sequelize.query(
    `WITH ${STATS_CTE}
     ${SELECT_SQL}
     WHERE ${where}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ${EXPORT_LIMIT}`,
    { replacements, type: QueryTypes.SELECT }
  );
  const header = ['name', 'phone', 'email', 'type', 'tags', 'orders', 'total_spent', 'last_order_at', 'delivery_rate', 'governorate', 'marketing_consent', 'source', 'created_at'];
  // Hidden contacts export as •••• (orders/orderLock).
  const shown = await require('../orders/orderLock').presentCustomers(workspaceId, rows.map(view));
  const lines = shown.map((c) =>
    [
      c.fullName,
      c.phoneNormalized,
      c.email,
      c.type,
      c.tags.join('; '),
      c.ordersCount,
      (Number(c.totalSpent) / 100).toFixed(2),
      c.lastOrderAt ? new Date(c.lastOrderAt).toISOString() : '',
      c.deliveryRate === null ? '' : c.deliveryRate,
      c.governorate,
      c.marketingConsent ? 'yes' : 'no',
      c.source,
      new Date(c.createdAt).toISOString(),
    ]
      .map(csvCell)
      .join(',')
  );
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'contact.export',
    entityType: 'Customer',
    metadata: { rows: rows.length, segmentId: params.segmentId || null },
    req,
  });
  // BOM so Excel reads the Arabic names as UTF-8.
  return `﻿${[header.join(','), ...lines].join('\r\n')}\r\n`;
}

/** One contact with its order facts, latest form submissions and inbox thread. */
async function getContact(workspaceId, customerId) {
  const [row] = await db.sequelize.query(
    `WITH ${STATS_CTE}
     ${SELECT_SQL}
     WHERE c.workspace_id = :workspaceId AND c.id = :customerId`,
    { replacements: { workspaceId, customerId }, type: QueryTypes.SELECT }
  );
  if (!row) throw new NotFoundError('Customer');

  const [submissions, conversation] = await Promise.all([
    db.FormSubmission.findAll({
      where: { workspaceId, customerId },
      order: [['createdAt', 'DESC']],
      limit: 20,
    }),
    db.WhatsappConversation.findOne({ where: { workspaceId, phoneNormalized: row.phone_normalized }, attributes: ['id'] }),
  ]);
  return {
    contact: (await require('../orders/orderLock').presentCustomers(workspaceId, [view(row)]))[0],
    submissions: submissions.map(require('./formService').view),
    conversationId: conversation ? conversation.id : null,
  };
}

/** Adds a lead by hand. An existing phone is a conflict, not a silent merge. */
async function createContact(workspaceId, data, req) {
  const phoneNormalized = normalizePhone(data.phone);
  if (!phoneNormalized) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422);

  const existing = await db.Customer.findOne({ where: { workspaceId, phoneNormalized }, attributes: ['id'] });
  if (existing) {
    throw new AppError('PHONE_TAKEN', 'A contact with that phone number already exists', 409, { customerId: existing.id });
  }
  const customer = await db.Customer.create({
    workspaceId,
    phoneNormalized,
    phoneRaw: data.phone,
    fullName: data.fullName || null,
    email: data.email || null,
    marketingConsent: Boolean(data.marketingConsent),
    tags: cleanTags(data.tags),
    source: 'manual',
  });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'contact.create',
    entityType: 'Customer',
    entityId: customer.id,
    after: { phoneNormalized, tags: customer.tags },
    req,
  });
  return (await getContact(workspaceId, customer.id)).contact;
}

async function setTags(workspaceId, customerId, tags, req) {
  const customer = await scoped(db.Customer, workspaceId).findByPkOrThrow(customerId);
  const before = customer.tags || [];
  const after = cleanTags(tags);
  await customer.update({ tags: after });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'contact.tags_set',
    entityType: 'Customer',
    entityId: customer.id,
    before: { tags: before },
    after: { tags: after },
    req,
  });
  return after;
}

/** Adds and/or removes tags on many contacts at once. */
async function bulkTag(workspaceId, { customerIds, add = [], remove = [] }, req) {
  const adding = cleanTags(add);
  const removing = cleanTags(remove);
  const customers = await db.Customer.findAll({ where: { workspaceId, id: customerIds } });
  await db.sequelize.transaction(async (transaction) => {
    for (const customer of customers) {
      const next = cleanTags([...(customer.tags || []).filter((t) => !removing.includes(t)), ...adding]);
      await customer.update({ tags: next }, { transaction });
    }
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'contact.bulk_tag',
      entityType: 'Customer',
      metadata: { customerIds: customers.map((c) => c.id), add: adding, remove: removing },
      req,
      transaction,
    });
  });
  return { updated: customers.length };
}

/** Every tag in use, most used first — for pickers and the tag filter. */
async function listTags(workspaceId) {
  const rows = await db.sequelize.query(
    `SELECT t.tag, COUNT(*)::int AS count
       FROM customers c, UNNEST(c.tags) AS t(tag)
      WHERE c.workspace_id = :workspaceId
      GROUP BY t.tag
      ORDER BY count DESC, t.tag ASC
      LIMIT 500`,
    { replacements: { workspaceId }, type: QueryTypes.SELECT }
  );
  return { tags: rows };
}

// ------------------------------------------------------------- segments --

function segmentView(segment, counts) {
  return {
    id: segment.id,
    name: segment.name,
    description: segment.description,
    rules: segment.rules || {},
    createdAt: segment.createdAt,
    updatedAt: segment.updatedAt,
    ...(counts ? { contactsCount: counts.total, consentingCount: counts.consenting } : {}),
  };
}

async function listSegments(workspaceId) {
  const segments = await db.Segment.findAll({ where: { workspaceId }, order: [['createdAt', 'DESC']] });
  const counts = await Promise.all(segments.map((s) => countContacts(workspaceId, { segmentId: s.id })));
  return { segments: segments.map((s, i) => segmentView(s, counts[i])) };
}

async function saveSegment(workspaceId, segmentId, data, req) {
  const segment = segmentId ? await scoped(db.Segment, workspaceId, 'Segment').findByPkOrThrow(segmentId) : null;
  const before = segment ? segmentView(segment) : null;
  let saved;
  try {
    saved = segment
      ? await segment.update(data)
      : await db.Segment.create({ ...data, workspaceId, createdByUserId: req.user.id });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      throw new ConflictError('A segment with that name already exists', 'SEGMENT_NAME_TAKEN');
    }
    throw err;
  }
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: segment ? 'segment.update' : 'segment.create',
    entityType: 'Segment',
    entityId: saved.id,
    before,
    after: segmentView(saved),
    req,
  });
  return segmentView(saved, await countContacts(workspaceId, { segmentId: saved.id }));
}

async function deleteSegment(workspaceId, segmentId, req) {
  const segment = await scoped(db.Segment, workspaceId, 'Segment').findByPkOrThrow(segmentId);
  await segment.destroy();
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'segment.delete',
    entityType: 'Segment',
    entityId: segmentId,
    before: segmentView(segment),
    req,
  });
}

/** How many contacts a set of rules would match, before it is saved. */
async function previewSegment(workspaceId, rules) {
  const [counts, sample] = await Promise.all([
    countContacts(workspaceId, { rules }),
    listContacts(workspaceId, { rules, limit: 5, cursor: undefined }),
  ]);
  return { total: counts.total, consenting: counts.consenting, sample: sample.contacts };
}

/**
 * The contacts of a segment, for senders (automations, email sync):
 * `{ id, phoneNormalized, fullName, email, marketingConsent }[]`.
 */
async function resolveSegment(workspaceId, segmentId, { consentingOnly = true, limit = EXPORT_LIMIT } = {}) {
  const { where, replacements } = await buildFilter(workspaceId, {
    segmentId,
    consent: consentingOnly ? true : undefined,
  });
  const rows = await db.sequelize.query(
    `WITH ${STATS_CTE}
     ${SELECT_SQL}
     WHERE ${where} AND c.is_blacklisted = FALSE
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT :limit`,
    { replacements: { ...replacements, limit }, type: QueryTypes.SELECT }
  );
  return rows.map(view);
}

module.exports = {
  buildFilter,
  cleanTags,
  listContacts,
  countContacts,
  exportContacts,
  getContact,
  createContact,
  setTags,
  bulkTag,
  listTags,
  listSegments,
  saveSegment,
  deleteSegment,
  previewSegment,
  resolveSegment,
};
