'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
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
router.post(
  '/:workspaceId/members',
  validate(schemas.invite),
  resolveTenant,
  requirePermission(PERMISSIONS.USERS_MANAGE),
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
