'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./platformAdminService');
const systemServices = require('./systemServicesService');
const overviewMetrics = require('./overviewMetricsService');
const templateService = require('../templates/templateService');
const platformBlocklist = require('../risk/platformBlocklistService');
const riskSignals = require('../risk/riskSignalsService');
const providerRegistry = require('./providerRegistryService');
const adminUsers = require('./adminUsersService');
const userSearch = require('./userSearchService');
const manualSubscriptions = require('../billing/manualSubscriptionService');
const entitlements = require('../billing/entitlementsService');
const supportService = require('../support/supportService');
const agents = require('../referrals/agentService');
const referralCodes = require('../referrals/referralCodeService');
const commissions = require('../referrals/commissionService');
const charges = require('../billing/subscriptionChargeService');
const planSwitches = require('../billing/planSwitchService');
const billingService = require('../billing/billingService');
const specialTerms = require('../billing/specialTermsService');
const suspension = require('./workspaceSuspensionService');
const moderation = require('./userModerationService');

// Every handler here sits behind `authenticate` and the platform permission
// its route names (platformAdminRoutes).
// Collections are returned under a named key, matching the rest of the API.

// --- Plans ---------------------------------------------------------------
const listPlans = asyncHandler(async (req, res) => {
  // { plans, featureCatalog }
  res.json(await service.listPlans());
});

const createPlan = asyncHandler(async (req, res) => {
  res.status(201).json({ plan: await service.savePlan(req.body, req) });
});

const updatePlan = asyncHandler(async (req, res) => {
  res.json({ plan: await service.savePlan({ ...req.body, id: req.params.planId }, req) });
});

const deletePlan = asyncHandler(async (req, res) => {
  res.json(await service.deletePlan(req.params.planId, req));
});

// --- Subscriptions -------------------------------------------------------
// The service returns the full envelope ({ subscriptions, mrr, mrrCurrency,
// mrrByCurrency }) — the total is computed there so the currency check cannot
// be skipped by a caller that only wants the rows.
const listSubscriptions = asyncHandler(async (req, res) => {
  res.json(await service.listSubscriptions({ status: req.query.status }));
});

// --- Subscription charges ----------------------------------------------------
// { subscription, nextCharge, charges }: the workspace's billing as the console
// shows it.
const listCharges = asyncHandler(async (req, res) => {
  res.json(await charges.listCharges(req.params.workspaceId));
});

// 201 when a new charge was priced; 200 when an open one already existed.
const createCharge = asyncHandler(async (req, res) => {
  const { invoice, created } = await charges.createCharge(req.params.workspaceId, { req });
  res.status(created ? 201 : 200).json({ charge: await charges.getCharge(invoice.id), created });
});

const recordPayment = asyncHandler(async (req, res) => {
  const { invoice, codeLapsed } = await charges.recordManualPayment(req.params.chargeId, req.body, req);
  res.json({ charge: await charges.getCharge(invoice.id), referralCodeLapsed: codeLapsed });
});

// Monthly or annual, from the next charge; the billing view comes back.
// 409 OPEN_CHARGE_EXISTS while a charge is open.
const setBillingCycle = asyncHandler(async (req, res) => {
  const { changed } = await billingService.setBillingCycle(req.params.workspaceId, req.body.billingCycle, req, {
    platform: true,
  });
  res.json({ ...(await charges.listCharges(req.params.workspaceId)), changed });
});

// 201 with the grant and the refreshed billing view.
const grantSpecialTerms = asyncHandler(async (req, res) => {
  const term = await specialTerms.grant(req.params.workspaceId, req.body, req);
  res.status(201).json({ term, ...(await charges.listCharges(req.params.workspaceId)) });
});

// A pending charge voided with a reason. 409 CHARGE_ALREADY_PAID /
// CHARGE_NOT_PENDING / PROOF_UNDER_REVIEW; 404 PLAN_SWITCH_DISABLED.
const voidCharge = asyncHandler(async (req, res) => {
  const invoice = await planSwitches.adminVoidCharge(req.params.chargeId, req.body, req);
  res.json({ charge: await charges.getCharge(invoice.id) });
});

// --- Store access (manual suspension + billing restriction) -----------------
const getStoreAccess = asyncHandler(async (req, res) => {
  res.json({ access: await suspension.getStoreAccess(req.params.workspaceId) });
});

// 409 WORKSPACE_ALREADY_SUSPENDED / WORKSPACE_NOT_ACTIVE.
const suspendWorkspace = asyncHandler(async (req, res) => {
  await suspension.suspend(req.params.workspaceId, req.body, req);
  res.json({ access: await suspension.getStoreAccess(req.params.workspaceId) });
});

// 409 WORKSPACE_NOT_SUSPENDED.
const reactivateWorkspace = asyncHandler(async (req, res) => {
  await suspension.reactivate(req.params.workspaceId, req.body, req);
  res.json({ access: await suspension.getStoreAccess(req.params.workspaceId) });
});

// 409 CHARGE_NOT_PAID / PAYMENT_CONFIRMED_BY_GATEWAY / OPEN_CHARGE_EXISTS.
const reversePayment = asyncHandler(async (req, res) => {
  const { invoice, voidedCommission, subscriptionStatus } = await charges.reverseManualPayment(
    req.params.chargeId,
    req.body,
    req
  );
  res.json({
    charge: await charges.getCharge(invoice.id),
    voidedCommission: voidedCommission
      ? {
          id: voidedCommission.id,
          suggestedCommission: Number(voidedCommission.suggestedCommission),
          payoutStatus: voidedCommission.payoutStatus,
        }
      : null,
    // { from, to }: past_due when this payment is what had made it active.
    subscriptionStatus,
  });
});

// --- Overview metrics ----------------------------------------------------
// One object, not a collection, so it takes a named key of its own: the
// console's single-record unwrap requires `overview` and rejects a bare
// object loudly rather than guessing at it.
const getOverview = asyncHandler(async (req, res) => {
  res.json({ overview: await overviewMetrics.getOverview() });
});

// --- Audit log -----------------------------------------------------------
// The service already returns the full envelope ({ auditLog, total, page,
// pageSize }), so this passes it straight through.
const listAuditLog = asyncHandler(async (req, res) => {
  res.json(await service.listAuditLog(req.query));
});

// --- System services -----------------------------------------------------
// Both return the same { services: [...] } envelope and the same tile shape,
// so the console renders them through one path. The GET may serve a reading up
// to CACHE_TTL_MS old; the POST always probes for real.
const listServices = asyncHandler(async (req, res) => {
  res.json(await systemServices.listServices());
});

const checkServices = asyncHandler(async (req, res) => {
  res.json(await systemServices.checkServices());
});

// --- Feature flags -------------------------------------------------------
const listFlags = asyncHandler(async (req, res) => {
  res.json({ featureFlags: await service.listFlags() });
});

const createFlag = asyncHandler(async (req, res) => {
  res.status(201).json({ featureFlag: await service.saveFlag(req.body, req) });
});

const updateFlag = asyncHandler(async (req, res) => {
  res.json({ featureFlag: await service.saveFlag({ ...req.body, id: req.params.flagId }, req) });
});

const deleteFlag = asyncHandler(async (req, res) => {
  res.json(await service.deleteFlag(req.params.flagId, req));
});

// --- Announcements -------------------------------------------------------
const listAnnouncements = asyncHandler(async (req, res) => {
  res.json({ announcements: await service.listAnnouncements() });
});

const createAnnouncement = asyncHandler(async (req, res) => {
  res.status(201).json({ announcement: await service.saveAnnouncement(req.body, req) });
});

const updateAnnouncement = asyncHandler(async (req, res) => {
  res.json({
    announcement: await service.saveAnnouncement({ ...req.body, id: req.params.announcementId }, req),
  });
});

const deleteAnnouncement = asyncHandler(async (req, res) => {
  res.json(await service.deleteAnnouncement(req.params.announcementId, req));
});

// --- Templates -----------------------------------------------------------
// Delegated to the templates module: the public gallery reads the same rows,
// and one module owning what a Template means is what keeps the admin grid and
// the picker from drifting apart. These routes contribute the admin guard.
const listTemplates = asyncHandler(async (req, res) => {
  res.json({ templates: await templateService.listAllTemplates({ kind: req.query.kind }) });
});

const createTemplate = asyncHandler(async (req, res) => {
  res.status(201).json({ template: await templateService.saveTemplate(req.body, req) });
});

// { template, versions } — the row plus every version, newest first.
const getTemplate = asyncHandler(async (req, res) => {
  res.json(await templateService.getTemplateForAdmin(req.params.templateId));
});

const updateTemplate = asyncHandler(async (req, res) => {
  res.json({ template: await templateService.saveTemplate({ ...req.body, id: req.params.templateId }, req) });
});

const deleteTemplate = asyncHandler(async (req, res) => {
  res.json(await templateService.deleteTemplate(req.params.templateId, req));
});

const publishTemplate = asyncHandler(async (req, res) => {
  res.json({ template: await templateService.setPublished(req.params.templateId, true, req) });
});

const unpublishTemplate = asyncHandler(async (req, res) => {
  res.json({ template: await templateService.setPublished(req.params.templateId, false, req) });
});

const createTemplateVersion = asyncHandler(async (req, res) => {
  res.status(201).json({ version: await templateService.createVersion(req.params.templateId, req.body, req) });
});

const getTemplateVersion = asyncHandler(async (req, res) => {
  res.json({ version: await templateService.getVersionForAdmin(req.params.templateId, req.params.versionId) });
});

const updateTemplateVersion = asyncHandler(async (req, res) => {
  const { templateId, versionId } = req.params;
  res.json({ version: await templateService.setVersionActive(templateId, versionId, req.body.isActive, req) });
});

// --- Platform risk -------------------------------------------------------
// Every write here is audited by the service, inside its own transaction.
const listBlocklist = asyncHandler(async (req, res) => {
  res.json(await platformBlocklist.listEntries(req.query));
});

// 201 for a new entry; 200 when the identifier was already listed and only
// its reason/expiry changed — the workspace blocklist's convention.
const createBlocklistEntry = asyncHandler(async (req, res) => {
  const { created, entry } = await platformBlocklist.blockIdentifier(req.body, req);
  res.status(created ? 201 : 200).json({ entry, created });
});

const updateBlocklistEntry = asyncHandler(async (req, res) => {
  res.json({ entry: await platformBlocklist.updateEntry(req.params.entryId, req.body, req) });
});

const deleteBlocklistEntry = asyncHandler(async (req, res) => {
  res.json(await platformBlocklist.deleteEntry(req.params.entryId, req));
});

const listRiskSignals = asyncHandler(async (req, res) => {
  res.json(await riskSignals.listSignals(req.query));
});

// --- Carriers and payment gateways -----------------------------------------
const listCarriers = asyncHandler(async (req, res) => {
  res.json(await providerRegistry.listCarriers());
});

const checkCarrier = asyncHandler(async (req, res) => {
  res.json({ check: await providerRegistry.checkCarrier(req.params.code) });
});

const listGateways = asyncHandler(async (req, res) => {
  res.json(await providerRegistry.listGateways());
});

const checkGateway = asyncHandler(async (req, res) => {
  res.json({ check: await providerRegistry.checkGateway(req.params.code) });
});

// --- Platform users (roles and permissions) --------------------------------
// { roles, permissions }: the role templates and every permission key.
const listRoles = asyncHandler(async (req, res) => {
  res.json(await adminUsers.listRoles());
});

const listAdmins = asyncHandler(async (req, res) => {
  res.json({ admins: await adminUsers.listAdmins(req.user.id) });
});

// --- Manual subscriptions and feature overrides -------------------------
// 201 for a change made now; 200 when an Idempotency-Key replayed an earlier one.
const manualAction = (fn) =>
  asyncHandler(async (req, res) => {
    const { change, replayed } = await fn(req.params.workspaceId, req.body, req);
    res.status(replayed ? 200 : 201).json({ change, replayed, ...(await manualSubscriptions.getForAdmin(req.params.workspaceId)) });
  });

const getManualSubscription = asyncHandler(async (req, res) => {
  res.json(await manualSubscriptions.getForAdmin(req.params.workspaceId));
});
const activateSubscription = manualAction(manualSubscriptions.activate);
const changeSubscriptionPlan = manualAction(manualSubscriptions.changePlan);
const extendSubscription = manualAction(manualSubscriptions.extend);
const endSubscription = manualAction(manualSubscriptions.endNow);

const listWorkspaceFeatures = asyncHandler(async (req, res) => {
  res.json(await entitlements.listForAdmin(req.params.workspaceId));
});
const addFeatureOverride = asyncHandler(async (req, res) => {
  res.status(201).json({ override: await entitlements.addOverride(req.params.workspaceId, req.body, req) });
});
const updateFeatureOverride = asyncHandler(async (req, res) => {
  res.json({ override: await entitlements.updateOverride(req.params.workspaceId, req.params.overrideId, req.body, req) });
});
const revokeFeatureOverride = asyncHandler(async (req, res) => {
  res.json({ override: await entitlements.revokeOverride(req.params.workspaceId, req.params.overrideId, req.body, req) });
});

// --- Users (search) -------------------------------------------------------
const searchUsers = asyncHandler(async (req, res) => {
  res.json(await userSearch.searchUsers(req.query));
});

const getUser = asyncHandler(async (req, res) => {
  res.json({ user: await userSearch.getUser(req.params.userId) });
});

const suspendUser = asyncHandler(async (req, res) => {
  res.json({ user: await moderation.suspend(req.params.userId, req.body, req) });
});

const unsuspendUser = asyncHandler(async (req, res) => {
  res.json({ user: await moderation.unsuspend(req.params.userId, req.body, req) });
});

const deleteUser = asyncHandler(async (req, res) => {
  res.json({ user: await moderation.remove(req.params.userId, req.body, req) });
});

// 201 when the role was granted; 200 when the account already had that role.
const grantAdmin = asyncHandler(async (req, res) => {
  const { admin, granted } = await adminUsers.grantAdmin(req.body, req);
  res.status(granted ? 201 : 200).json({ admin, granted });
});

const updateAdmin = asyncHandler(async (req, res) => {
  res.json({ admin: await adminUsers.updateAdmin(req.params.userId, req.body, req) });
});

const revokeAdmin = asyncHandler(async (req, res) => {
  res.json(await adminUsers.revokeAdmin(req.params.userId, req));
});

// --- Agents, referral codes, commission ledger -------------------------------
const listAgents = asyncHandler(async (req, res) => {
  res.json(await agents.listAgents());
});

const createAgent = asyncHandler(async (req, res) => {
  res.status(201).json(await agents.createAgent(req.body, req));
});

const getAgent = asyncHandler(async (req, res) => {
  res.json(await agents.getAgent(req.params.agentId));
});

const createReferralCode = asyncHandler(async (req, res) => {
  res.status(201).json({ code: await referralCodes.createCode(req.params.agentId, req.body, req) });
});

const updateReferralCode = asyncHandler(async (req, res) => {
  res.json({ code: await referralCodes.updateCode(req.params.codeId, req.body, req) });
});

const listCommissions = asyncHandler(async (req, res) => {
  res.json(await commissions.listCommissions(req.query));
});

const markCommissionPaid = asyncHandler(async (req, res) => {
  res.json({ commission: await commissions.markPaid(req.params.commissionId, req.body, req) });
});

// The agent's own view: always req.user, never an id from the request.
const getMyReferrals = asyncHandler(async (req, res) => {
  res.json(await agents.getAgent(req.user.id, { forAgent: true }));
});

const listMyCommissions = asyncHandler(async (req, res) => {
  res.json(await commissions.listCommissions({ ...req.query, agentId: req.user.id }, { forAgent: true }));
});

// --- Support tickets ---------------------------------------------------------
const listTickets = asyncHandler(async (req, res) => {
  res.json(await supportService.listAllTickets(req.query));
});

const getTicket = asyncHandler(async (req, res) => {
  res.json(await supportService.getTicketForAdmin(req.params.ticketId));
});

const replyTicket = asyncHandler(async (req, res) => {
  res.status(201).json(await supportService.adminReply(req.params.ticketId, req.body, req));
});

const updateTicket = asyncHandler(async (req, res) => {
  res.json({ ticket: await supportService.updateTicket(req.params.ticketId, req.body, req) });
});

module.exports = {
  listPlans,
  createPlan,
  updatePlan,
  deletePlan,
  listSubscriptions,
  listCharges,
  createCharge,
  recordPayment,
  reversePayment,
  voidCharge,
  setBillingCycle,
  grantSpecialTerms,
  getStoreAccess,
  suspendWorkspace,
  suspendUser,
  unsuspendUser,
  deleteUser,
  reactivateWorkspace,
  getOverview,
  listAuditLog,
  listServices,
  checkServices,
  listFlags,
  createFlag,
  updateFlag,
  deleteFlag,
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  listTemplates,
  createTemplate,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  publishTemplate,
  unpublishTemplate,
  createTemplateVersion,
  getTemplateVersion,
  updateTemplateVersion,
  listBlocklist,
  createBlocklistEntry,
  updateBlocklistEntry,
  deleteBlocklistEntry,
  listRiskSignals,
  listCarriers,
  checkCarrier,
  listGateways,
  checkGateway,
  listRoles,
  listAdmins,
  searchUsers,
  getUser,
  getManualSubscription,
  activateSubscription,
  changeSubscriptionPlan,
  extendSubscription,
  endSubscription,
  listWorkspaceFeatures,
  addFeatureOverride,
  updateFeatureOverride,
  revokeFeatureOverride,
  grantAdmin,
  updateAdmin,
  revokeAdmin,
  listAgents,
  createAgent,
  getAgent,
  createReferralCode,
  updateReferralCode,
  listCommissions,
  markCommissionPaid,
  getMyReferrals,
  listMyCommissions,
  listTickets,
  getTicket,
  replyTicket,
  updateTicket,
};
