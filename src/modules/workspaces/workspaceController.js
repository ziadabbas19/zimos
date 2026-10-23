'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./workspaceService');
const access = require('./workspaceAccessService');
const goLive = require('../billing/goLiveService');
const billingService = require('../billing/billingService');
const { planFeaturesFor } = require('../billing/planFeatureGate');
const { issueStorePreviewToken } = require('../../core/security/storePreview');

const create = asyncHandler(async (req, res) => {
  const workspace = await service.createWorkspace(
    {
      name: req.body.name,
      ownerUserId: req.user.id,
      referralCode: req.body.referralCode || null,
      planId: req.body.planId || null,
      billingCycle: req.body.billingCycle || null,
    },
    req
  );
  res.status(201).json({ workspace });
});

const list = asyncHandler(async (req, res) => {
  const workspaces = await service.listWorkspacesForUser(req.user.id);
  res.json({ workspaces });
});

const checkSlug = asyncHandler(async (req, res) => {
  res.json(await service.checkSlugAvailability(req.query.slug));
});

const updateWorkspace = asyncHandler(async (req, res) => {
  const workspace = await service.updateWorkspace({ workspaceId: req.tenant.workspaceId, patch: req.body }, req);
  res.json({ workspace });
});

const inviteMember = asyncHandler(async (req, res) => {
  const membership = await service.inviteMember(
    { workspaceId: req.tenant.workspaceId, email: req.body.email, roleId: req.body.roleId },
    req
  );
  res.status(201).json({ membership });
});

const listMembers = asyncHandler(async (req, res) => {
  res.json({ members: await service.listMembers(req.tenant.workspaceId) });
});

const listPendingInvites = asyncHandler(async (req, res) => {
  res.json({ invites: await service.listPendingInvites(req.tenant.workspaceId) });
});

const resendInvite = asyncHandler(async (req, res) => {
  res.json(
    await service.resendInvite({ workspaceId: req.tenant.workspaceId, membershipId: req.params.membershipId }, req)
  );
});

const updateMemberRole = asyncHandler(async (req, res) => {
  const membership = await service.updateMemberRole(
    { workspaceId: req.tenant.workspaceId, membershipId: req.params.membershipId, roleId: req.body.roleId },
    req
  );
  res.json({ membership });
});

const removeMember = asyncHandler(async (req, res) => {
  const result = await service.removeMember(
    { workspaceId: req.tenant.workspaceId, membershipId: req.params.membershipId },
    req
  );
  res.json(result);
});

const listRoles = asyncHandler(async (req, res) => res.json({ roles: await service.listRoles(req.tenant.workspaceId) }));

const createRole = asyncHandler(async (req, res) => {
  const role = await service.createCustomRole(
    { workspaceId: req.tenant.workspaceId, name: req.body.name, key: req.body.key, permissions: req.body.permissions },
    req
  );
  res.status(201).json({ role });
});

// GET /workspaces/:workspaceId/access — restriction state and billing phase.
// A draft also names its plan and whether its trial can still be taken, for
// the banner every member sees.
const getAccess = asyncHandler(async (req, res) => {
  const state = await access.accessFor(req.tenant.workspaceId);
  const body = access.serializeAccess(state);
  if (state.draft) {
    const { planId, planName, trial } = await goLive.draftDetails(req.tenant.workspaceId);
    body.draftPlan = { planId, planName, trial };
  }
  res.json({ access: body });
});

// GET /workspaces/:workspaceId/plan-features — the keys the store holds and
// whether PLAN_FEATURE_ENFORCEMENT is on.
const getPlanFeatures = asyncHandler(async (req, res) => {
  res.json({ planFeatures: await planFeaturesFor(req.tenant.workspaceId) });
});

// POST /workspaces/:workspaceId/start-trial — a draft's free trial, from now.
// 201 when it started, 200 when this store's trial had already started.
const startTrial = asyncHandler(async (req, res) => {
  // No body at all is the store's own plan (the subscribe dialog sends none).
  const { started } = await goLive.startTrial(req.tenant.workspaceId, req, { planId: req.body ? req.body.planId : null });
  res.status(started ? 201 : 200).json({
    billing: await billingService.getWorkspaceBilling(req.tenant.workspaceId),
    access: access.serializeAccess(await access.accessFor(req.tenant.workspaceId)),
    started,
  });
});

// POST /workspaces/:workspaceId/activate-free-plan — a draft on a plan that costs nothing.
const activateFreePlan = asyncHandler(async (req, res) => {
  const { started } = await goLive.activateFreePlan(req.tenant.workspaceId, req);
  res.status(started ? 201 : 200).json({
    billing: await billingService.getWorkspaceBilling(req.tenant.workspaceId),
    access: access.serializeAccess(await access.accessFor(req.tenant.workspaceId)),
    started,
  });
});

// POST /workspaces/:workspaceId/store-preview-token — lets staff see their own
// store on the storefront before it is public (X-Store-Preview).
const storePreviewToken = asyncHandler(async (req, res) => {
  res.status(201).json(issueStorePreviewToken(req.tenant.workspaceId));
});

module.exports = {
  create,
  getAccess,
  getPlanFeatures,
  startTrial,
  activateFreePlan,
  storePreviewToken,
  list,
  checkSlug,
  updateWorkspace,
  inviteMember,
  listMembers,
  listPendingInvites,
  resendInvite,
  updateMemberRole,
  removeMember,
  listRoles,
  createRole,
};
