'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { PLATFORM_PERMISSIONS: P, hasPlatformPermission } = require('../../core/security/platformPermissions');
const { rowOf } = require('../dashboard/homeShortcuts');

/**
 * The console's two rows a person arranges for themselves, as the dashboard's
 * (dashboard/homeShortcuts.js): the shortcuts on their first page, and the
 * phone's bottom bar. Per console account (users.console_home_shortcuts and
 * users.console_mobile_nav, migration 746), read and written only here.
 *
 * The id is what is stored, so it never changes; the words, icon and path live
 * in the console's own catalogue (lib/consoleShortcuts.ts), which a test there
 * keeps in step with this list. `requires`: the account must hold one of these
 * (what the side menu asks of the page, lib/nav.ts); none: any console account.
 * What is stored stays when a role changes; only what is shown narrows, so a
 * page comes back to the row when the account may open it again.
 */
const CONSOLE_SHORTCUT_CATALOG = Object.freeze(
  [
    { id: 'overview', requires: [P.OVERVIEW_VIEW] },
    { id: 'notifications', requires: [] },
    { id: 'site_traffic', requires: [P.OVERVIEW_VIEW] },
    { id: 'store_traffic', requires: [P.WORKSPACES_VIEW] },

    { id: 'workspaces', requires: [P.WORKSPACES_VIEW] },
    { id: 'users', requires: [P.WORKSPACES_VIEW] },
    { id: 'subscriptions', requires: [P.SUBSCRIPTIONS_VIEW] },
    { id: 'plans', requires: [P.PLANS_VIEW] },
    { id: 'payment_proofs', requires: [P.PAYMENTS_RECORD] },
    { id: 'wallet_refunds', requires: [P.PAYMENTS_RECORD] },
    { id: 'payment_methods', requires: [P.PAYMENTS_RECORD, P.PAYMENT_METHODS_MANAGE, P.PAYMENT_METHODS_EDIT_NUMBERS] },

    { id: 'agents', requires: [P.AGENTS_VIEW] },
    { id: 'referral_codes', requires: [P.AGENTS_VIEW] },
    { id: 'my_referrals', requires: [P.REFERRALS_VIEW_OWN] },

    { id: 'templates', requires: [P.TEMPLATES_VIEW] },
    { id: 'themes', requires: [P.TEMPLATES_VIEW] },
    { id: 'suppliers', requires: [P.TEMPLATES_VIEW] },
    { id: 'apps', requires: [P.TEMPLATES_VIEW] },

    { id: 'carriers', requires: [P.PROVIDERS_VIEW] },
    { id: 'payment_gateways', requires: [P.PROVIDERS_VIEW] },
    { id: 'whatsapp_numbers', requires: [P.PROVIDERS_VIEW] },

    { id: 'fraud_signals', requires: [P.RISK_VIEW] },
    { id: 'blocklist', requires: [P.RISK_VIEW] },

    { id: 'tickets', requires: [P.SUPPORT_VIEW] },
    { id: 'suggestions', requires: [P.SUPPORT_VIEW] },
    { id: 'announcements', requires: [P.ANNOUNCEMENTS_VIEW] },
    { id: 'service_listings', requires: [P.SERVICE_LISTINGS_VIEW] },

    { id: 'feature_flags', requires: [P.FEATURE_FLAGS_VIEW] },
    { id: 'audit_log', requires: [P.AUDIT_LOG_VIEW] },
    { id: 'system_health', requires: [P.SYSTEM_VIEW] },
    { id: 'admin_users', requires: [P.ADMINS_VIEW] },
    { id: 'platform_settings', requires: [P.PLATFORM_SETTINGS_VIEW] },
  ].map((entry) => Object.freeze(entry))
);

const CONSOLE_SHORTCUT_IDS = Object.freeze(CONSOLE_SHORTCUT_CATALOG.map((entry) => entry.id));

/**
 * The two rows. `defaults`: the row of an account that never arranged it, the
 * ones it may open in this order, `defaultCount` at most. The Home row leaves
 * Overview out (it sits on the first page itself) and ends with what an agent
 * opens; the bar is the one the console always had: Overview, Workspaces,
 * Subscriptions, Tickets, then "More", which always stays.
 */
const ROWS = Object.freeze({
  home: {
    column: 'console_home_shortcuts',
    max: 12,
    defaultCount: 8,
    defaults: ['workspaces', 'users', 'subscriptions', 'payment_proofs', 'tickets', 'referral_codes', 'agents', 'admin_users', 'my_referrals', 'notifications'],
  },
  mobileNav: {
    column: 'console_mobile_nav',
    max: 4,
    defaultCount: 4,
    defaults: ['overview', 'workspaces', 'subscriptions', 'tickets'],
  },
});

/** The ids this account may have on a row, in catalogue order. */
function allowedIds(user) {
  return CONSOLE_SHORTCUT_CATALOG.filter((entry) => entry.requires.length === 0 || entry.requires.some((key) => hasPlatformPermission(user, key))).map(
    (entry) => entry.id
  );
}

/** The answer for `row` ('home' or 'mobileNav') with `stored` as saved (null: never arranged). */
function rowFor(row, user, stored) {
  const { defaults, defaultCount, max } = ROWS[row];
  const available = allowedIds(user);
  const allowed = new Set(available);
  return rowOf(stored, defaults.filter((id) => allowed.has(id)).slice(0, defaultCount), available, max);
}

async function stored(row, userId) {
  const [found] = await db.sequelize.query(`SELECT ${ROWS[row].column} AS value FROM users WHERE id = :userId`, {
    replacements: { userId },
    type: QueryTypes.SELECT,
  });
  return found ? found.value : null;
}

async function write(row, userId, value) {
  await db.sequelize.query(`UPDATE users SET ${ROWS[row].column} = CAST(:value AS JSONB) WHERE id = :userId`, {
    replacements: { userId, value: value === null ? null : JSON.stringify(value) },
  });
}

/** GET: this account's row. */
async function read(row, user) {
  return rowFor(row, user, await stored(row, user.id));
}

/** PUT: the whole row, every id one this account may open now (403 HOME_SHORTCUT_NOT_ALLOWED otherwise, as in the dashboard). */
async function save(row, user, ids) {
  const allowed = allowedIds(user);
  const refused = ids.filter((id) => !allowed.includes(id));
  if (refused.length > 0) {
    throw new AppError('HOME_SHORTCUT_NOT_ALLOWED', 'One of these shortcuts is not available to you', 403, { ids: refused });
  }
  await write(row, user.id, ids);
  return rowFor(row, user, ids);
}

/** DELETE: back to the default row, which the account follows from here on. */
async function reset(row, user) {
  await write(row, user.id, null);
  return rowFor(row, user, null);
}

module.exports = { CONSOLE_SHORTCUT_CATALOG, CONSOLE_SHORTCUT_IDS, ROWS, allowedIds, rowFor, read, save, reset };
