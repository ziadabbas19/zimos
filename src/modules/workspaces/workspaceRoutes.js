'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission, requireAnyPermission } = require('../../core/middleware/rbac');
const { requireConfirmedAccount } = require('../../core/middleware/confirmedAccount');
const { PERMISSIONS } = require('../../core/security/permissions');
const { requirePlanFeature } = require('../billing/planFeatureGate');
const controller = require('./workspaceController');
const schemas = require('./workspaceValidation');

const router = Router();

router.use(authenticate);

router.post('/', validate(schemas.create), controller.create);
router.get('/', controller.list);

// Stays above every '/:workspaceId' route so "check-slug" can never be read
// as a workspace id.
router.get('/check-slug', validate(schemas.checkSlug), controller.checkSlug);

router.patch(
  '/:workspaceId',
  validate(schemas.updateWorkspace),
  resolveTenant,
  requirePermission(PERMISSIONS.WEBSITE_EDIT),
  controller.updateWorkspace
);

// Whether the store is restricted and what the dashboard should warn about
// (subscription expiring / expired, manual suspension). Any member: everyone
// who can hit the creation lock should be told why.
router.get('/:workspaceId/access', validate(schemas.listMembers), resolveTenant, controller.getAccess);

// The store's plan features and whether the gate is on, so a screen can show
// itself locked before a write is refused (billing/planFeatureGate). Any
// member: the plan's features are on the pricing page anyway.
router.get('/:workspaceId/plan-features', validate(schemas.listMembers), resolveTenant, controller.getPlanFeatures);

// Taking a draft store live (billing/goLiveService): its plan's free trial, or
// a plan that costs nothing. Whoever manages the store's billing.
router.post(
  '/:workspaceId/start-trial',
  validate(schemas.startTrial),
  resolveTenant,
  requirePermission(PERMISSIONS.BILLING_MANAGE),
  requireConfirmedAccount,
  controller.startTrial
);
router.post(
  '/:workspaceId/activate-free-plan',
  validate(schemas.listMembers),
  resolveTenant,
  requirePermission(PERMISSIONS.BILLING_MANAGE),
  controller.activateFreePlan
);

// A short-lived X-Store-Preview token: whoever edits the website or funnels
// sees the store on the storefront even while it is a draft.
router.post(
  '/:workspaceId/store-preview-token',
  validate(schemas.listMembers),
  resolveTenant,
  requireAnyPermission(PERMISSIONS.WEBSITE_EDIT, PERMISSIONS.FUNNELS_MANAGE),
  controller.storePreviewToken
);

router.get(
  '/:workspaceId/roles',
  validate(schemas.listMembers),
  resolveTenant,
  requirePermission(PERMISSIONS.USERS_MANAGE),
  controller.listRoles
);
router.get(
  '/:workspaceId/members',
  validate(schemas.listMembers),
  resolveTenant,
  requirePermission(PERMISSIONS.USERS_MANAGE),
  controller.listMembers
);
router.get(
  '/:workspaceId/invites',
  validate(schemas.listMembers),
  resolveTenant,
  requirePermission(PERMISSIONS.USERS_MANAGE),
  controller.listPendingInvites
);
// A new invite needs staff_accounts while PLAN_FEATURE_ENFORCEMENT is on
// (billing/planFeatureGate); members already in, and their roles, are untouched.
router.post(
  '/:workspaceId/members',
  validate(schemas.invite),
  resolveTenant,
  requirePermission(PERMISSIONS.USERS_MANAGE),
  requirePlanFeature('staff_accounts'),
  controller.inviteMember
);
router.post(
  '/:workspaceId/invites/:membershipId/resend',
  validate(schemas.resendInvite),
  resolveTenant,
  requirePermission(PERMISSIONS.USERS_MANAGE),
  controller.resendInvite
);
router.patch(
  '/:workspaceId/members/:membershipId',
  validate(schemas.updateRole),
  resolveTenant,
  requirePermission(PERMISSIONS.USERS_MANAGE),
  controller.updateMemberRole
);
router.delete(
  '/:workspaceId/members/:membershipId',
  validate(schemas.removeMember),
  resolveTenant,
  requirePermission(PERMISSIONS.USERS_MANAGE),
  controller.removeMember
);
router.post(
  '/:workspaceId/roles',
  validate(schemas.createRole),
  resolveTenant,
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  controller.createRole
);

module.exports = router;
