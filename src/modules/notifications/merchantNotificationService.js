'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { NotFoundError } = require('../../core/errors/AppError');
const { PERMISSIONS } = require('../../core/security/permissions');
const { recordAudit } = require('../audit/auditService');
const notify = require('./notify');
const pushConfig = require('./push/pushConfig');
const pushDigest = require('./push/pushDigest');

/**
 * Merchant notifications (SPEC §14.6): what the bell in the dashboard shows.
 *
 * A notification is created for a *store*, then delivered to each teammate
 * who (a) holds the permission its type needs — someone who cannot open
 * orders is not told about them — and (b) has not switched that type off.
 * Each teammate gets their own row, so "read" is theirs alone.
 *
 * Channels: `inApp` (the bell), `email` (the existing email provider),
 * `push` (device notifications, notifications/push: see offeredChannels) and `whatsapp` — from the platform's own
 * number to the teammate's verified phone (platformWhatsapp.js, its alert
 * template). WhatsApp is off for every type until the teammate turns it on.
 * A new channel is one more key in CHANNELS and one more branch in create().
 */

const CHANNELS = ['inApp', 'email', 'push', 'whatsapp'];
// The columns the settings screen shows. `push` only while device notifications
// are on (PUSH_ENABLED and a usable VAPID pair, push/pushConfig.js); off, a choice
// saved for it is kept, read and still saved, for when they are.
const WITHOUT_PUSH = CHANNELS.filter((channel) => channel !== 'push');
const offeredChannels = () => (pushConfig.isOn() ? CHANNELS : WITHOUT_PUSH);
// Device notifications (notifications/push) are on by default for what needs a
// quick look (decision 5 of REPORT-push-notifications.md); off for the rest,
// until the teammate turns them on. A choice saved before stays as it was.
const PUSH_ON = new Set(['order.new', 'order.paid', 'whatsapp.message', 'order.suspicious', 'integration.failed']);

/**
 * type → the permission needed to receive it (null = every teammate) and
 * the channels that are on until the teammate says otherwise.
 *   pushOnly   only the push channel exists for it (no bell row, no email)
 *   withPush   exists only while device notifications are on (pushConfig.isOn()):
 *              off, nothing creates it and the settings do not list it, so the
 *              bell is what it was before push
 */
const TYPES = Object.freeze({
  'order.new': { permission: PERMISSIONS.ORDERS_VIEW, defaults: { inApp: true, email: false } },
  // An order paid online or by a transfer whose proof was approved, not cash on delivery (merchantNotificationEvents.orderPaid).
  'order.paid': { permission: PERMISSIONS.ORDERS_VIEW, defaults: { inApp: true, email: false }, withPush: true },
  // A checkout that ended without an order: refused, or its online payment failed (checkoutSessions/lostOrderService).
  'lost_order.new': { permission: PERMISSIONS.ORDERS_VIEW, defaults: { inApp: true, email: false }, withPush: true },
  // A customer wrote on WhatsApp: the device is told, never what was written (the inbox shows it).
  'whatsapp.message': { permission: PERMISSIONS.ORDERS_CONFIRM, defaults: { inApp: false, email: false }, withPush: true, pushOnly: true },
  'order.suspicious': { permission: PERMISSIONS.ORDERS_VIEW, defaults: { inApp: true, email: false } },
  'stock.low': { permission: PERMISSIONS.INVENTORY_VIEW, defaults: { inApp: true, email: false } },
  'integration.failed': { permission: PERMISSIONS.WORKSPACE_MANAGE, defaults: { inApp: true, email: true } },
  // SPEC §4.3: the link comes in the bell and by email (orders/exportFiles.js).
  'export.ready': { permission: null, defaults: { inApp: true, email: true } },
  // A "Ship selected" batch finished (shipping/bulkShipping.js); sent to whoever started it.
  'shipping.batch_done': { permission: PERMISSIONS.ORDERS_MANAGE, defaults: { inApp: true, email: false } },
  announcement: { permission: null, defaults: { inApp: true, email: false } },
  // An automation's "notify the team" step (modules/automations).
  automation: { permission: PERMISSIONS.ORDERS_VIEW, defaults: { inApp: true, email: false } },
  // The prepaid balance on a plan with its own debt limit (billing/walletService).
  'wallet.low': { permission: PERMISSIONS.BILLING_MANAGE, defaults: { inApp: true, email: false } },
  'wallet.limit_reached': { permission: PERMISSIONS.BILLING_MANAGE, defaults: { inApp: true, email: false } },
  // A refund request of the prepaid balance changed status (billing/walletRefundService).
  'wallet.refund': { permission: PERMISSIONS.BILLING_MANAGE, defaults: { inApp: true, email: false } },
  // Credit given by Zimos, when the console chose to tell the store (billing/walletService.adjustBalance).
  'wallet.credit': { permission: PERMISSIONS.BILLING_MANAGE, defaults: { inApp: true, email: false } },
  // The subscription ended and the balance now pays per order (billing/walletFallbackService).
  'wallet.fallback': { permission: PERMISSIONS.BILLING_MANAGE, defaults: { inApp: true, email: false } },
  // A shopper asked a question on a product (modules/productQuestions).
  'product.question': { permission: PERMISSIONS.PRODUCTS_MANAGE, defaults: { inApp: true, email: false } },
  // An order's email bounced or was marked as spam, or its SMS was not delivered (deliveryStatus/).
  'message.undelivered': { permission: PERMISSIONS.ORDERS_VIEW, defaults: { inApp: true, email: false } },
});
const TYPE_NAMES = Object.keys(TYPES);

const roleAllows = (role, permission) =>
  !permission || role.permissions.includes('*') || role.permissions.includes(permission);

/** A type that is there now: always, or (withPush) only while device notifications are on. */
const typeLive = (type) => Boolean(TYPES[type]) && (!TYPES[type].withPush || pushConfig.isOn());

/** The stored choices laid over the defaults, for every type. A push-only type has no other channel. */
function resolveChannels(stored) {
  const saved = stored && typeof stored === 'object' ? stored : {};
  const out = {};
  for (const type of TYPE_NAMES) {
    out[type] = {};
    for (const channel of CHANNELS) {
      if (TYPES[type].pushOnly && channel !== 'push') {
        out[type][channel] = false;
        continue;
      }
      const fallback = TYPES[type].defaults[channel] ?? (channel === 'push' && PUSH_ON.has(type));
      const value = saved[type] && typeof saved[type][channel] === 'boolean' ? saved[type][channel] : fallback;
      out[type][channel] = value;
    }
  }
  return out;
}

function serialize(n) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    data: n.data || {},
    readAt: n.readAt,
    createdAt: n.createdAt,
  };
}

/** Rows this person sees in this store: their own and the team-wide ones. */
const inboxWhere = (workspaceId, userId) => ({ workspaceId, [Op.or]: [{ userId }, { userId: null }] });

/**
 * Creates a notification for a store and delivers it.
 *
 *   type       one of TYPE_NAMES
 *   title/body the text in the store's language (Arabic); `data` carries the
 *              values so the dashboard can render it in the viewer's language
 *   link       a dashboard path
 *   dedupeKey  the same key is delivered to a person at most once
 *   userIds    only these teammates (still subject to permission/preferences)
 *
 * Device notifications (push) go to each teammate whose `push` channel is on
 * for the type and who has a device; they are gathered for a few seconds and
 * sent as one (push/pushDigest.js), from an allowlist that never carries the
 * title, body or data given here. Nothing of it while push is off.
 *
 * Never throws: a notification must not fail the action that caused it.
 */
async function create(workspaceId, { type, title, body = null, link = null, data = {}, dedupeKey = null, userIds = null }) {
  try {
    const spec = TYPES[type];
    if (!spec) throw new Error(`unknown notification type "${type}"`);
    // A type that came with device notifications is not created while they are off.
    if (!typeLive(type)) return { created: 0, emailed: 0 };

    const where = { workspaceId, status: 'active', userId: userIds ? userIds : { [Op.ne]: null } };
    const memberships = await db.Membership.findAll({
      where,
      include: [
        { model: db.Role, as: 'role' },
        { model: db.User, as: 'user', attributes: ['id', 'email', 'phone', 'phoneVerifiedAt'] },
      ],
    });
    const members = memberships.filter((m) => m.user && roleAllows(m.role, spec.permission));
    if (members.length === 0) return { created: 0, emailed: 0 };

    const prefs = await db.NotificationPreference.findAll({ where: { workspaceId, userId: members.map((m) => m.userId) } });
    const prefsByUser = new Map(prefs.map((p) => [p.userId, p]));
    const channelsFor = (userId) => resolveChannels(prefsByUser.get(userId) && prefsByUser.get(userId).channels)[type];

    const rows = members
      .filter((m) => channelsFor(m.userId).inApp)
      .map((m) => ({
        workspaceId,
        userId: m.userId,
        type,
        title: String(title).slice(0, 200),
        body,
        link,
        data,
        dedupeKey,
      }));
    // A dedupe key this person already has is skipped (unique index).
    const deliveredTo = new Set();
    for (const row of rows) {
      try {
        await db.MerchantNotification.create(row);
        deliveredTo.add(row.userId);
      } catch (err) {
        if (err.name !== 'SequelizeUniqueConstraintError') throw err;
      }
    }

    // Device notifications, same once-only rule as email below. Never throws.
    let pushed = 0;
    if (pushConfig.isOn()) {
      const pushTo = members
        .filter((m) => channelsFor(m.userId).push && !(dedupeKey && channelsFor(m.userId).inApp && !deliveredTo.has(m.userId)))
        .map((m) => m.userId);
      pushed = await pushDigest.record(workspaceId, type, pushTo, data);
    }

    let emailed = 0;
    for (const m of members) {
      if (!channelsFor(m.userId).email) continue;
      // With a dedupe key, email only alongside a row that was really new.
      if (dedupeKey && channelsFor(m.userId).inApp && !deliveredTo.has(m.userId)) continue;
      await notify.email({ recipient: m.user.email, template: 'merchant_notification', data: { title, body, link }, workspaceId });
      emailed += 1;
    }
    // WhatsApp from the platform's number to a verified phone (platformWhatsapp.js), same once-only rule.
    for (const m of members) {
      if (!channelsFor(m.userId).whatsapp || !m.user.phone || !m.user.phoneVerifiedAt) continue;
      if (dedupeKey && channelsFor(m.userId).inApp && !deliveredTo.has(m.userId)) continue;
      await notify.whatsapp({ recipient: m.user.phone, template: 'merchant_notification', data: { title, body, link }, workspaceId });
    }
    return pushConfig.isOn() ? { created: deliveredTo.size, emailed, pushed } : { created: deliveredTo.size, emailed };
  } catch (err) {
    logger.error(`[merchant-notifications] ${type} for workspace ${workspaceId} failed: ${err.message}`);
    return { created: 0, emailed: 0, error: err.message };
  }
}

/**
 * Platform announcements (the existing Announcement table) reach the bell the
 * first time a teammate looks after one becomes active: one row per person,
 * deduped on the announcement id.
 */
async function syncAnnouncements(workspaceId, userId) {
  const now = new Date();
  const subscription = await db.Subscription.findOne({ where: { workspaceId }, attributes: ['planId'] });
  const audiences = [{ audience: 'all' }, { audience: 'workspace', workspaceId }];
  if (subscription && subscription.planId) audiences.push({ audience: 'plan', planId: subscription.planId });
  const active = await db.Announcement.findAll({
    where: { startsAt: { [Op.lte]: now }, [Op.and]: [{ [Op.or]: [{ endsAt: null }, { endsAt: { [Op.gt]: now } }] }, { [Op.or]: audiences }] },
    order: [['startsAt', 'ASC']],
    limit: 20,
  });
  if (active.length === 0) return;
  const keys = active.map((a) => `announcement:${a.id}`);
  const have = await db.MerchantNotification.findAll({ where: { workspaceId, userId, dedupeKey: keys }, attributes: ['dedupeKey'] });
  const seen = new Set(have.map((n) => n.dedupeKey));
  const prefs = await db.NotificationPreference.findOne({ where: { workspaceId, userId } });
  if (!resolveChannels(prefs && prefs.channels).announcement.inApp) return;
  const rows = active
    .filter((a) => !seen.has(`announcement:${a.id}`))
    .map((a) => ({
      workspaceId,
      userId,
      type: 'announcement',
      title: a.title,
      body: a.body,
      link: null,
      data: { announcementId: a.id, severity: a.severity },
      dedupeKey: `announcement:${a.id}`,
    }));
  if (rows.length) await db.MerchantNotification.bulkCreate(rows, { ignoreDuplicates: true });
}

const unreadCount = (workspaceId, userId) =>
  db.MerchantNotification.count({ where: { ...inboxWhere(workspaceId, userId), readAt: null } });

async function list(workspaceId, userId, { limit, cursor, unread }) {
  await syncAnnouncements(workspaceId, userId).catch((err) =>
    logger.error(`[merchant-notifications] announcement sync failed: ${err.message}`)
  );
  const where = inboxWhere(workspaceId, userId);
  if (unread) where.readAt = null;
  if (cursor) where.createdAt = { [Op.lt]: new Date(cursor) };
  const rows = await db.MerchantNotification.findAll({ where, order: [['createdAt', 'DESC']], limit });
  return {
    notifications: rows.map(serialize),
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
    unreadCount: await unreadCount(workspaceId, userId),
  };
}

/**
 * The cheap call the dashboard polls: how many are unread, and the newest
 * unread new-order notification — the dashboard plays its sound when that
 * timestamp moves forward.
 */
async function summary(workspaceId, userId) {
  const [count, latestOrder, prefs] = await Promise.all([
    unreadCount(workspaceId, userId),
    db.MerchantNotification.findOne({
      where: { ...inboxWhere(workspaceId, userId), type: 'order.new' },
      order: [['createdAt', 'DESC']],
      attributes: ['id', 'createdAt'],
    }),
    db.NotificationPreference.findOne({ where: { workspaceId, userId }, attributes: ['soundEnabled'] }),
  ]);
  return {
    unreadCount: count,
    latestOrderNotificationAt: latestOrder ? latestOrder.createdAt : null,
    soundEnabled: prefs ? prefs.soundEnabled : true,
  };
}

async function markRead(workspaceId, userId, notificationId) {
  const n = await db.MerchantNotification.findOne({ where: { ...inboxWhere(workspaceId, userId), id: notificationId } });
  if (!n) throw new NotFoundError('Notification');
  if (!n.readAt) await n.update({ readAt: new Date() });
  return { notification: serialize(n), unreadCount: await unreadCount(workspaceId, userId) };
}

async function markAllRead(workspaceId, userId) {
  const [updated] = await db.MerchantNotification.update(
    { readAt: new Date() },
    { where: { ...inboxWhere(workspaceId, userId), readAt: null } }
  );
  return { updated, unreadCount: 0 };
}

/**
 * What the settings screen shows: every type this person may receive. A
 * push-only type says so (`only: ['push']`): the screen draws no box for its
 * other channels. The types that came with push are listed only while it is on.
 */
async function getPreferences(workspaceId, userId, role) {
  const prefs = await db.NotificationPreference.findOne({ where: { workspaceId, userId } });
  const channels = resolveChannels(prefs && prefs.channels);
  return {
    soundEnabled: prefs ? prefs.soundEnabled : true,
    channels: offeredChannels(),
    types: TYPE_NAMES.filter((type) => typeLive(type) && roleAllows(role, TYPES[type].permission)).map((type) => ({
      type,
      ...channels[type],
      ...(TYPES[type].pushOnly ? { only: ['push'] } : {}),
    })),
  };
}

/**
 * At a device notification's send (push/pushDigest.js): the teammate is
 * still in the store, still holds the type's permission, and still has its
 * push channel on.
 */
async function pushAllowed(workspaceId, userId, type) {
  if (!typeLive(type)) return false;
  const membership = await db.Membership.findOne({ where: { workspaceId, userId, status: 'active' }, include: [{ model: db.Role, as: 'role' }] });
  if (!membership || !membership.role || !roleAllows(membership.role, TYPES[type].permission)) return false;
  const prefs = await db.NotificationPreference.findOne({ where: { workspaceId, userId } });
  return resolveChannels(prefs && prefs.channels)[type].push === true;
}

async function updatePreferences(workspaceId, userId, role, { soundEnabled, types }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const [prefs] = await db.NotificationPreference.findOrCreate({
      where: { workspaceId, userId },
      defaults: { workspaceId, userId },
      transaction,
    });
    const before = { soundEnabled: prefs.soundEnabled, channels: prefs.channels };
    const channels = { ...(prefs.channels || {}) };
    for (const entry of types || []) {
      if (!roleAllows(role, TYPES[entry.type].permission)) continue;
      channels[entry.type] = { ...(channels[entry.type] || {}) };
      for (const channel of CHANNELS) {
        // A push-only type keeps only its push choice.
        if (TYPES[entry.type].pushOnly && channel !== 'push') continue;
        if (typeof entry[channel] === 'boolean') channels[entry.type][channel] = entry[channel];
      }
    }
    const patch = { channels };
    if (typeof soundEnabled === 'boolean') patch.soundEnabled = soundEnabled;
    await prefs.update(patch, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: userId,
      action: 'notification_preferences.update',
      entityType: 'NotificationPreference',
      entityId: prefs.id,
      req,
      before,
      after: { soundEnabled: prefs.soundEnabled, channels },
      transaction,
    });
    return prefs;
  }).then(() => getPreferences(workspaceId, userId, role));
}

module.exports = {
  TYPES,
  TYPE_NAMES,
  CHANNELS,
  create,
  list,
  summary,
  markRead,
  markAllRead,
  getPreferences,
  updatePreferences,
  pushAllowed,
  PUSH_ON,
};
