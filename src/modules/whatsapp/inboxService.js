'use strict';

const { Op, QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { NotFoundError, ValidationError, ConflictError } = require('../../core/errors/AppError');
const { PERMISSIONS } = require('../../core/security/permissions');
const { recordAudit } = require('../audit/auditService');
const { STAGE_SQL, ORDERS_WITH_STAGE_FROM } = require('../orders/orderStage');
const inboxEvents = require('./inboxEvents');

/**
 * What the WhatsApp inbox needs beyond sending and reading messages
 * (whatsappService.js): who owns a conversation, the filters of the list,
 * the customer panel beside a thread, and the store's saved quick replies.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_QUICK_REPLIES = 100;

const userView = (u) => (u ? { id: u.id, fullName: u.fullName } : null);

function conversationView(c, assignees) {
  return {
    id: c.id,
    phone: c.phoneNormalized,
    customerName: c.customerName,
    customerId: c.customerId,
    status: c.status,
    unreadCount: c.unreadCount,
    lastMessageAt: c.lastMessageAt,
    lastMessagePreview: c.lastMessagePreview,
    canReply: Boolean(c.lastInboundAt && Date.now() - new Date(c.lastInboundAt).getTime() < WINDOW_MS),
    // The customer service bot is quiet here: a teammate took over, or it handed the conversation over.
    botPaused: Boolean(c.botPausedAt),
    assignedTo: c.assignedToUserId ? userView(assignees.get(c.assignedToUserId)) || { id: c.assignedToUserId, fullName: null } : null,
  };
}

async function usersById(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const users = await db.User.findAll({ where: { id: unique }, attributes: ['id', 'fullName'] });
  return new Map(users.map((u) => [u.id, u]));
}

/**
 * The conversation list with the inbox filters: open/closed, assigned to me,
 * unassigned, unread — and how many of each wait, for the filter badges.
 */
async function listConversations(workspaceId, userId, { status, assigned, unread, search, limit = 50, before } = {}) {
  const where = { workspaceId };
  if (status) where.status = status;
  if (assigned === 'me') where.assignedToUserId = userId;
  if (assigned === 'none') where.assignedToUserId = null;
  if (unread) where.unreadCount = { [Op.gt]: 0 };
  if (search) {
    const digits = search.replace(/\D/g, '');
    where[Op.or] = [...(digits ? [{ phoneNormalized: { [Op.iLike]: `%${digits}%` } }] : []), { customerName: { [Op.iLike]: `%${search}%` } }];
  }
  if (before) where.lastMessageAt = { [Op.lt]: new Date(before) };
  const rows = await db.WhatsappConversation.findAll({ where, order: [['lastMessageAt', 'DESC NULLS LAST']], limit });
  const assignees = await usersById(rows.map((c) => c.assignedToUserId));

  const [counts] = await db.sequelize.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open,
            COUNT(*) FILTER (WHERE status = 'open' AND assigned_to_user_id = :userId)::int AS mine,
            COUNT(*) FILTER (WHERE status = 'open' AND unread_count > 0)::int AS unread
       FROM whatsapp_conversations WHERE workspace_id = :workspaceId`,
    { replacements: { workspaceId, userId }, type: QueryTypes.SELECT }
  );

  return {
    conversations: rows.map((c) => conversationView(c, assignees)),
    nextCursor: rows.length === limit && rows[rows.length - 1].lastMessageAt ? rows[rows.length - 1].lastMessageAt.toISOString() : null,
    counts,
  };
}

async function findConversation(workspaceId, conversationId, options = {}) {
  const conversation = await db.WhatsappConversation.findOne({ where: { id: conversationId, workspaceId }, ...options });
  if (!conversation) throw new NotFoundError('Conversation');
  return conversation;
}

/** Teammates who can be given a conversation: anyone who may work the inbox. */
async function listAssignees(workspaceId) {
  const memberships = await db.Membership.findAll({
    where: { workspaceId, status: 'active', userId: { [Op.ne]: null } },
    include: [
      { model: db.Role, as: 'role' },
      { model: db.User, as: 'user', attributes: ['id', 'fullName'] },
    ],
  });
  return memberships
    .filter((m) => m.user && (m.role.permissions.includes('*') || m.role.permissions.includes(PERMISSIONS.ORDERS_CONFIRM)))
    .map((m) => ({ id: m.user.id, fullName: m.user.fullName, role: m.role.name }))
    .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
}

async function assign(workspaceId, conversationId, assigneeUserId, req) {
  if (assigneeUserId) {
    const allowed = await listAssignees(workspaceId);
    if (!allowed.some((u) => u.id === assigneeUserId)) {
      throw new ValidationError([{ field: 'userId', message: 'This teammate cannot work the inbox' }], 'Invalid body');
    }
  }
  const conversation = await db.sequelize.transaction(async (transaction) => {
    const c = await findConversation(workspaceId, conversationId, { transaction, lock: transaction.LOCK.UPDATE });
    const before = c.assignedToUserId;
    if (before !== assigneeUserId) {
      await c.update({ assignedToUserId: assigneeUserId || null }, { transaction });
      await recordAudit({
        workspaceId,
        actorUserId: req.user.id,
        action: 'whatsapp.conversation.assign',
        entityType: 'WhatsappConversation',
        entityId: c.id,
        req,
        before: { assignedToUserId: before },
        after: { assignedToUserId: assigneeUserId || null },
        transaction,
      });
    }
    return c;
  });
  inboxEvents.publish(workspaceId, { conversationId: conversation.id, reason: 'assignment' });
  return conversationView(conversation, await usersById([conversation.assignedToUserId]));
}

/**
 * The panel beside a thread: who this is, how their past orders went, and
 * their latest orders with the stage the orders screen shows.
 */
async function customerPanel(workspaceId, conversationId) {
  const conversation = await findConversation(workspaceId, conversationId);
  const customer = await db.Customer.findOne({ where: { workspaceId, phoneNormalized: conversation.phoneNormalized } });
  if (customer && !conversation.customerId) await conversation.update({ customerId: customer.id }, { silent: true });
  if (!customer) return { customer: null, stats: null, orders: [] };

  const orders = await db.sequelize.query(
    `SELECT o.id, o.order_number AS "orderNumber", o.total_amount AS "totalAmount", o.currency,
            o.payment_method AS "paymentMethod", o.created_at AS "createdAt", ${STAGE_SQL} AS stage
       FROM ${ORDERS_WITH_STAGE_FROM}
      WHERE o.workspace_id = :workspaceId AND o.customer_id = :customerId
      ORDER BY o.created_at DESC`,
    { replacements: { workspaceId, customerId: customer.id }, type: QueryTypes.SELECT }
  );
  const count = (stage) => orders.filter((o) => o.stage === stage).length;
  const delivered = count('delivered');
  // Of the orders that reached an end, how many were delivered.
  const finished = delivered + count('cancelled') + count('returned') + count('delivery_failed');
  // Known only from locked orders (orders/orderLock): the name and e-mail hidden. The
  // number is the conversation's own, which the merchant is already writing to.
  const orderLock = require('../orders/orderLock');
  const lockCtx = await orderLock.contextFor(workspaceId);
  const hidden = (await orderLock.lockedCustomerIds(lockCtx, workspaceId, [customer.id])).has(customer.id);

  return {
    customer: {
      id: customer.id,
      fullName: hidden ? conversation.customerName || orderLock.MASK : customer.fullName || conversation.customerName,
      phone: customer.phoneNormalized,
      email: hidden ? customer.email && orderLock.MASK : customer.email || null,
      isBlacklisted: Boolean(customer.isBlacklisted),
      ...(lockCtx.enabled ? { contactLocked: hidden } : {}),
    },
    stats: {
      totalOrders: orders.length,
      delivered,
      cancelled: count('cancelled'),
      returned: count('returned') + count('delivery_failed'),
      deliveryRate: finished > 0 ? Math.round((delivered / finished) * 100) : null,
    },
    orders: orders.slice(0, 5).map((o) => ({ ...o, totalAmount: String(o.totalAmount) })),
  };
}

// ------------------------------------------------------------ quick replies --

const quickReplyView = (r) => ({ id: r.id, title: r.title, body: r.body, createdAt: r.createdAt, updatedAt: r.updatedAt });

async function listQuickReplies(workspaceId) {
  const rows = await db.WhatsappQuickReply.findAll({ where: { workspaceId }, order: [['title', 'ASC']] });
  return { quickReplies: rows.map(quickReplyView), limit: MAX_QUICK_REPLIES };
}

async function createQuickReply(workspaceId, { title, body }, req) {
  if ((await db.WhatsappQuickReply.count({ where: { workspaceId } })) >= MAX_QUICK_REPLIES) {
    throw new ConflictError(`A store can have at most ${MAX_QUICK_REPLIES} quick replies`, 'QUICK_REPLY_LIMIT');
  }
  const row = await db.WhatsappQuickReply.create({ workspaceId, title, body, createdByUserId: req.user.id });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'whatsapp.quick_reply.create', entityType: 'WhatsappQuickReply', entityId: row.id, req, after: { title } });
  return quickReplyView(row);
}

async function updateQuickReply(workspaceId, id, patch, req) {
  const row = await db.WhatsappQuickReply.findOne({ where: { id, workspaceId } });
  if (!row) throw new NotFoundError('QuickReply');
  const before = { title: row.title };
  await row.update(patch);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'whatsapp.quick_reply.update', entityType: 'WhatsappQuickReply', entityId: row.id, req, before, after: { title: row.title } });
  return quickReplyView(row);
}

async function deleteQuickReply(workspaceId, id, req) {
  const row = await db.WhatsappQuickReply.findOne({ where: { id, workspaceId } });
  if (!row) throw new NotFoundError('QuickReply');
  await row.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'whatsapp.quick_reply.delete', entityType: 'WhatsappQuickReply', entityId: row.id, req, before: { title: row.title } });
  return { deleted: true };
}

module.exports = {
  listConversations,
  listAssignees,
  assign,
  customerPanel,
  listQuickReplies,
  createQuickReply,
  updateQuickReply,
  deleteQuickReply,
};
