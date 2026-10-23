'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * Support tickets between a workspace and the platform team.
 *
 * Merchant side (/workspaces/:workspaceId/support/tickets): open a ticket,
 * read the workspace's tickets, reply. Admin side (/admin/support/tickets):
 * the platform queue, replies, status and priority.
 *
 * Status moves (see migration 104):
 *   merchant opens            -> open
 *   admin replies             -> pending (or the status the admin picks)
 *   merchant replies          -> open    (re-opens a resolved ticket)
 *   closed                    -> nobody may reply; an admin may re-open it
 *
 * Every write is audited against the ticket's workspace, whichever side made
 * it, so the admin audit log's workspace filter finds the whole conversation.
 * Message bodies are not copied into audit rows — only their length.
 *
 * The merchant never sees who on the platform team answered: admin messages
 * are signed "Zimos support". The admin side sees the name.
 */

const STATUSES = ['open', 'pending', 'resolved', 'closed'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
// The queue's order: the most pressing priority first (listAllTickets).
const PRIORITY_RANK_SQL = db.sequelize.literal(
  `CASE "SupportTicket"."priority" WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`
);
const CATEGORIES = ['general', 'billing', 'orders', 'shipping', 'payments', 'technical', 'account'];

const MERCHANT_LIST_CAP = 100;
const ADMIN_LIMIT_DEFAULT = 50;
const ADMIN_LIMIT_MAX = 200;

const WITH_AUTHOR = { model: db.User, as: 'author', attributes: ['id', 'fullName', 'email'], required: false };

function serializeTicket(ticket, { admin = false, messageCount } = {}) {
  return {
    id: ticket.id,
    workspaceId: ticket.workspaceId,
    ...(admin
      ? {
          workspaceName: ticket.workspace ? ticket.workspace.name : null,
          workspaceSlug: ticket.workspace ? ticket.workspace.slug : null,
        }
      : {}),
    subject: ticket.subject,
    category: ticket.category,
    status: ticket.status,
    priority: ticket.priority,
    createdBy: ticket.createdBy ? ticket.createdBy.fullName || ticket.createdBy.email : null,
    ...(admin && ticket.createdBy ? { createdByEmail: ticket.createdBy.email } : {}),
    lastMessageAt: ticket.lastMessageAt,
    lastMessageBy: ticket.lastMessageBy,
    ...(messageCount !== undefined ? { messageCount } : {}),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

function serializeMessage(message, { admin = false } = {}) {
  const fromAdmin = message.authorType === 'admin';
  let authorName;
  if (fromAdmin && !admin) authorName = 'Zimos support';
  else authorName = message.author ? message.author.fullName || message.author.email : null;
  return {
    id: message.id,
    authorType: message.authorType,
    authorName,
    ...(admin && message.author ? { authorEmail: message.author.email } : {}),
    body: message.body,
    createdAt: message.createdAt,
  };
}

async function messagesOf(ticketId, admin, transaction) {
  const rows = await db.SupportTicketMessage.findAll({
    where: { ticketId },
    include: [WITH_AUTHOR],
    order: [
      ['createdAt', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction,
  });
  return rows.map((m) => serializeMessage(m, { admin }));
}

async function messageCounts(ticketIds) {
  if (ticketIds.length === 0) return new Map();
  const rows = await db.SupportTicketMessage.findAll({
    where: { ticketId: ticketIds },
    attributes: ['ticketId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'count']],
    group: ['ticketId'],
    raw: true,
  });
  return new Map(rows.map((r) => [r.ticketId, Number(r.count)]));
}

const TICKET_INCLUDES = [{ model: db.User, as: 'createdBy', attributes: ['id', 'fullName', 'email'], required: false }];
const ADMIN_TICKET_INCLUDES = [
  ...TICKET_INCLUDES,
  { model: db.Workspace, as: 'workspace', attributes: ['id', 'name', 'slug'], required: false },
];

/** Row-locked; no include (FOR UPDATE refuses the outer joins). */
async function lockTicket(where, transaction) {
  const ticket = await db.SupportTicket.findOne({ where, transaction, lock: transaction.LOCK.UPDATE });
  if (!ticket) throw new NotFoundError('Support ticket');
  return ticket;
}

async function reloadTicket(id, admin, transaction) {
  return db.SupportTicket.findByPk(id, { include: admin ? ADMIN_TICKET_INCLUDES : TICKET_INCLUDES, transaction });
}

function assertOpenForReplies(ticket) {
  if (ticket.status === 'closed') {
    throw new ConflictError('This ticket is closed. Open a new ticket if you still need help.', 'TICKET_CLOSED');
  }
}

// ------------------------------------------------------------------ merchant

async function listWorkspaceTickets(workspaceId) {
  const tickets = await db.SupportTicket.findAll({
    where: { workspaceId },
    include: TICKET_INCLUDES,
    order: [
      ['lastMessageAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: MERCHANT_LIST_CAP,
  });
  const counts = await messageCounts(tickets.map((t) => t.id));
  return tickets.map((t) => serializeTicket(t, { messageCount: counts.get(t.id) || 0 }));
}

/**
 * A store with priority_support (its plan, or a console grant) opens its
 * tickets at high priority; everyone else at normal. Only the queue's order
 * and badge change: the merchant is promised nothing and shown nothing new.
 * A failed lookup opens the ticket at normal priority rather than not at all.
 */
async function openingPriority(workspaceId, transaction) {
  const prioritised = await require('../billing/entitlementsService')
    .hasFeature(workspaceId, 'priority_support', { transaction })
    .catch(() => false);
  return prioritised ? 'high' : 'normal';
}

async function openTicket(workspaceId, { subject, body, category }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const now = new Date();
    const priority = await openingPriority(workspaceId, transaction);
    const ticket = await db.SupportTicket.create(
      {
        workspaceId,
        createdByUserId: req.user.id,
        subject,
        category: category || 'general',
        status: 'open',
        priority,
        lastMessageAt: now,
        lastMessageBy: 'merchant',
      },
      { transaction }
    );
    await db.SupportTicketMessage.create(
      { ticketId: ticket.id, authorUserId: req.user.id, authorType: 'merchant', body },
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'support_ticket.create',
      entityType: 'SupportTicket',
      entityId: ticket.id,
      after: { subject, category: ticket.category, status: 'open', priority, bodyLength: body.length },
      req,
      transaction,
    });
    return {
      ticket: serializeTicket(await reloadTicket(ticket.id, false, transaction), { messageCount: 1 }),
      messages: await messagesOf(ticket.id, false, transaction),
    };
  });
}

async function getWorkspaceTicket(workspaceId, ticketId) {
  const ticket = await db.SupportTicket.findOne({ where: { id: ticketId, workspaceId }, include: TICKET_INCLUDES });
  if (!ticket) throw new NotFoundError('Support ticket');
  const messages = await messagesOf(ticket.id, false);
  return { ticket: serializeTicket(ticket, { messageCount: messages.length }), messages };
}

async function merchantReply(workspaceId, ticketId, { body }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const ticket = await lockTicket({ id: ticketId, workspaceId }, transaction);
    assertOpenForReplies(ticket);

    const before = { status: ticket.status };
    const message = await db.SupportTicketMessage.create(
      { ticketId, authorUserId: req.user.id, authorType: 'merchant', body },
      { transaction }
    );
    await ticket.update({ status: 'open', lastMessageAt: message.createdAt, lastMessageBy: 'merchant' }, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'support_ticket.reply',
      entityType: 'SupportTicket',
      entityId: ticketId,
      before,
      after: { status: 'open', bodyLength: body.length },
      metadata: { messageId: message.id },
      req,
      transaction,
    });
    await message.reload({ include: [WITH_AUTHOR], transaction });
    return {
      message: serializeMessage(message),
      ticket: serializeTicket(await reloadTicket(ticketId, false, transaction)),
    };
  });
}

// --------------------------------------------------------------------- admin

async function listAllTickets({ status, priority, workspaceId, q, limit = ADMIN_LIMIT_DEFAULT, offset = 0 } = {}) {
  const where = {};
  if (status) where.status = status;
  if (priority) where.priority = priority;
  if (workspaceId) where.workspaceId = workspaceId;
  if (q) where.subject = { [Op.iLike]: `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` };

  const cappedLimit = Math.min(limit, ADMIN_LIMIT_MAX);
  const { rows, count } = await db.SupportTicket.findAndCountAll({
    where,
    include: ADMIN_TICKET_INCLUDES,
    // Urgent and high tickets first, whatever the filter; then the queue
    // reads oldest-waiting first within a status tab, and across all tabs
    // the most recently active first is the more useful default.
    order: [
      [PRIORITY_RANK_SQL, 'ASC'],
      ...(status === 'open' ? [['lastMessageAt', 'ASC'], ['id', 'ASC']] : [['lastMessageAt', 'DESC'], ['id', 'DESC']]),
    ],
    limit: cappedLimit,
    offset,
    distinct: true,
  });

  // The tab badges: every status, under the same non-status filters.
  const countWhere = { ...where };
  delete countWhere.status;
  const byStatus = await db.SupportTicket.findAll({
    where: countWhere,
    attributes: ['status', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'count']],
    group: ['status'],
    raw: true,
  });
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of byStatus) counts[row.status] = Number(row.count);

  const messages = await messageCounts(rows.map((t) => t.id));
  return {
    tickets: rows.map((t) => serializeTicket(t, { admin: true, messageCount: messages.get(t.id) || 0 })),
    total: count,
    limit: cappedLimit,
    offset,
    counts,
  };
}

async function getTicketForAdmin(ticketId) {
  const ticket = await reloadTicket(ticketId, true);
  if (!ticket) throw new NotFoundError('Support ticket');
  const messages = await messagesOf(ticketId, true);
  return { ticket: serializeTicket(ticket, { admin: true, messageCount: messages.length }), messages };
}

/**
 * A platform reply. The ticket moves to `status` when one is given (e.g.
 * reply-and-resolve), otherwise to `pending` — waiting on the merchant.
 */
async function adminReply(ticketId, { body, status }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const ticket = await lockTicket({ id: ticketId }, transaction);
    assertOpenForReplies(ticket);

    const before = { status: ticket.status };
    const message = await db.SupportTicketMessage.create(
      { ticketId, authorUserId: req.user.id, authorType: 'admin', body },
      { transaction }
    );
    const nextStatus = status || 'pending';
    await ticket.update({ status: nextStatus, lastMessageAt: message.createdAt, lastMessageBy: 'admin' }, { transaction });
    await recordAudit({
      workspaceId: ticket.workspaceId,
      actorUserId: req.user.id,
      action: 'support_ticket.admin_reply',
      entityType: 'SupportTicket',
      entityId: ticketId,
      before,
      after: { status: nextStatus, bodyLength: body.length },
      metadata: { messageId: message.id },
      req,
      transaction,
    });
    await message.reload({ include: [WITH_AUTHOR], transaction });
    return {
      message: serializeMessage(message, { admin: true }),
      ticket: serializeTicket(await reloadTicket(ticketId, true, transaction), { admin: true }),
    };
  });
}

/** Status and/or priority. A no-op change writes no audit row. */
async function updateTicket(ticketId, input, req) {
  return db.sequelize.transaction(async (transaction) => {
    const ticket = await lockTicket({ id: ticketId }, transaction);
    const fields = {};
    if (input.status !== undefined && input.status !== ticket.status) fields.status = input.status;
    if (input.priority !== undefined && input.priority !== ticket.priority) fields.priority = input.priority;

    if (Object.keys(fields).length > 0) {
      const before = Object.fromEntries(Object.keys(fields).map((k) => [k, ticket[k]]));
      await ticket.update(fields, { transaction });
      await recordAudit({
        workspaceId: ticket.workspaceId,
        actorUserId: req.user.id,
        action: 'support_ticket.update',
        entityType: 'SupportTicket',
        entityId: ticketId,
        before,
        after: fields,
        req,
        transaction,
      });
    }
    return serializeTicket(await reloadTicket(ticketId, true, transaction), { admin: true });
  });
}

module.exports = {
  STATUSES,
  PRIORITIES,
  CATEGORIES,
  listWorkspaceTickets,
  openTicket,
  getWorkspaceTicket,
  merchantReply,
  listAllTickets,
  getTicketForAdmin,
  adminReply,
  updateTicket,
};
