'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../../db/models');
const logger = require('../../../core/utils/logger');
const queue = require('../../../core/queue');
const validate = require('../../../core/middleware/validate');
const { authenticate } = require('../../../core/middleware/authenticate');
const { resolveTenant } = require('../../../core/middleware/tenantContext');
const { requirePermission } = require('../../../core/middleware/rbac');
const { PERMISSIONS } = require('../../../core/security/permissions');
const { NotFoundError } = require('../../../core/errors/AppError');
const { recordAudit } = require('../../audit/auditService');
const inboxEvents = require('../inboxEvents');
const brain = require('./botBrain');
const { aiEnabled } = require('../../ai/aiGate');

/**
 * The customer service bot on WhatsApp (SPEC §19.3). It answers a customer's
 * message from the store's facts (botBrain.js) and hands the conversation to
 * a person when it cannot, when asked to, or when the customer is upset.
 *
 * settings.wa_bot: enabled, always_on, from/to ("HH:MM", the store's clock),
 * days (0 = Sunday), dialect, extra_info (what the merchant wants it to know).
 * It answers questions only: it does not take orders in the chat.
 * It stays quiet in a conversation a teammate took over (bot_paused_at, set
 * when they reply from the inbox or press "Take over") until someone lets it
 * answer again. Its replies count against the store's AI_DAILY_LIMIT; once
 * that is used up it hands the conversation to the team.
 *
 * While AI_ENABLED is off nothing is queued, a queued job sends nothing and
 * no message is ever marked sent_by_bot.
 *
 * Staff routes at /api/v1/workspaces/:workspaceId/wa-bot.
 */

const JOB = 'whatsapp.bot_reply';
const DIALECTS = ['egyptian', 'gulf', 'msa', 'english', 'french'];
const HHMM = Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/);

const settingsBody = Joi.object({
  enabled: Joi.boolean().required(),
  alwaysOn: Joi.boolean().default(true),
  from: HHMM.default('09:00'),
  to: HHMM.default('23:00'),
  days: Joi.array().items(Joi.number().integer().min(0).max(6)).unique().max(7).default([0, 1, 2, 3, 4, 5, 6]),
  dialect: Joi.string().valid(...DIALECTS).default('egyptian'),
  extraInfo: Joi.string().trim().max(2000).allow('', null),
});

function settingsOf(workspace) {
  const s = (workspace.settings && workspace.settings.wa_bot) || {};
  return {
    enabled: s.enabled === true,
    alwaysOn: s.always_on !== false,
    from: s.from || '09:00',
    to: s.to || '23:00',
    days: Array.isArray(s.days) ? s.days : [0, 1, 2, 3, 4, 5, 6],
    dialect: DIALECTS.includes(s.dialect) ? s.dialect : 'egyptian',
    extraInfo: typeof s.extra_info === 'string' ? s.extra_info : '',
  };
}

/** Within the bot's hours, on the store's clock. A from after to spans midnight. */
function isWorkingTime(settings, timezone, now = new Date()) {
  if (settings.alwaysOn) return true;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone || 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  if (!settings.days.includes(day)) return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  const from = toMin(settings.from);
  const to = toMin(settings.to);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

const monthStart = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
};

const aiService = () => require('../../ai/aiService'); // eslint-disable-line global-require

const repliesThisMonth = (workspaceId) =>
  db.WhatsappMessage.count({ where: { workspaceId, sentByBot: true, status: { [Op.ne]: 'failed' }, createdAt: { [Op.gte]: monthStart() } } });

/**
 * Queued by whatsappService.handleWebhook for every message a customer sends. Never throws.
 * One job per Meta message id (waMessageId), so a message Meta delivers twice is answered once.
 */
async function enqueue(workspaceId, conversationId, messageId, waMessageId = null) {
  try {
    if (!aiEnabled()) return false;
    const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
    if (!workspace || !settingsOf(workspace).enabled) return false;
    const dedupeKey = waMessageId ? `wabot:${workspaceId}:${waMessageId}` : `wabot:${messageId}`;
    await queue.add('ai', JOB, { conversationId, messageId }, { workspaceId, dedupeKey });
    return true;
  } catch (err) {
    logger.error(`[${JOB}] could not queue a reply for ${workspaceId}: ${err.message}`);
    return false;
  }
}

function tellTeam(workspace, conversation, reason) {
  // eslint-disable-next-line global-require
  require('../../notifications/merchantNotificationService')
    .create(workspace.id, {
      type: 'automation',
      title: `البوت حوّل محادثة ${conversation.customerName || conversation.phoneNormalized} ليكم`,
      body: reason,
      link: `/inbox?conversation=${conversation.id}`,
      data: { conversationId: conversation.id, bot: true },
      dedupeKey: `wabot.handoff:${conversation.id}:${new Date().toISOString().slice(0, 13)}`,
    })
    .catch((err) => logger.warn('Could not tell the team about a bot handoff', { workspaceId: workspace.id, message: err.message }));
}

async function process(job) {
  const { workspaceId } = job;
  const { conversationId, messageId } = job.payload || {};
  if (!aiEnabled()) return 'off';
  const [workspace, conversation, incoming] = await Promise.all([
    db.Workspace.findByPk(workspaceId),
    db.WhatsappConversation.findOne({ where: { id: conversationId, workspaceId } }),
    db.WhatsappMessage.findOne({ where: { id: messageId, workspaceId } }),
  ]);
  if (!workspace || !conversation || !incoming) return 'gone';
  const settings = settingsOf(workspace);
  if (!settings.enabled) return 'off';
  if (conversation.botPausedAt) return 'taken_over';
  if (!isWorkingTime(settings, workspace.timezone)) return 'off_hours';
  // A newer message is waiting: that one gets the answer.
  const newer = await db.WhatsappMessage.count({ where: { conversationId, direction: 'in', createdAt: { [Op.gt]: incoming.createdAt } } });
  if (newer > 0) return 'superseded';

  const limit = require('../../../config/env').ai.dailyLimit; // eslint-disable-line global-require
  if ((await aiService().usedToday(workspaceId)) >= limit) {
    await conversation.update({ botPausedAt: new Date() });
    tellTeam(workspace, conversation, `وصلتوا لحد طلبات الذكاء الاصطناعي النهارده (${limit}). المحادثة محتاجة رد منكم.`);
    return 'limit';
  }

  const history = (await db.WhatsappMessage.findAll({ where: { conversationId, createdAt: { [Op.lt]: incoming.createdAt } }, order: [['createdAt', 'DESC']], limit: 8 })).reverse();
  const result = await brain.answer({ workspace, settings, conversation, message: incoming.body || '', history });
  const { sendMessage } = require('../whatsappService'); // eslint-disable-line global-require
  const sent = await sendMessage(workspaceId, { to: conversation.phoneNormalized, text: result.text });
  await sent.update({ sentByBot: true });
  if (result.action === 'handoff') {
    await conversation.update({ botPausedAt: new Date(), status: 'open' });
    tellTeam(workspace, conversation, `آخر رسالة: «${String(incoming.body || '').slice(0, 140)}»`);
  }
  inboxEvents.publish(workspaceId, { conversationId, reason: 'bot' });
  return result.action;
}

// ---------------------------------------------------------------- routes --

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const manage = requirePermission(PERMISSIONS.WORKSPACE_MANAGE);
const talk = requirePermission(PERMISSIONS.ORDERS_CONFIRM);

async function loadWorkspace(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId);
  if (!workspace) throw new NotFoundError('Workspace');
  return workspace;
}

async function view(workspace) {
  // `limit`: no monthly limit of its own; the daily AI cap (aiService) applies.
  return { bot: settingsOf(workspace), usage: { repliesThisMonth: await repliesThisMonth(workspace.id), limit: null }, timezone: workspace.timezone };
}

router.get('/', talk, validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(await view(await loadWorkspace(req.tenant.workspaceId)))));

router.put(
  '/',
  manage,
  validate({ params: Joi.object(ws), body: settingsBody }),
  asyncHandler(async (req, res) => {
    const workspace = await loadWorkspace(req.tenant.workspaceId);
    const before = settingsOf(workspace);
    const b = req.body;
    const stored = { enabled: b.enabled, always_on: b.alwaysOn, from: b.from, to: b.to, days: b.days, dialect: b.dialect, extra_info: (b.extraInfo || '').trim() };
    await workspace.update({ settings: { ...(workspace.settings || {}), wa_bot: stored } });
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'whatsapp.bot_settings_update', entityType: 'Workspace', entityId: workspace.id, before, after: settingsOf(workspace), req });
    res.json(await view(workspace));
  })
);

// "Try it": the bot's answer to a sample message, as if from the merchant's own number. Nothing is sent.
router.post(
  '/preview',
  talk,
  validate({ params: Joi.object(ws), body: Joi.object({ message: Joi.string().trim().min(1).max(1000).required() }) }),
  asyncHandler(async (req, res) => {
    const workspace = await loadWorkspace(req.tenant.workspaceId);
    await aiService().assertDailyCap(workspace.id);
    const phone = (req.user.phone || '').replace(/\D/g, '');
    const result = await brain.answer({ workspace, settings: settingsOf(workspace), conversation: { phoneNormalized: phone || '-' }, message: req.body.message });
    res.json({ answer: result });
  })
);

// Take over (the bot stays quiet here) or let the bot answer again.
router.put(
  '/conversations/:conversationId',
  talk,
  validate({ params: Joi.object({ ...ws, conversationId: Joi.string().uuid().required() }), body: Joi.object({ paused: Joi.boolean().required() }) }),
  asyncHandler(async (req, res) => {
    const conversation = await db.WhatsappConversation.findOne({ where: { id: req.params.conversationId, workspaceId: req.tenant.workspaceId } });
    if (!conversation) throw new NotFoundError('Conversation');
    await conversation.update({ botPausedAt: req.body.paused ? new Date() : null, ...(req.body.paused ? {} : { botState: {} }) });
    inboxEvents.publish(req.tenant.workspaceId, { conversationId: conversation.id, reason: 'conversation' });
    res.json({ conversationId: conversation.id, botPaused: Boolean(conversation.botPausedAt) });
  })
);

module.exports = { router, enqueue, process, JOB, settingsOf, isWorkingTime };
