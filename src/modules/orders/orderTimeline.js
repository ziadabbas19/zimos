'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const { STAGE_SQL, ORDERS_WITH_STAGE_FROM } = require('./orderStage');
const { orderSort, orderByClause, anchorValue } = require('./orderSort');
const { applyOrderFilters } = require('./orderFilters');
const statusHistory = require('./orderStatusHistory');
const orderLock = require('./orderLock');

/**
 * GET /orders/:id/timeline — everything that happened to one order, in one
 * list, newest first (SPEC §4.4 card 11): its moves between stages, what
 * staff did to it and its shipments (the audit log), the notes written on
 * it, the automation messages sent for it, the webhooks delivered for it,
 * what the courier reported for its shipments (shipment_events) and, with
 * STORE_FEATURES order_messages, the messages the customer was sent about it —
 * order emails and SMS (notification_logs.order_id, migration 665) and WhatsApp
 * messages from the store's number (whatsapp_messages.order_id).
 *
 * Read-only and assembled per request from the tables that already record
 * these things; nothing is copied into a timeline table.
 */

// Audit rows the status history already tells better.
const SKIPPED_AUDIT_ACTIONS = [
  'order.confirmation_state_change',
  'order.fulfillment_state_change',
  'order.create',
  'order.cancel',
  'order.reopen',
  'order.note_add',
  'order.note_delete',
];

// The parts of an audit row's state worth showing; the rest stays in the audit log.
const AUDIT_FIELDS = [
  'status',
  'carrierCode',
  'waybillNumber',
  'financialState',
  'amount',
  'amountPaid',
  'totalAmount',
  'tags',
  'isTest',
  'cancellationReason',
  'paymentMethod',
  'providerCode',
];

function pickFields(state) {
  if (!state || typeof state !== 'object') return null;
  const out = {};
  for (const key of AUDIT_FIELDS) if (state[key] !== undefined && state[key] !== null) out[key] = state[key];
  return Object.keys(out).length ? out : null;
}

async function timeline(workspaceId, orderId) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id'] });
  if (!order) throw new NotFoundError('Order');

  const shipments = await db.Shipment.findAll({ where: { workspaceId, orderId }, attributes: ['id'] });
  const shipmentIds = shipments.map((s) => s.id);

  const withMessages = require('../../core/middleware/storeFeatures').storeFeatureOn('order_messages');
  const [history, audits, notes, runs, deliveries, courier, sentLogs, whatsapps] = await Promise.all([
    statusHistory.listForOrder(workspaceId, orderId),
    db.sequelize.query(
      `SELECT a.id, a.action, a.entity_type, a.actor_user_id, a.before_state, a.after_state, a.metadata, a.created_at,
              u.full_name AS actor_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.workspace_id = :workspaceId
          AND a.action NOT IN (:skipped)
          AND ((a.entity_type = 'Order' AND a.entity_id = :orderId)
            OR (a.entity_type = 'Shipment' AND a.entity_id IN (:shipmentIds)))
        ORDER BY a.created_at DESC
        LIMIT 300`,
      {
        replacements: { workspaceId, orderId, skipped: SKIPPED_AUDIT_ACTIONS, shipmentIds: shipmentIds.length ? shipmentIds : [''] },
        type: QueryTypes.SELECT,
      }
    ),
    db.OrderNote.findAll({
      where: { workspaceId, orderId },
      include: [{ model: db.User, as: 'author', attributes: ['id', 'fullName'] }],
    }),
    db.AutomationRun.findAll({ where: { workspaceId, orderId }, order: [['createdAt', 'DESC']], limit: 100 }),
    db.sequelize.query(
      `SELECT d.id, d.event_type, d.status, d.attempt_count, d.last_response_status, d.created_at
         FROM webhook_deliveries d
        WHERE d.workspace_id = :workspaceId AND d.payload::text LIKE :needle
        ORDER BY d.created_at DESC
        LIMIT 100`,
      { replacements: { workspaceId, needle: `%${orderId}%` }, type: QueryTypes.SELECT }
    ),
    require('../shipping/shipmentEvents').listForOrder(workspaceId, orderId),
    withMessages
      ? db.NotificationLog.findAll({
          where: { workspaceId, orderId },
          attributes: ['id', 'channel', 'template', 'subject', 'status', 'error', 'deliveryStatus', 'statusAt', 'statusReason', 'createdAt'],
          order: [['createdAt', 'DESC']],
          limit: 100,
        })
      : [],
    withMessages
      ? db.sequelize.query(
          `SELECT m.id, m.type, m.body, m.template_name, m.status, m.error, m.sent_by_bot, m.created_at, u.full_name AS actor_name
             FROM whatsapp_messages m
             LEFT JOIN users u ON u.id = m.sent_by_user_id
            WHERE m.workspace_id = :workspaceId AND m.order_id = :orderId AND m.direction = 'out'
            ORDER BY m.created_at DESC
            LIMIT 100`,
          { replacements: { workspaceId, orderId }, type: QueryTypes.SELECT }
        )
      : [],
  ]);

  const events = [];
  for (const h of history) {
    events.push({
      id: `status:${h.id}`,
      type: 'status',
      at: h.createdAt,
      actor: { type: h.actorType, name: h.actorName },
      data: { from: h.fromStatus, to: h.toStatus, reason: h.reason },
    });
  }
  for (const a of audits) {
    // A shipment update that only moved its status is the stage change above it.
    const statusMove =
      a.action === 'shipment.update' && a.before_state && a.after_state && a.before_state.status !== a.after_state.status;
    if (statusMove && a.before_state.waybillNumber === a.after_state.waybillNumber) continue;
    const source = a.metadata && a.metadata.source;
    events.push({
      id: `audit:${a.id}`,
      type: 'audit',
      at: a.created_at,
      actor: a.actor_user_id
        ? { type: 'user', name: a.actor_name }
        : { type: source === 'carrier' ? 'carrier' : 'system', name: null },
      data: {
        action: a.action,
        entity: a.entity_type === 'Shipment' ? 'shipment' : 'order',
        before: pickFields(a.before_state),
        after: pickFields(a.after_state),
      },
    });
  }
  for (const n of notes) {
    events.push({
      id: `note:${n.id}`,
      type: 'note',
      at: n.createdAt,
      actor: { type: 'user', name: n.author ? n.author.fullName : null },
      data: { body: n.body, visibility: n.visibility },
    });
  }
  for (const r of runs) {
    events.push({
      id: `automation:${r.id}`,
      type: 'automation',
      at: r.createdAt,
      actor: { type: 'system', name: null },
      data: { trigger: r.trigger, status: r.status, detail: r.detail || null },
    });
  }
  for (const d of deliveries) {
    events.push({
      id: `webhook:${d.id}`,
      type: 'webhook',
      at: d.created_at,
      actor: { type: 'system', name: null },
      data: { eventType: d.event_type, status: d.status, attempts: d.attempt_count, responseStatus: d.last_response_status },
    });
  }

  // What the courier reported, state by state (shipment_events).
  for (const c of courier) {
    events.push({
      id: `courier:${c.id}`,
      type: 'courier',
      at: c.occurredAt,
      actor: { type: 'carrier', name: null },
      data: { carrierCode: c.carrierCode, status: c.status, carrierStatusCode: c.carrierStatusCode, description: c.description, shipmentId: c.shipmentId },
    });
  }

  // Messages to the customer: what went out, on which channel, and whether the provider took it.
  // While the order is locked (orders/orderLock) their text and subjects are hidden: they were
  // written to the customer, by name, before it locked.
  const locked = await orderLock.isOrderLocked(workspaceId, orderId);
  const said = (text) => (locked && text ? orderLock.MASK : text);
  for (const m of sentLogs) {
    events.push({
      id: `message:${m.id}`,
      type: 'message',
      at: m.createdAt,
      actor: { type: 'system', name: null },
      data: { channel: m.channel, template: m.template, subject: said(m.subject), status: m.status, error: m.error, deliveryStatus: m.deliveryStatus || null, statusAt: m.statusAt || null, statusReason: m.statusReason || null },
    });
    // What the provider reported later, at its own time: "email bounced", "SMS not delivered" (deliveryStatus/).
    if (['bounced', 'complained', 'undelivered'].includes(m.deliveryStatus) && m.statusAt) {
      events.push({
        id: `message_status:${m.id}`,
        type: 'message_status',
        at: m.statusAt,
        actor: { type: 'system', name: null },
        data: { channel: m.channel, status: m.deliveryStatus, reason: m.statusReason || null, subject: said(m.subject), messageId: m.id },
      });
    }
  }
  for (const w of whatsapps) {
    events.push({
      id: `whatsapp:${w.id}`,
      type: 'message',
      at: w.created_at,
      actor: w.actor_name ? { type: 'user', name: w.actor_name } : { type: 'system', name: null },
      data: {
        channel: 'whatsapp',
        template: w.template_name || null,
        subject: w.body ? said(String(w.body).slice(0, 300)) : null,
        // received / delivered / read when WhatsApp reported them.
        status: w.status,
        error: w.error || null,
        bot: Boolean(w.sent_by_bot),
      },
    });
  }

  events.sort((a, b) => new Date(b.at) - new Date(a.at) || (a.id < b.id ? 1 : -1));
  return events;
}

/**
 * GET /orders/:id/neighbors — the orders before and after this one in the
 * list the merchant came from: same filters, same search, same sort.
 * `applySearch` is orderService's search/date conditions, passed in because
 * orderService requires this module's siblings.
 */
async function neighbors(workspaceId, orderId, query, applySearch) {
  const { sort: sortKey, stage, q, from, to, ...filters } = query;
  const anchor = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id', 'createdAt', 'totalAmount'] });
  if (!anchor) throw new NotFoundError('Order');

  const sort = orderSort(sortKey);
  const conditions = ['o.workspace_id = $workspaceId'];
  const bind = { workspaceId, anchorValue: anchorValue(sort, anchor), anchorId: anchor.id };
  applyOrderFilters(conditions, bind, filters);
  if (stage) {
    conditions.push(`${STAGE_SQL} = $stage`);
    bind.stage = stage;
  }
  applySearch(conditions, bind, { q, from, to });

  const pair = `(${sort.column}, o.id)`;
  const anchorPair = `($anchorValue::${sort.cast}, $anchorId::uuid)`;
  const after = sort.direction === 'DESC' ? '<' : '>';
  const before = sort.direction === 'DESC' ? '>' : '<';
  const reversed = { ...sort, direction: sort.direction === 'DESC' ? 'ASC' : 'DESC' };

  const one = async (comparison, ordering) => {
    const rows = await db.sequelize.query(
      `SELECT o.id FROM ${ORDERS_WITH_STAGE_FROM}
        WHERE ${conditions.join(' AND ')} AND ${pair} ${comparison} ${anchorPair}
        ORDER BY ${orderByClause(ordering, 'o.id')}
        LIMIT 1`,
      { bind, type: QueryTypes.SELECT }
    );
    return rows.length ? rows[0].id : null;
  };

  return { prevId: await one(before, reversed), nextId: await one(after, sort) };
}

module.exports = { timeline, neighbors };
