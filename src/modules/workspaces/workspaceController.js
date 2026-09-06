'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./workspaceService');

const create = asyncHandler(async (req, res) => {
  const workspace = await service.createWorkspace({ name: req.body.name, ownerUserId: req.user.id }, req);
  res.status(201).json({ workspace });
});

const list = asyncHandler(async (req, res) => {
  const workspaces = await service.listWorkspacesForUser(req.user.id);
  res.json({ workspaces });
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

const createRole = asyncHandler(async (req, res) => {
  const role = await service.createCustomRole(
    { workspaceId: req.tenant.workspaceId, name: req.body.name, key: req.body.key, permissions: req.body.permissions },
    req
  );
  res.status(201).json({ role });
});

module.exports = {
  create,
  list,
  updateWorkspace,
  inviteMember,
  listMembers,
  listPendingInvites,
  resendInvite,
  updateMemberRole,
  removeMember,
  createRole,
};
