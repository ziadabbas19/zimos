'use strict';

const logger = require('../../core/utils/logger');
const { PERMISSIONS } = require('../../core/security/permissions');
const { meBody } = require('../auth/authController');
const uiPreferencesService = require('../auth/uiPreferencesService');
const workspaceService = require('../workspaces/workspaceService');
const { accessBody } = require('../workspaces/workspaceController');
const { planFeaturesFor } = require('../billing/planFeatureGate');
const notificationService = require('../notifications/merchantNotificationService');
const confirmationService = require('../cod/confirmationService');
const inboxService = require('../whatsapp/inboxService');

/**
 * GET /workspaces/:workspaceId/bootstrap — what the dashboard's frame reads on
 * every page load, in one answer instead of a request each (and a round trip
 * to Europe each). Every part is the body its own endpoint answers, built by
 * the same code, so the dashboard can hand each one to the screen that would
 * have asked for it:
 *
 *   me                  GET /auth/me
 *   uiPreferences       GET /auth/me/ui-preferences      .uiPreferences
 *   workspaces          GET /workspaces                  .workspaces
 *   access              GET /workspaces/:id/access       .access
 *   planFeatures        GET /workspaces/:id/plan-features .planFeatures
 *   notifications       GET /workspaces/:id/notifications/summary
 *   shortcuts           GET /workspaces/:id/shortcuts    .shortcuts
 *   confirmationCounts  GET /workspaces/:id/confirmation-tasks/counts .counts
 *   inboxUnread         GET /workspaces/:id/inbox/conversations?status=open&unread=true&limit=1
 *
 * The last two are null for a role its own endpoint refuses (that endpoint
 * still answers 403 when asked). No lists beyond what the frame shows: the
 * inbox part is the one-row read the menu's unread badge makes.
 *
 * Not here: the order pipeline behind the menu's "to ship" badge. It counts
 * every order of the store by stage (300-500 ms on a store with 60,000
 * orders), and the whole frame would wait for it; asked on its own, as
 * before, it only holds that badge back.
 *
 * The frame-level parts fail the whole request; a badge's part that fails is
 * null and logged, so one broken count does not take the dashboard down with
 * it (the screen then asks its own endpoint, as before).
 */

const INBOX_UNREAD_QUERY = Object.freeze({ status: 'open', unread: true, limit: 1 });

function allowedAny(tenant, ...permissions) {
  return permissions.some((permission) => tenant.hasPermission(permission));
}

async function badge(name, workspaceId, load) {
  try {
    return await load();
  } catch (err) {
    logger.warn(`Dashboard bootstrap: the ${name} part could not be read`, { workspaceId, message: err.message });
    return null;
  }
}

async function bootstrap(req) {
  const { tenant, user } = req;
  const { workspaceId } = tenant;

  // Independent reads, side by side: each takes its own connection from the pool.
  const [me, uiPreferences, workspaces, access, planFeatures, notifications, confirmationCounts, inboxUnread] =
    await Promise.all([
      meBody(user),
      uiPreferencesService.read(user.id),
      workspaceService.listWorkspacesForUser(user.id),
      accessBody(workspaceId),
      planFeaturesFor(workspaceId),
      notificationService.summary(workspaceId, user.id),
      allowedAny(tenant, PERMISSIONS.ORDERS_CONFIRM, PERMISSIONS.ORDERS_MANAGE)
        ? badge('confirmationCounts', workspaceId, () => confirmationService.queueCounts(workspaceId, req))
        : null,
      allowedAny(tenant, PERMISSIONS.ORDERS_CONFIRM)
        ? badge('inboxUnread', workspaceId, () => inboxService.listConversations(workspaceId, user.id, { ...INBOX_UNREAD_QUERY }))
        : null,
    ]);

  return {
    me,
    uiPreferences,
    workspaces,
    access,
    planFeatures,
    notifications,
    shortcuts: tenant.membership.navShortcuts || [],
    confirmationCounts,
    inboxUnread,
  };
}

module.exports = { bootstrap, INBOX_UNREAD_QUERY };
