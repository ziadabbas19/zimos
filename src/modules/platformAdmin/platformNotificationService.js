'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { ValidationError } = require('../../core/errors/AppError');
const { PLATFORM_PERMISSIONS: P, hasPlatformPermission } = require('../../core/security/platformPermissions');

/**
 * The console's notifications (migration 206): one row per event for every
 * console admin, read state and preferences per admin.
 *
 * Rows are written from the audit entries the app already records
 * (audit/auditService calls onAudit, in the change's transaction), from
 * markChargeFailed, and by the hourly sweep (jobs.js) for subscriptions that
 * end within 7 days or have ended. Writing one never fails or slows the
 * change it reports: it runs in a savepoint of the caller's transaction, and
 * any error is logged and swallowed.
 *
 * Who sees what: every type belongs to the console permission that opens
 * what it is about (TYPE_PERMISSION), so an admin is only told about what
 * they could look at — a support ticket needs support.view, a payment proof
 * payments.record. Types an admin cannot see are left out of their list, their
 * unread count, "mark all read" and their preferences.
 *
 * Preferences: per type, shown in the console (default on) and by email
 * (default off). No email is sent yet; the email choice is only kept.
 */

const TYPES = [
  'user_signup',
  'workspace_created',
  'subscription_activated',
  'subscription_expiring',
  'subscription_expired',
  'payment_proof_submitted',
  'payment_failed',
  'support_ticket',
  'referral_signup',
  'user_suspended',
  // A merchant sent a suggestion (migration 219, modules/suggestions).
  'suggestion',
  // A store whose subscription ended moved to pay per order (billing/walletFallbackService, migration 224).
  'wallet_fallback',
  // A store went over its daily analytics limit (migration 704, analytics/traffic/trafficCounters.js).
  'traffic_cap',
  // The platform or one store reached its daily SMS cap (migration 723, notifications/smsBudget.js).
  'sms_cap',
];

// The console permission of the page each type points at.
const TYPE_PERMISSION = Object.freeze({
  user_signup: P.WORKSPACES_VIEW,
  workspace_created: P.WORKSPACES_VIEW,
  user_suspended: P.WORKSPACES_VIEW,
  subscription_activated: P.SUBSCRIPTIONS_VIEW,
  subscription_expiring: P.SUBSCRIPTIONS_VIEW,
  subscription_expired: P.SUBSCRIPTIONS_VIEW,
  referral_signup: P.SUBSCRIPTIONS_VIEW,
  payment_failed: P.SUBSCRIPTIONS_VIEW,
  payment_proof_submitted: P.PAYMENTS_RECORD,
  support_ticket: P.SUPPORT_VIEW,
  // The suggestions inbox is read with support.view (suggestions/suggestionAdminRoutes).
  suggestion: P.SUPPORT_VIEW,
  wallet_fallback: P.SUBSCRIPTIONS_VIEW,
  // The console's store traffic page (analytics/traffic) is read with workspaces.view.
  traffic_cap: P.WORKSPACES_VIEW,
  // SMS spent past a cap is an abuse signal, read with the risk pages' permission.
  sms_cap: P.RISK_VIEW,
});

/** The types this console account may be told about. */
const visibleTypes = (user) => TYPES.filter((type) => hasPlatformPermission(user, TYPE_PERMISSION[type]));

const PAGE_MAX = 50;

/** Writes one notification; a duplicate dedupe_key is skipped. Never throws. */
async function notify(fields, transaction = null) {
  const sql = `INSERT INTO platform_notifications (type, title, body, link, data, actor_user_id, subject_user_id, workspace_id, dedupe_key)
    VALUES (:type, :title, :body, :link, CAST(:data AS JSONB), :actorUserId, :subjectUserId, :workspaceId, :dedupeKey)
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
  const replacements = {
    type: fields.type,
    title: String(fields.title).slice(0, 200),
    body: fields.body ? String(fields.body).slice(0, 2000) : null,
    link: fields.link || null,
    data: JSON.stringify(fields.data || {}),
    actorUserId: fields.actorUserId || null,
    subjectUserId: fields.subjectUserId || null,
    workspaceId: fields.workspaceId || null,
    dedupeKey: fields.dedupeKey || null,
  };
  try {
    if (transaction) {
      // A savepoint: a failed insert must not abort the caller's transaction.
      await db.sequelize.transaction({ transaction }, (t) => db.sequelize.query(sql, { replacements, transaction: t }));
    } else {
      await db.sequelize.query(sql, { replacements });
    }
  } catch (err) {
    logger.error(`[platform-notifications] ${fields.type} not written: ${err.message}`);
  }
}

const ws = (e) => e.workspaceId || (e.metadata && e.metadata.workspaceId) || null;

// audit action → the notification it makes (null = none).
const FROM_AUDIT = {
  'user.register': (e) => ({ type: 'user_signup', title: 'New sign-up', subjectUserId: e.entityId, link: `/users/${e.entityId}` }),
  'user.register.google': (e) => ({ type: 'user_signup', title: 'New sign-up', subjectUserId: e.entityId, link: `/users/${e.entityId}` }),
  'workspace.create': (e) => ({ type: 'workspace_created', title: 'New store', workspaceId: e.entityId || e.workspaceId, link: `/workspaces/${e.entityId || e.workspaceId}`, data: { name: e.after && e.after.name } }),
  'subscription.manual_activate': (e) => ({
    type: 'subscription_activated',
    title: 'Subscription activated by hand',
    workspaceId: ws(e),
    link: `/workspaces/${ws(e)}`,
    body: e.metadata && e.metadata.note,
    data: { pricing: e.metadata && e.metadata.pricing },
  }),
  'billing_invoice.record_payment': (e) => ({ type: 'subscription_activated', title: 'Payment recorded, subscription active', workspaceId: ws(e), link: `/workspaces/${ws(e)}` }),
  'subscription.manual_pricing_expired': (e) => ({
    type: 'subscription_expired',
    title: 'Free or discounted subscription ended (not renewed)',
    workspaceId: ws(e),
    link: `/workspaces/${ws(e)}`,
    data: { pricing: e.metadata && e.metadata.pricing },
    dedupeKey: e.before && e.before.currentPeriodEnd ? `expired:${e.entityId}:${new Date(e.before.currentPeriodEnd).toISOString()}` : null,
  }),
  'payment_proof.submit': (e) => ({ type: 'payment_proof_submitted', title: 'Payment proof sent', workspaceId: ws(e), link: `/payment-proofs/${e.entityId}` }),
  'support_ticket.create': (e) => ({ type: 'support_ticket', title: 'New support ticket', workspaceId: ws(e), link: `/tickets/${e.entityId}` }),
  // Every use of a code, the moment it is entered (sign-up, plans page, plan switch); live with REALTIME_ENABLED.
  'subscription.referral_code_attach': (e) => {
    const code = e.after && e.after.referralCode;
    return {
      type: 'referral_signup',
      title: code ? `A store used the code ${code}` : 'Store joined with a referral code',
      workspaceId: ws(e),
      link: `/workspaces/${ws(e)}`,
      data: { code: code || null, source: (e.metadata && e.metadata.source) || null },
    };
  },
  'suggestion.create': (e) => ({
    type: 'suggestion',
    title: 'New suggestion',
    workspaceId: ws(e),
    link: `/suggestions?id=${e.entityId}`,
    body: e.after && e.after.title,
    data: { category: e.after && e.after.category },
  }),
  'user.suspend': (e) => ({ type: 'user_suspended', title: 'Account suspended', subjectUserId: e.entityId, link: `/users/${e.entityId}`, body: e.metadata && e.metadata.reason }),
};

/** Called by recordAudit for every audit entry, in its transaction. Never throws. */
async function onAudit(entry) {
  const rule = FROM_AUDIT[entry.action];
  if (!rule) return;
  let fields;
  try {
    fields = rule(entry);
  } catch (err) {
    logger.error(`[platform-notifications] ${entry.action}: ${err.message}`);
    return;
  }
  if (!fields) return;
  const data = { action: entry.action, entityId: entry.entityId || null, ...(fields.data || {}) };
  await notify({ actorUserId: entry.actorUserId || null, ...fields, data }, entry.transaction || null);
}

/** A charge that failed (subscriptionChargeService.markChargeFailed has no audit entry). */
function paymentFailed(invoice, transaction) {
  return notify(
    {
      type: 'payment_failed',
      title: 'Subscription payment failed',
      workspaceId: invoice.workspaceId,
      link: `/workspaces/${invoice.workspaceId}`,
      body: invoice.failureReason || null,
      data: { invoiceId: invoice.id, amount: Number(invoice.amount), currency: invoice.currency },
    },
    transaction
  );
}

/**
 * The hourly sweep: a subscription whose period ends within 7 days, or ended
 * in the last 7 days, gets one notification per period end (dedupe_key).
 */
async function sweepSubscriptions() {
  const key = (prefix) => `'${prefix}:' || s.id || ':' || to_char(s.current_period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  const insert = (type, title, where, prefix) => `
    INSERT INTO platform_notifications (type, title, link, data, workspace_id, dedupe_key)
    SELECT '${type}', '${title}', '/workspaces/' || s.workspace_id,
      jsonb_build_object('subscriptionId', s.id, 'periodEnd', s.current_period_end, 'name', w.name, 'pricingKind', s.pricing_kind),
      s.workspace_id, ${key(prefix)}
    FROM subscriptions s JOIN workspaces w ON w.id = s.workspace_id
    WHERE ${where}
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
  try {
    await db.sequelize.query(
      insert('subscription_expiring', 'Subscription ends within 7 days', "s.status = 'active' AND s.current_period_end > NOW() AND s.current_period_end <= NOW() + INTERVAL '7 days'", 'expiring')
    );
    await db.sequelize.query(
      insert('subscription_expired', 'Subscription ended', "s.status IN ('active', 'past_due') AND s.current_period_end <= NOW() AND s.current_period_end > NOW() - INTERVAL '7 days'", 'expired')
    );
  } catch (err) {
    logger.error(`[platform-notifications] sweep failed: ${err.message}`);
  }
}

// ------------------------------------------------------------------ reading

/** The types shown to this admin: the ones they may see, less the ones they turned off. */
async function shownTypes(user) {
  const rows = await db.sequelize.query('SELECT type FROM platform_notification_prefs WHERE user_id = :userId AND enabled = false', {
    replacements: { userId: user.id },
    type: QueryTypes.SELECT,
  });
  const disabled = new Set(rows.map((r) => r.type));
  return visibleTypes(user).filter((type) => !disabled.has(type));
}

// The cursor carries created_at as Postgres prints it (microseconds; a JS
// Date would round to milliseconds and skip rows in the same millisecond).
const encodeCursor = (row) => Buffer.from(`${row.cursor_at}|${row.id}`).toString('base64url');
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function decodeCursor(cursor) {
  const [at, id] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|');
  if (!at || !id || !CURSOR_AT.test(at) || !UUID.test(id)) {
    throw new ValidationError([{ field: 'cursor', message: 'Invalid cursor' }], 'Invalid cursor');
  }
  return { at, id };
}

/** null when nothing can match (no type shown, or the asked type is not one of them). */
function filters(userId, shown, { type, unread, cursor }) {
  const types = type ? shown.filter((t) => t === type) : shown;
  if (!types.length) return null;
  const where = ['n.type IN (:types)'];
  const replacements = { userId, types };
  if (unread) where.push('r.notification_id IS NULL');
  if (cursor) {
    const c = decodeCursor(cursor);
    where.push('(n.created_at, n.id) < (CAST(:cursorAt AS TIMESTAMPTZ), CAST(:cursorId AS UUID))');
    replacements.cursorAt = c.at;
    replacements.cursorId = c.id;
  }
  return { where: where.join(' AND '), replacements };
}

const serialize = (row) => ({
  id: row.id,
  type: row.type,
  title: row.title,
  body: row.body,
  link: row.link,
  data: row.data || {},
  actorUserId: row.actor_user_id,
  subjectUserId: row.subject_user_id,
  workspaceId: row.workspace_id,
  createdAt: row.created_at,
  readAt: row.read_at || null,
});

/** GET /admin/notifications?type=&unread=&cursor=&limit= — newest first; types this admin may not see or turned off are left out. */
async function list(user, { type, unread, cursor, limit = 20 } = {}) {
  const size = Math.min(Math.max(Number(limit) || 20, 1), PAGE_MAX);
  if (cursor) decodeCursor(cursor);
  const shown = await shownTypes(user);
  const f = filters(user.id, shown, { type, unread, cursor });
  if (!f) return { notifications: [], nextCursor: null, unread: await unreadCount(user, shown) };
  const rows = await db.sequelize.query(
    `SELECT n.*, r.read_at, to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM platform_notifications n
     LEFT JOIN platform_notification_reads r ON r.notification_id = n.id AND r.user_id = :userId
     WHERE ${f.where} ORDER BY n.created_at DESC, n.id DESC LIMIT :size`,
    { replacements: { ...f.replacements, size: size + 1 }, type: QueryTypes.SELECT }
  );
  const page = rows.slice(0, size);
  return {
    notifications: page.map(serialize),
    nextCursor: rows.length > size ? encodeCursor(page[page.length - 1]) : null,
    unread: await unreadCount(user, shown),
  };
}

/** GET /admin/notifications/unread-count — for the bell. */
async function unreadCount(user, shown = null) {
  const f = filters(user.id, shown || (await shownTypes(user)), { unread: true });
  if (!f) return 0;
  const [row] = await db.sequelize.query(
    `SELECT COUNT(*)::int AS count FROM platform_notifications n
     LEFT JOIN platform_notification_reads r ON r.notification_id = n.id AND r.user_id = :userId
     WHERE ${f.where}`,
    { replacements: f.replacements, type: QueryTypes.SELECT }
  );
  return row.count;
}

/** POST /admin/notifications/read — { ids } or { all: true }, for this admin only. "All" is every unread one they can see. */
async function markRead(user, { ids, all }) {
  if (all) {
    const types = visibleTypes(user);
    if (types.length) {
      await db.sequelize.query(
        `INSERT INTO platform_notification_reads (user_id, notification_id)
         SELECT :userId, n.id FROM platform_notifications n
         WHERE n.type IN (:types)
           AND NOT EXISTS (SELECT 1 FROM platform_notification_reads r WHERE r.user_id = :userId AND r.notification_id = n.id)
         ON CONFLICT DO NOTHING`,
        { replacements: { userId: user.id, types } }
      );
    }
  } else if (ids && ids.length) {
    await db.sequelize.query(
      `INSERT INTO platform_notification_reads (user_id, notification_id)
       SELECT :userId, n.id FROM platform_notifications n WHERE n.id IN (:ids) ON CONFLICT DO NOTHING`,
      { replacements: { userId: user.id, ids } }
    );
  }
  return { unread: await unreadCount(user) };
}

/** GET /admin/notification-prefs — every type this admin may see, defaults filled in. */
async function getPrefs(user) {
  const rows = await db.sequelize.query('SELECT type, enabled, email FROM platform_notification_prefs WHERE user_id = :userId', {
    replacements: { userId: user.id },
    type: QueryTypes.SELECT,
  });
  const saved = new Map(rows.map((r) => [r.type, r]));
  return {
    prefs: visibleTypes(user).map((type) => ({ type, enabled: saved.has(type) ? saved.get(type).enabled : true, email: saved.has(type) ? saved.get(type).email : false })),
    // No email is sent yet: the choice is kept for when it is.
    emailDelivery: false,
  };
}

/** PUT /admin/notification-prefs — { prefs: [{ type, enabled, email }] }. A type the admin may not see is kept, for if they are given it. */
async function savePrefs(user, prefs) {
  await db.sequelize.transaction(async (transaction) => {
    for (const p of prefs) {
      await db.sequelize.query(
        `INSERT INTO platform_notification_prefs (user_id, type, enabled, email, updated_at) VALUES (:userId, :type, :enabled, :email, NOW())
         ON CONFLICT (user_id, type) DO UPDATE SET enabled = EXCLUDED.enabled, email = EXCLUDED.email, updated_at = NOW()`,
        { replacements: { userId: user.id, type: p.type, enabled: p.enabled, email: Boolean(p.email) }, transaction }
      );
    }
  });
  return getPrefs(user);
}

module.exports = { TYPES, TYPE_PERMISSION, visibleTypes, notify, onAudit, paymentFailed, sweepSubscriptions, list, unreadCount, markRead, getPrefs, savePrefs };
