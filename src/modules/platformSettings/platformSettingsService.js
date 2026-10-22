'use strict';

const { isDeepStrictEqual } = require('util');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { defaults } = require('./defaults');
const { GROUPS, PUBLIC_GROUPS, SOCIAL_PLATFORMS, SOCIAL_DOMAINS, LIMITS, checkSocialUrl, validateGroup } = require('./rules');

/**
 * The platform's public details, edited in the console (PLATFORM_SETTINGS_ENABLED):
 * one row per group in platform_settings (migration 706).
 *
 * A group with no row was never saved: the public endpoint sends `null` for it
 * and each site shows the values in its own code, so nothing changes until a
 * group is saved. The console starts each form from defaults.js, and the first
 * save of a group writes the whole group.
 *
 * Every save, reset and revert is audited (entity_type 'platform_setting',
 * entity_id = the group, the old and the new value), and the console's history
 * is read back from there.
 *
 * Reads for the sites and the emails go through a short in-memory cache (a
 * minute); a save drops it at once on this instance. Other instances catch up
 * within the minute, and the public answer is cacheable for one more.
 */

const ENTITY_TYPE = 'platform_setting';
const ACTIONS = Object.freeze({
  update: 'platform_settings.update',
  reset: 'platform_settings.reset',
  revert: 'platform_settings.revert',
});
const HISTORY_LIMIT = 30;

let cacheMs = env.isTest ? 0 : 60 * 1000;
let cached = null;

/** Every saved group, `{ [key]: { value, updatedAt, updatedBy } }`, through the cache. */
async function savedGroups() {
  if (cached && cached.until > Date.now()) return cached.rows;
  const rows = Object.fromEntries(
    (await db.PlatformSetting.findAll()).map((row) => [row.key, { value: row.value, updatedAt: row.updatedAt, updatedBy: row.updatedBy }])
  );
  if (cacheMs > 0) cached = { rows, until: Date.now() + cacheMs };
  return rows;
}

function invalidate() {
  cached = null;
}

/** The social links a site or an email may show: on, with a link that still passes the rules, in their saved order. */
function visibleLinks(social) {
  const links = social && Array.isArray(social.links) ? social.links : [];
  return links.flatMap((link) => {
    if (!link || link.enabled !== true || !SOCIAL_PLATFORMS.includes(link.platform) || !link.url) return [];
    const checked = checkSocialUrl(link.platform, link.url);
    return checked.ok ? [{ platform: link.platform, url: checked.href }] : [];
  });
}

/** What the public endpoint sends for a saved group. */
function publicValue(group, value) {
  if (group === 'social') {
    return { links: visibleLinks(value).map((link, index) => ({ ...link, enabled: true, order: index + 1 })) };
  }
  return value;
}

/**
 * GET /platform-settings/public: the saved public groups, `null` for each one
 * never saved (the site then shows its own values). The email group is never
 * sent.
 */
async function publicSettings() {
  const rows = await savedGroups();
  const settings = {};
  for (const group of PUBLIC_GROUPS) settings[group] = rows[group] ? publicValue(group, rows[group].value) : null;
  return { settings };
}

async function namesOf(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const users = await db.User.findAll({ where: { id: ids }, attributes: ['id', 'fullName', 'email'] });
  return new Map(users.map((user) => [user.id, { id: user.id, name: user.fullName, email: user.email }]));
}

/** The console's page: each group's value (saved, or the default the form starts from), the flag, and the rules the form mirrors. */
async function adminState() {
  const rows = Object.fromEntries((await db.PlatformSetting.findAll()).map((row) => [row.key, row]));
  const people = await namesOf(Object.values(rows).map((row) => row.updatedBy));
  const fallback = defaults();
  const groups = {};
  for (const group of GROUPS) {
    const row = rows[group];
    groups[group] = row
      ? { value: row.value, source: 'saved', updatedAt: row.updatedAt, updatedBy: people.get(row.updatedBy) || null }
      : { value: fallback[group], source: 'default', updatedAt: null, updatedBy: null };
  }
  return {
    enabled: env.platformSettings.enabled,
    groups,
    defaults: fallback,
    rules: { socialPlatforms: SOCIAL_PLATFORMS, socialDomains: SOCIAL_DOMAINS, limits: LIMITS },
  };
}

/** The top-level fields of a group whose value differs. */
function changedFields(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((key) => !isDeepStrictEqual((before || {})[key], (after || {})[key])).sort();
}

/**
 * Writes a group whole (already checked), in one transaction with its audit
 * row. Saving the value a group already holds changes nothing and writes no
 * audit row.
 */
async function writeGroup(group, value, req, { action = ACTIONS.update, metadata = {} } = {}) {
  let changed = false;
  await db.sequelize.transaction(async (transaction) => {
    const row = await db.PlatformSetting.findByPk(group, { transaction, lock: transaction.LOCK.UPDATE });
    if (row && isDeepStrictEqual(row.value, value)) return;
    const before = row ? row.value : null;
    if (row) {
      row.value = value;
      row.updatedBy = req.user.id;
      row.changed('value', true);
      await row.save({ transaction });
    } else {
      await db.PlatformSetting.create({ key: group, value, updatedBy: req.user.id }, { transaction });
    }
    await recordAudit({
      actorUserId: req.user.id,
      action,
      entityType: ENTITY_TYPE,
      entityId: group,
      req,
      before,
      after: value,
      metadata: { group, fields: changedFields(before || defaults()[group], value), fromDefault: !row, ...metadata },
      transaction,
    });
    changed = true;
  });
  if (changed) invalidate();
  return changed;
}

/** Deletes a group's row: the sites go back to the values in their code. */
async function clearGroup(group, req, { action = ACTIONS.reset, metadata = {} } = {}) {
  let changed = false;
  await db.sequelize.transaction(async (transaction) => {
    const row = await db.PlatformSetting.findByPk(group, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row) return;
    const before = row.value;
    await row.destroy({ transaction });
    await recordAudit({
      actorUserId: req.user.id,
      action,
      entityType: ENTITY_TYPE,
      entityId: group,
      req,
      before,
      after: null,
      metadata: { group, fields: changedFields(before, defaults()[group]), ...metadata },
      transaction,
    });
    changed = true;
  });
  if (changed) invalidate();
  return changed;
}

async function groupState(group) {
  return (await adminState()).groups[group];
}

/** PUT /admin/platform-settings/:group, the body checked by the route. */
async function saveGroup(group, value, req) {
  const changed = await writeGroup(group, value, req);
  return { group, changed, ...(await groupState(group)) };
}

/** POST /admin/platform-settings/:group/reset: back to the values in the sites' code. */
async function resetGroup(group, req) {
  const changed = await clearGroup(group, req);
  return { group, changed, ...(await groupState(group)) };
}

const ACTION_NAMES = Object.freeze(Object.fromEntries(Object.entries(ACTIONS).map(([name, action]) => [action, name])));

/** GET /admin/platform-settings/:group/history: the group's changes, newest first. */
async function history(group, { limit = HISTORY_LIMIT } = {}) {
  const entries = await db.AuditLog.findAll({
    where: { entityType: ENTITY_TYPE, entityId: group },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit,
  });
  const people = await namesOf(entries.map((entry) => entry.actorUserId));
  return {
    group,
    entries: entries.map((entry) => ({
      id: entry.id,
      action: ACTION_NAMES[entry.action] || entry.action,
      at: entry.createdAt,
      actor: people.get(entry.actorUserId) || null,
      before: entry.beforeState,
      after: entry.afterState,
      fields: (entry.metadata && entry.metadata.fields) || [],
    })),
  };
}

/**
 * POST /admin/platform-settings/:group/revert { auditId }: puts back the value
 * the group held before that change. Before a group's first save that is the
 * default (the row is deleted); otherwise the old value is checked against
 * today's rules first, and refused if it no longer passes them.
 */
async function revert(group, auditId, req) {
  const entry = await db.AuditLog.findOne({ where: { id: auditId, entityType: ENTITY_TYPE, entityId: group } });
  if (!entry) throw new NotFoundError('History entry');
  const metadata = { revertedAuditId: entry.id };
  let changed;
  if (entry.beforeState === null || entry.beforeState === undefined) {
    changed = await clearGroup(group, req, { action: ACTIONS.revert, metadata });
  } else {
    const checked = validateGroup(group, entry.beforeState);
    if (checked.error) {
      throw new AppError(
        'REVERT_VALUE_INVALID',
        'That earlier value no longer passes the rules; edit the group instead',
        422,
        checked.error.details.map((d) => ({ field: d.path.join('.'), message: d.message }))
      );
    }
    changed = await writeGroup(group, checked.value, req, { action: ACTIONS.revert, metadata });
  }
  return { group, changed, ...(await groupState(group)) };
}

// ---- The system emails -------------------------------------------------------

/**
 * What the system emails take from the settings (notifications/notify.js), or
 * `null` to send them exactly as before: the flag is off, the email group was
 * never saved, or the settings can't be read (an email is never held up by
 * them). The support email and the social links come from their own groups,
 * or the defaults while those were never saved.
 */
async function emailBranding() {
  if (!env.platformSettings.enabled) return null;
  try {
    const rows = await savedGroups();
    const email = rows.email && rows.email.value;
    if (!email) return null;
    const fallback = defaults();
    const contact = rows.contact ? rows.contact.value : fallback.contact;
    const social = rows.social ? rows.social.value : fallback.social;
    return {
      senderName: email.senderName,
      signature: email.signature,
      supportEmail: email.footer && email.footer.showSupportEmail ? contact.supportEmail || null : null,
      // The support email is its own switch, so the social list leaves its email entry out.
      socialLinks: email.footer && email.footer.showSocialLinks ? visibleLinks(social).filter((link) => link.platform !== 'email') : [],
    };
  } catch (err) {
    logger.warn(`[platform-settings] emails sent without the settings: ${err.message}`);
    return null;
  }
}

module.exports = {
  ACTIONS,
  publicSettings,
  adminState,
  saveGroup,
  resetGroup,
  history,
  revert,
  emailBranding,
  invalidate,
  // Tests turn the cache on (it is off under NODE_ENV=test) and back off.
  setCacheMs(ms) {
    cacheMs = ms;
    cached = null;
  },
};
