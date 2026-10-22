'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { requirePlatformPermission: can } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../core/security/platformPermissions');
const controller = require('./platformAdminController');
const schemas = require('./platformAdminValidation');

// Mounted at /api/v1/admin, alongside billing's adminRoutes (which owns
// /workspaces and /dashboard). No workspace RBAC applies here: every route
// names the platform permission it needs (core/security/platformPermissions),
// and there is no router-wide "any platform user" gate to fall back on.
const router = Router();
router.use(authenticate);

// The couriers' areas map for every store.
router.use(require('./carrierMapRoutes'));
// Turning off a person's two-step sign-in after support checked who they are
// (auth/twoFactorRecovery.js), while TWO_FACTOR_ENABLED is on.
router.use('/users/:userId/two-factor', (req, res, next) =>
  require('../../config/env').twoFactor.enabled ? next() : next(new (require('../../core/errors/AppError').AppError)('TWO_FACTOR_UNAVAILABLE', 'Two-step sign-in is not available', 404))
);
router.use(require('../auth/twoFactorRecovery').adminRouter);
// The console's notifications and each admin's notification settings.
router.use(require('./platformNotificationRoutes'));
// Merchants' suggestions: list, filter, status and reply (modules/suggestions).
router.use(require('../suggestions/suggestionAdminRoutes'));
// Marketing-site traffic (siteAnalytics/siteTrafficAdminRoutes).
router.use(require('../siteAnalytics/siteTrafficAdminRoutes'));
// The theme catalog (themes/themesCatalog.js).
router.use(require('../themes/themesCatalog').admin);
// The platform's public details: contact, social links, company, footer, emails (platformSettings/).
router.use(require('../platformSettings/platformSettingsRoutes').adminRouter);

// --- Plans ---------------------------------------------------------------
router.get('/plans', can(P.PLANS_VIEW), controller.listPlans);
router.post('/plans', can(P.PLANS_MANAGE), validate(schemas.createPlan), controller.createPlan);
router.patch('/plans/:planId', can(P.PLANS_MANAGE), validate(schemas.updatePlan), controller.updatePlan);
router.delete('/plans/:planId', can(P.PLANS_MANAGE), validate(schemas.deletePlan), controller.deletePlan);

// --- Subscriptions -------------------------------------------------------
router.get('/subscriptions', can(P.SUBSCRIPTIONS_VIEW), validate(schemas.listSubscriptions), controller.listSubscriptions);

// --- Subscription charges (billing/subscriptionChargeService) -------------
// No subscription gateway exists yet, so a payment received some other way
// (a bank transfer, cash) is recorded here by hand. It goes through the same
// charge-paid path as the gateway webhook: the referral code is re-checked at
// payment time and the commission ledger row written the same way.
router.get('/workspaces/:workspaceId/charges', can(P.SUBSCRIPTIONS_VIEW), validate(schemas.workspaceParams), controller.listCharges);
router.post('/workspaces/:workspaceId/charges', can(P.PAYMENTS_RECORD), validate(schemas.workspaceParams), controller.createCharge);
router.post('/charges/:chargeId/record-payment', can(P.PAYMENTS_RECORD), validate(schemas.recordPayment), controller.recordPayment);
// Undoes a payment recorded here (never a gateway one): the charge goes back
// to pending and its commission ledger row is voided.
router.post('/charges/:chargeId/reverse-payment', can(P.PAYMENTS_RECORD), validate(schemas.reversePayment), controller.reversePayment);
// Voids a pending charge, with a reason (PLAN_SWITCH_ENABLED). Never a paid
// one, nor one a transfer's proof waits for: review the proof first.
router.post('/charges/:chargeId/void', can(P.PAYMENTS_RECORD), validate(schemas.voidCharge), controller.voidCharge);
// Monthly or annual (10 × monthly), from the next charge.
router.patch('/workspaces/:workspaceId/subscription', can(P.SUBSCRIPTIONS_MANAGE), validate(schemas.setBillingCycle), controller.setBillingCycle);
// Special terms outside normal plan pricing: free months, or a price for the
// next N charges. A note is required; every grant is audited.
router.post('/workspaces/:workspaceId/special-terms', can(P.SUBSCRIPTIONS_MANAGE), validate(schemas.grantSpecialTerms), controller.grantSpecialTerms);

// --- Manual subscription (billing/manualSubscriptionService) ---------------
// Activate a plan for a period, change the plan, extend, end now — by hand,
// with a note, source 'manual_admin'. No charge, no invoice, no commission.
// An optional Idempotency-Key makes a double click one change.
router.get('/workspaces/:workspaceId/subscription', can(P.SUBSCRIPTIONS_VIEW), validate(schemas.workspaceParams), controller.getManualSubscription);
router.post('/workspaces/:workspaceId/subscription/activate', can(P.SUBSCRIPTIONS_MANAGE), validate(schemas.activateSubscription), controller.activateSubscription);
router.post('/workspaces/:workspaceId/subscription/change-plan', can(P.SUBSCRIPTIONS_MANAGE), validate(schemas.changeSubscriptionPlan), controller.changeSubscriptionPlan);
router.post('/workspaces/:workspaceId/subscription/extend', can(P.SUBSCRIPTIONS_MANAGE), validate(schemas.extendSubscription), controller.extendSubscription);
router.post('/workspaces/:workspaceId/subscription/end', can(P.SUBSCRIPTIONS_MANAGE), validate(schemas.endSubscription), controller.endSubscription);

// --- Features: the plan's, plus one store's overrides (billing/entitlementsService)
router.get('/workspaces/:workspaceId/features', can(P.SUBSCRIPTIONS_VIEW), validate(schemas.workspaceParams), controller.listWorkspaceFeatures);
router.post('/workspaces/:workspaceId/feature-overrides', can(P.SUBSCRIPTIONS_MANAGE), validate(schemas.addFeatureOverride), controller.addFeatureOverride);
router.patch('/workspaces/:workspaceId/feature-overrides/:overrideId', can(P.SUBSCRIPTIONS_MANAGE), validate(schemas.updateFeatureOverride), controller.updateFeatureOverride);
router.post('/workspaces/:workspaceId/feature-overrides/:overrideId/revoke', can(P.SUBSCRIPTIONS_MANAGE), validate(schemas.revokeFeatureOverride), controller.revokeFeatureOverride);

// --- Store access: manual suspension, alongside the billing restriction ---
// A suspension is independent of billing: it never touches the subscription,
// and paying never lifts it (workspaces/workspaceAccessService).
router.get('/workspaces/:workspaceId/access', can(P.WORKSPACES_VIEW), validate(schemas.workspaceParams), controller.getStoreAccess);
router.post('/workspaces/:workspaceId/suspend', can(P.WORKSPACES_MANAGE), validate(schemas.suspendWorkspace), controller.suspendWorkspace);
router.post('/workspaces/:workspaceId/reactivate', can(P.WORKSPACES_MANAGE), validate(schemas.suspendWorkspace), controller.reactivateWorkspace);

// --- Overview metrics ----------------------------------------------------
// No query parameters: the windows (30d / 30d / 12mo) are fixed by the
// contract, so there is nothing for a caller to vary and nothing to validate.
router.get('/metrics/overview', can(P.OVERVIEW_VIEW), controller.getOverview);

// --- Audit log -----------------------------------------------------------
// Read-only by design: audit_logs is append-only (see modules/audit).
router.get('/audit-log', can(P.AUDIT_LOG_VIEW), validate(schemas.listAuditLog), controller.listAuditLog);

// --- System services -----------------------------------------------------
// The POST performs no mutation; it is a POST because it deliberately bypasses
// the GET's cache and fires real third-party requests, which is not something
// a browser or proxy should be free to repeat on its own.
router.get('/system/services', can(P.SYSTEM_VIEW), controller.listServices);
router.post('/system/services/check', can(P.SYSTEM_VIEW), controller.checkServices);

// --- Feature flags -------------------------------------------------------
router.get('/feature-flags', can(P.FEATURE_FLAGS_VIEW), controller.listFlags);
router.post('/feature-flags', can(P.FEATURE_FLAGS_MANAGE), validate(schemas.createFlag), controller.createFlag);
router.patch('/feature-flags/:flagId', can(P.FEATURE_FLAGS_MANAGE), validate(schemas.updateFlag), controller.updateFlag);
router.delete('/feature-flags/:flagId', can(P.FEATURE_FLAGS_MANAGE), validate(schemas.deleteFlag), controller.deleteFlag);

// --- Announcements -------------------------------------------------------
router.get('/announcements', can(P.ANNOUNCEMENTS_VIEW), controller.listAnnouncements);
router.post('/announcements', can(P.ANNOUNCEMENTS_MANAGE), validate(schemas.createAnnouncement), controller.createAnnouncement);
router.patch('/announcements/:announcementId', can(P.ANNOUNCEMENTS_MANAGE), validate(schemas.updateAnnouncement), controller.updateAnnouncement);
router.delete('/announcements/:announcementId', can(P.ANNOUNCEMENTS_MANAGE), validate(schemas.deleteAnnouncement), controller.deleteAnnouncement);

// --- Templates -----------------------------------------------------------
// The gallery's write side. /api/v1/templates is public and read-only by
// design (it is the first screen after registration), so everything that
// changes a template lives here, behind the platform-admin guard.
router.get('/templates', can(P.TEMPLATES_VIEW), validate(schemas.listTemplates), controller.listTemplates);
router.post('/templates', can(P.TEMPLATES_MANAGE), validate(schemas.createTemplate), controller.createTemplate);
router.get('/templates/:templateId', can(P.TEMPLATES_VIEW), validate(schemas.templateParams), controller.getTemplate);
router.patch('/templates/:templateId', can(P.TEMPLATES_MANAGE), validate(schemas.updateTemplate), controller.updateTemplate);
router.delete('/templates/:templateId', can(P.TEMPLATES_MANAGE), validate(schemas.deleteTemplate), controller.deleteTemplate);
router.post('/templates/:templateId/publish', can(P.TEMPLATES_MANAGE), validate(schemas.templateParams), controller.publishTemplate);
router.post('/templates/:templateId/unpublish', can(P.TEMPLATES_MANAGE), validate(schemas.templateParams), controller.unpublishTemplate);
// Versions are immutable once written (websites are copied from them): they
// can be added and switched on or off, never edited or deleted.
router.post('/templates/:templateId/versions', can(P.TEMPLATES_MANAGE), validate(schemas.createTemplateVersion), controller.createTemplateVersion);
router.get('/templates/:templateId/versions/:versionId', can(P.TEMPLATES_VIEW), validate(schemas.templateVersionParams), controller.getTemplateVersion);
router.patch('/templates/:templateId/versions/:versionId', can(P.TEMPLATES_MANAGE), validate(schemas.updateTemplateVersion), controller.updateTemplateVersion);

// --- Platform risk -------------------------------------------------------
// The blocklist is honoured by order creation in every workspace (see
// modules/risk/platformBlocklistService). Signals are read-only aggregates
// over existing orders; blocking one is a POST to the blocklist.
router.get('/risk/blocklist', can(P.RISK_VIEW), validate(schemas.listBlocklist), controller.listBlocklist);
router.post('/risk/blocklist', can(P.RISK_MANAGE), validate(schemas.createBlocklistEntry), controller.createBlocklistEntry);
router.patch('/risk/blocklist/:entryId', can(P.RISK_MANAGE), validate(schemas.updateBlocklistEntry), controller.updateBlocklistEntry);
router.delete('/risk/blocklist/:entryId', can(P.RISK_MANAGE), validate(schemas.deleteBlocklistEntry), controller.deleteBlocklistEntry);
router.get('/risk/signals', can(P.RISK_VIEW), validate(schemas.listRiskSignals), controller.listRiskSignals);

// --- Carriers and payment gateways (read-only registry) ------------------
// No enable/disable here: the environment (CARRIERS_*, PAYMENTS_*) is the
// only source of truth. The health-check POSTs mutate nothing — they are
// POSTs for the same reason as /system/services/check: they fire a real
// request at a third party and should not be repeated by a browser at will.
router.get('/carriers', can(P.PROVIDERS_VIEW), controller.listCarriers);
router.post('/carriers/:code/health-check', can(P.PROVIDERS_VIEW), validate(schemas.providerCode), controller.checkCarrier);
router.get('/payment-gateways', can(P.PROVIDERS_VIEW), controller.listGateways);
router.post('/payment-gateways/:code/health-check', can(P.PROVIDERS_VIEW), validate(schemas.providerCode), controller.checkGateway);

// --- Users: search every account (userSearchService) ------------------------
// The store list's permission: the people behind the stores are store data.
// Agents never held it and still see only their own referrals (/my/*).
router.get('/users', can(P.WORKSPACES_VIEW), validate(schemas.searchUsers), controller.searchUsers);
router.get('/users/:userId', can(P.WORKSPACES_VIEW), validate(schemas.userParams), controller.getUser);
// Suspend, unsuspend and soft-delete an account (userModerationService): the
// store suspension's permission, a confirmation on every call, audited.
router.post('/users/:userId/suspend', can(P.WORKSPACES_MANAGE), validate(schemas.suspendUser), controller.suspendUser);
router.post('/users/:userId/unsuspend', can(P.WORKSPACES_MANAGE), validate(schemas.unsuspendUser), controller.unsuspendUser);
router.post('/users/:userId/delete', can(P.WORKSPACES_MANAGE), validate(schemas.deleteUser), controller.deleteUser);

// --- Platform users (roles and permissions) --------------------------------
// A role and a permission set on an existing account: no invitations. Only a
// creator may assign the creator role or change a creator's account; nobody
// edits or revokes themselves; the last creator is never removed.
router.get('/roles', can(P.ADMINS_VIEW), controller.listRoles);
router.get('/admins', can(P.ADMINS_VIEW), controller.listAdmins);
router.post('/admins', can(P.ADMINS_MANAGE), validate(schemas.grantAdmin), controller.grantAdmin);
router.patch('/admins/:userId', can(P.ADMINS_MANAGE), validate(schemas.updateAdmin), controller.updateAdmin);
router.delete('/admins/:userId', can(P.ADMINS_MANAGE), validate(schemas.revokeAdmin), controller.revokeAdmin);

// --- Agents, referral codes and the commission ledger ------------------------
// The ledger is informational only: nothing here pays anyone. Its one write is
// an admin marking a row paid by hand. An agent reads their own slice through
// /my/*, which is scoped to req.user and never takes an agent id.
router.get('/agents', can(P.AGENTS_VIEW), controller.listAgents);
router.post('/agents', can(P.AGENTS_MANAGE), validate(schemas.createAgent), controller.createAgent);
router.get('/agents/:agentId', can(P.AGENTS_VIEW), validate(schemas.agentParams), controller.getAgent);
router.post('/agents/:agentId/codes', can(P.AGENTS_MANAGE), validate(schemas.createReferralCode), controller.createReferralCode);
router.patch('/referral-codes/:codeId', can(P.AGENTS_MANAGE), validate(schemas.updateReferralCode), controller.updateReferralCode);
router.get('/commissions', can(P.AGENTS_VIEW), validate(schemas.listCommissions), controller.listCommissions);
router.post('/commissions/:commissionId/mark-paid', can(P.COMMISSIONS_MARK_PAID), validate(schemas.markCommissionPaid), controller.markCommissionPaid);
router.get('/my/referrals', can(P.REFERRALS_VIEW_OWN), controller.getMyReferrals);
router.get('/my/commissions', can(P.REFERRALS_VIEW_OWN), validate(schemas.listMyCommissions), controller.listMyCommissions);

// --- Support tickets ---------------------------------------------------------
// The platform side of modules/support: the queue, replies, status/priority.
router.get('/support/tickets', can(P.SUPPORT_VIEW), validate(schemas.listTickets), controller.listTickets);
router.get('/support/tickets/:ticketId', can(P.SUPPORT_VIEW), validate(schemas.ticketParams), controller.getTicket);
router.post('/support/tickets/:ticketId/messages', can(P.SUPPORT_MANAGE), validate(schemas.replyTicket), controller.replyTicket);
router.patch('/support/tickets/:ticketId', can(P.SUPPORT_MANAGE), validate(schemas.updateTicket), controller.updateTicket);

module.exports = router;
