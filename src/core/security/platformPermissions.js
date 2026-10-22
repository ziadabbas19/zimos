'use strict';

/**
 * Canonical list of platform-console permission keys. Every /api/v1/admin
 * route declares exactly one of these (core/middleware/platformAdminGuard.js);
 * a platform user holds them in `users.platform_permissions`.
 *
 * These are a separate namespace from the workspace permissions in
 * permissions.js: a workspace role never grants anything here, and a
 * platform role never grants anything inside a workspace.
 *
 * Roles are data (the `platform_roles` table): each one names a default
 * permission set that is copied onto an account when the role is assigned,
 * and a creator can then edit that account's set. So a check is always
 * "does this account hold the key", never "what role is it".
 *
 * '*' means every key, including ones added later, and is reserved for the
 * creator role — the same convention as the workspace Owner's '*'.
 *
 * Adding a key here means a migration that adds it to the `admin` role's
 * default set and to the admins who should have it; creators get it through
 * '*' without one.
 */
const PLATFORM_PERMISSIONS = Object.freeze({
  OVERVIEW_VIEW: 'overview.view',
  WORKSPACES_VIEW: 'workspaces.view',
  // Suspending and reactivating a store by hand (migration 111).
  WORKSPACES_MANAGE: 'workspaces.manage',
  SUBSCRIPTIONS_VIEW: 'subscriptions.view',
  // The manual trial-expiry sweep (POST /billing/run-trial-check).
  SUBSCRIPTIONS_MANAGE: 'subscriptions.manage',
  // Pricing a workspace's next charge and recording a payment against it by
  // hand (there is no subscription gateway yet). Added by migration 107.
  PAYMENTS_RECORD: 'payments.record',
  // The ways merchants can pay (billing/paymentMethodService): turning one
  // on or off and their order; and, separately, the number a manual one
  // sends money to. Both are held through '*' only: no migration adds them
  // to the admin role or to any admin, so a creator grants them by hand.
  PAYMENT_METHODS_MANAGE: 'payment_methods.manage',
  PAYMENT_METHODS_EDIT_NUMBERS: 'payment_methods.edit_numbers',
  PLANS_VIEW: 'plans.view',
  PLANS_MANAGE: 'plans.manage',
  TEMPLATES_VIEW: 'templates.view',
  TEMPLATES_MANAGE: 'templates.manage',
  RISK_VIEW: 'risk.view',
  RISK_MANAGE: 'risk.manage',
  // Carriers and payment gateways, including their health checks.
  PROVIDERS_VIEW: 'providers.view',
  // The shared courier areas map, for every store (migration 189).
  PROVIDERS_MANAGE: 'providers.manage',
  // System health, including the live re-check.
  SYSTEM_VIEW: 'system.view',
  FEATURE_FLAGS_VIEW: 'feature_flags.view',
  FEATURE_FLAGS_MANAGE: 'feature_flags.manage',
  ANNOUNCEMENTS_VIEW: 'announcements.view',
  ANNOUNCEMENTS_MANAGE: 'announcements.manage',
  // The merchants' services directory (modules/serviceListings).
  SERVICE_LISTINGS_VIEW: 'service_listings.view',
  SERVICE_LISTINGS_MANAGE: 'service_listings.manage',
  SUPPORT_VIEW: 'support.view',
  SUPPORT_MANAGE: 'support.manage',
  AUDIT_LOG_VIEW: 'audit_log.view',
  // Platform users: listing them, and granting/editing/revoking roles.
  ADMINS_VIEW: 'admins.view',
  ADMINS_MANAGE: 'admins.manage',
  // Every agent, their codes and the whole commission ledger.
  AGENTS_VIEW: 'agents.view',
  // Creating agents, and creating/editing/deactivating referral codes.
  AGENTS_MANAGE: 'agents.manage',
  // The ledger's one write: flipping a row to marked_paid.
  COMMISSIONS_MARK_PAID: 'commissions.mark_paid',
  // An agent's own codes, referred merchants and ledger rows, read-only.
  REFERRALS_VIEW_OWN: 'referrals.view_own',
  // The platform's public details (modules/platformSettings): reading them, and
  // saving, resetting and reverting them. Held through '*' only, like the
  // payment methods: no migration adds them to the admin role or to any admin,
  // so a creator grants them by hand.
  PLATFORM_SETTINGS_VIEW: 'platform_settings.view',
  PLATFORM_SETTINGS_MANAGE: 'platform_settings.manage',
});

const ALL_PLATFORM_PERMISSIONS = Object.freeze(Object.values(PLATFORM_PERMISSIONS));

const WILDCARD = '*';

// Role keys the code itself relies on. Any other role is plain data: a name
// and a default permission set.
const PLATFORM_ROLES = Object.freeze({
  CREATOR: 'creator',
  ADMIN: 'admin',
  AGENT: 'agent',
});

function hasPlatformPermission(user, permission) {
  if (!user || !user.platformRole) return false;
  const held = Array.isArray(user.platformPermissions) ? user.platformPermissions : [];
  return held.includes(WILDCARD) || held.includes(permission);
}

module.exports = {
  PLATFORM_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  WILDCARD,
  hasPlatformPermission,
};
