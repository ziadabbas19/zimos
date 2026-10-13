'use strict';

// The team paths with their storage stubbed out: this file loads no models.
const mockMembership = { findAll: jest.fn(), findOne: jest.fn(), create: jest.fn() };
const mockRole = { findOne: jest.fn(), create: jest.fn() };
const mockTx = { LOCK: { UPDATE: 'UPDATE' } };
jest.mock('../../src/db/models', () => ({
  Sequelize: { Op: {} },
  sequelize: { transaction: (work) => work(mockTx) },
  Membership: mockMembership,
  Role: mockRole,
  User: { findOne: jest.fn().mockResolvedValue(null) },
  Workspace: { findByPk: jest.fn().mockResolvedValue({ id: 'ws-1', name: 'Store' }) },
  Session: { addHook: () => {} },
}));
jest.mock('../../src/modules/audit/auditService', () => ({ recordAudit: jest.fn().mockResolvedValue() }));
jest.mock('../../src/modules/notifications/notify', () => ({ email: jest.fn().mockResolvedValue({ status: 'sent' }) }));
// Collaborators that read their models when they load; none is reached here.
jest.mock('../../src/modules/billing/billingService', () => ({}));
jest.mock('../../src/modules/billing/entitlementsService', () => ({}));
jest.mock('../../src/modules/billing/publicPlansService', () => ({}));

const notify = require('../../src/modules/notifications/notify');
const { recordAudit } = require('../../src/modules/audit/auditService');
const service = require('../../src/modules/workspaces/workspaceService');

const WS = 'ws-1';
const ACTOR = 'user-actor';
const ROLES = {
  owner: { id: 'role-owner', key: 'owner', permissions: ['*'] },
  manager: { id: 'role-manager', key: 'workspace_manager', permissions: ['users.manage', 'roles.manage', 'website.edit'] },
  editor: { id: 'role-editor', key: 'editor', permissions: ['website.edit'] },
};
// What the request was authenticated with a moment ago: an Owner.
const staleOwnerReq = () => ({
  user: { id: ACTOR },
  tenant: { workspaceId: WS, role: ROLES.owner, hasPermission: () => true },
  headers: {},
});
const member = (id, userId, role, status = 'active') => ({
  id,
  userId,
  roleId: role.id,
  status,
  update: jest.fn(async function update(patch) {
    Object.assign(this, patch);
  }),
  setDataValue: jest.fn(),
});

function rolesByWhere() {
  mockRole.findOne.mockImplementation(async ({ where }) => {
    const all = Object.values(ROLES);
    if (where.key) return all.find((r) => r.key === where.key) || null;
    return all.find((r) => r.id === where.id) || null;
  });
}

// Inviting a teammate, changing a role, defining a role (workspaces/
// workspaceService): who may do it is decided on the acting member's row as it
// is under the lock, in the change's own transaction — not on req.tenant, the
// copy built when the request arrived.
describe('team changes decide on the acting member as they are now', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    rolesByWhere();
    mockMembership.findOne.mockResolvedValue(null);
    mockMembership.create.mockImplementation(async (row) => ({ id: 'new-membership', ...row }));
    mockRole.create.mockImplementation(async (row) => ({ id: 'new-role', ...row }));
  });

  describe('inviteMember', () => {
    const invite = (roleId, req = staleOwnerReq()) => service.inviteMember({ workspaceId: WS, email: 'new@example.com', roleId }, req);

    it('reads the acting member under a row lock, inside the transaction', async () => {
      mockMembership.findAll.mockResolvedValue([member('m-actor', ACTOR, ROLES.owner)]);
      await invite(ROLES.editor.id);
      const query = mockMembership.findAll.mock.calls[0][0];
      expect(query.lock).toBe('UPDATE');
      expect(query.transaction).toBe(mockTx);
      expect(query.order).toEqual([['id', 'ASC']]);
      expect(query.where.workspaceId).toBe(WS);
      expect(mockMembership.create.mock.calls[0][1]).toEqual({ transaction: mockTx });
      expect(notify.email).toHaveBeenCalledTimes(1);
    });

    it('refuses a member demoted since the request arrived, and creates and sends nothing', async () => {
      mockMembership.findAll.mockResolvedValue([member('m-actor', ACTOR, ROLES.editor)]);
      await expect(invite(ROLES.editor.id)).rejects.toMatchObject({ statusCode: 403, message: 'Missing required permission: users.manage' });
      expect(mockMembership.create).not.toHaveBeenCalled();
      expect(notify.email).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('refuses a member removed since the request arrived', async () => {
      mockMembership.findAll.mockResolvedValue([]);
      await expect(invite(ROLES.editor.id)).rejects.toMatchObject({ statusCode: 403 });
      expect(mockMembership.create).not.toHaveBeenCalled();
    });

    it('applies the ceiling of the role they hold now: no Owner invite from a former Owner', async () => {
      mockMembership.findAll.mockResolvedValue([member('m-actor', ACTOR, ROLES.manager)]);
      await expect(invite(ROLES.owner.id)).rejects.toMatchObject({ code: 'ROLE_ABOVE_YOURS', statusCode: 403 });
      expect(mockMembership.create).not.toHaveBeenCalled();
      expect(notify.email).not.toHaveBeenCalled();
    });
  });

  describe('updateMemberRole', () => {
    const TARGET = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const change = (roleId, req = staleOwnerReq()) => service.updateMemberRole({ workspaceId: WS, membershipId: TARGET, roleId }, req);

    it('locks the requester, the teammate and every Owner in one id-ordered read', async () => {
      const target = member(TARGET, 'user-target', ROLES.editor);
      mockMembership.findAll.mockResolvedValue([target, member('m-actor', ACTOR, ROLES.owner)]);
      await change(ROLES.manager.id);
      expect(mockMembership.findAll).toHaveBeenCalledTimes(1);
      const query = mockMembership.findAll.mock.calls[0][0];
      expect(query.lock).toBe('UPDATE');
      expect(query.order).toEqual([['id', 'ASC']]);
      expect(target.update).toHaveBeenCalledWith({ roleId: ROLES.manager.id }, { transaction: mockTx });
      expect(recordAudit.mock.calls[0][0]).toMatchObject({ action: 'membership.role_change', transaction: mockTx });
    });

    it('refuses a requester who is no longer allowed, and changes nothing', async () => {
      const target = member(TARGET, 'user-target', ROLES.editor);
      mockMembership.findAll.mockResolvedValue([target, member('m-actor', ACTOR, ROLES.editor)]);
      await expect(change(ROLES.manager.id)).rejects.toMatchObject({ statusCode: 403 });
      expect(target.update).not.toHaveBeenCalled();
    });

    it('refuses making an Owner, or changing one, from a requester who is no longer an Owner', async () => {
      const editor = member(TARGET, 'user-target', ROLES.editor);
      mockMembership.findAll.mockResolvedValue([editor, member('m-actor', ACTOR, ROLES.manager)]);
      await expect(change(ROLES.owner.id)).rejects.toMatchObject({ code: 'ROLE_ABOVE_YOURS' });

      const owner = member(TARGET, 'user-target', ROLES.owner);
      mockMembership.findAll.mockResolvedValue([owner, member('m-actor', ACTOR, ROLES.manager)]);
      await expect(change(ROLES.editor.id)).rejects.toMatchObject({ code: 'ROLE_ABOVE_YOURS' });
      expect(owner.update).not.toHaveBeenCalled();
    });

    it('counts Owners among the locked rows: the last one is never demoted', async () => {
      // The requester is no longer an Owner row here: the only Owner left is the teammate.
      const lastOwner = member(TARGET, 'user-target', ROLES.owner);
      mockMembership.findAll.mockResolvedValue([lastOwner, { ...member('m-actor', ACTOR, ROLES.owner), roleId: 'role-owner-elsewhere' }]);
      mockRole.findOne.mockImplementation(async ({ where }) => {
        if (where.key === 'owner') return ROLES.owner;
        if (where.id === 'role-owner-elsewhere') return { id: 'role-owner-elsewhere', permissions: ['*'] };
        return Object.values(ROLES).find((r) => r.id === where.id) || null;
      });
      await expect(change(ROLES.editor.id)).rejects.toMatchObject({ code: 'LAST_OWNER', statusCode: 409 });
      expect(lastOwner.update).not.toHaveBeenCalled();
    });

    it('answers 404 for a membership that is not in this workspace', async () => {
      mockMembership.findAll.mockResolvedValue([member('m-actor', ACTOR, ROLES.owner)]);
      await expect(change(ROLES.editor.id)).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('createCustomRole', () => {
    const create = (permissions, req = staleOwnerReq()) => service.createCustomRole({ workspaceId: WS, name: 'Helper', key: 'helper', permissions }, req);

    it('refuses a requester who no longer holds roles.manage', async () => {
      mockMembership.findAll.mockResolvedValue([member('m-actor', ACTOR, ROLES.editor)]);
      await expect(create(['website.edit'])).rejects.toMatchObject({ statusCode: 403, message: 'Missing required permission: roles.manage' });
      expect(mockRole.create).not.toHaveBeenCalled();
    });

    it('refuses a role holding more than the requester holds now', async () => {
      mockMembership.findAll.mockResolvedValue([member('m-actor', ACTOR, ROLES.manager)]);
      await expect(create(['website.edit', 'orders.manage'])).rejects.toMatchObject({ code: 'ROLE_ABOVE_YOURS' });
      expect(mockRole.create).not.toHaveBeenCalled();
    });

    it('creates the role and its audit row in the same transaction', async () => {
      mockMembership.findAll.mockResolvedValue([member('m-actor', ACTOR, ROLES.manager)]);
      await create(['website.edit']);
      expect(mockRole.create.mock.calls[0][1]).toEqual({ transaction: mockTx });
      expect(recordAudit.mock.calls[0][0]).toMatchObject({ action: 'role.create', transaction: mockTx });
    });
  });
});
