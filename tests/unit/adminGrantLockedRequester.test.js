'use strict';

// The grant with its storage stubbed out: this file loads no models.
const mockUser = { findOne: jest.fn(), findAll: jest.fn() };
const mockRole = { findByPk: jest.fn(), findAll: jest.fn() };
jest.mock('../../src/db/models', () => ({
  Sequelize: { Op: {} },
  sequelize: { transaction: (work) => work({ LOCK: { UPDATE: 'UPDATE' } }) },
  User: mockUser,
  PlatformRole: mockRole,
}));
jest.mock('../../src/modules/audit/auditService', () => ({ recordAudit: jest.fn().mockResolvedValue() }));
jest.mock('../../src/modules/auth/signupPolicy', () => ({ isVerified: (user) => Boolean(user.emailVerifiedAt) }));

const { recordAudit } = require('../../src/modules/audit/auditService');
const adminUsers = require('../../src/modules/platformAdmin/adminUsersService');

const ACTOR = 'aaaaaaaa-0000-4000-8000-000000000001';
const TARGET = 'bbbbbbbb-0000-4000-8000-000000000002';

function row(fields) {
  const account = {
    status: 'active',
    deletedAt: null,
    platformRole: null,
    platformPermissions: [],
    emailVerifiedAt: new Date(),
    ...fields,
    update: jest.fn(async (patch) => Object.assign(account, patch)),
  };
  return account;
}
const transaction = { LOCK: { UPDATE: 'UPDATE' } };
// What the request was authenticated with: a creator.
const reqAsCreator = () => ({ user: { id: ACTOR, platformRole: 'creator', platformPermissions: ['*'], status: 'active' }, headers: {} });

// Granting console access (platformAdmin/adminUsersService): who may grant is
// decided on the requester's row as it is under the lock, in the grant's own
// transaction, not on the copy the request arrived with.
describe('grantRoleInTransaction', () => {
  let target;
  beforeEach(() => {
    recordAudit.mockClear();
    target = row({ id: TARGET, email: 'New.Admin@example.com' });
    mockRole.findByPk.mockReset().mockImplementation(async (key) => ({ key, defaultPermissions: key === 'creator' ? ['*'] : ['admins.view'] }));
    mockUser.findOne.mockReset().mockResolvedValue({ id: TARGET });
    mockUser.findAll.mockReset();
  });
  const lockedRows = (requester) => mockUser.findAll.mockResolvedValue([requester, target].filter(Boolean));
  const grant = (body, req = reqAsCreator(), options) => adminUsers.grantRoleInTransaction(body, req, transaction, options);

  it('locks the requester with the target, in id order, before it decides', async () => {
    lockedRows(row({ id: ACTOR, platformRole: 'creator', platformPermissions: ['*'] }));
    const { granted } = await grant({ email: 'new.admin@example.com', role: 'admin' });
    expect(granted).toBe(true);

    // The address is looked up without a lock, only for the id.
    expect(mockUser.findOne.mock.calls[0][0]).toMatchObject({ attributes: ['id'] });
    expect(mockUser.findOne.mock.calls[0][0].lock).toBeUndefined();
    const locked = mockUser.findAll.mock.calls[0][0];
    expect(locked.lock).toBe('UPDATE');
    expect(locked.order).toEqual([['id', 'ASC']]);
    expect(target.update).toHaveBeenCalledWith({ platformRole: 'admin', platformPermissions: ['admins.view'] }, { transaction });
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['whose role was revoked since the request was authenticated', { platformRole: null, platformPermissions: [] }],
    ['who was suspended since', { platformRole: 'creator', platformPermissions: ['*'], status: 'suspended' }],
    ['whose account was deleted since', { platformRole: 'creator', platformPermissions: ['*'], deletedAt: new Date() }],
  ])('refuses a requester %s, and writes nothing', async (_name, now) => {
    lockedRows(row({ id: ACTOR, ...now }));
    await expect(grant({ email: 'new.admin@example.com', role: 'admin' })).rejects.toMatchObject({ statusCode: 403 });
    expect(target.update).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('refuses the creator role from a requester who is no longer a creator', async () => {
    // Still allowed to manage console users, but demoted to admin a moment ago.
    lockedRows(row({ id: ACTOR, platformRole: 'admin', platformPermissions: ['admins.manage'] }));
    await expect(grant({ email: 'new.admin@example.com', role: 'creator' })).rejects.toMatchObject({ code: 'CREATOR_REQUIRED', statusCode: 403 });
    expect(target.update).not.toHaveBeenCalled();
  });

  it('checks an explicit permission set against what the requester holds now', async () => {
    lockedRows(row({ id: ACTOR, platformRole: 'admin', platformPermissions: ['admins.manage'] }));
    await expect(grant({ email: 'new.admin@example.com', role: 'admin', permissions: ['admins.view', 'plans.manage'] })).rejects.toMatchObject({
      code: 'PERMISSION_NOT_HELD',
    });
    expect(target.update).not.toHaveBeenCalled();
  });

  it('nobody grants a role to their own account', async () => {
    mockUser.findOne.mockResolvedValue({ id: ACTOR });
    await expect(grant({ email: 'me@example.com', role: 'creator' })).rejects.toMatchObject({ code: 'CANNOT_ACT_ON_SELF', statusCode: 409 });
    expect(mockUser.findAll).not.toHaveBeenCalled();
  });

  it('asks for the permission of the route it was called from', async () => {
    // Creating an agent needs agents.manage; admins.manage is not what that route asked for.
    const req = { user: { id: ACTOR, platformRole: 'admin', platformPermissions: ['agents.manage'], status: 'active' }, headers: {} };
    lockedRows(row({ id: ACTOR, platformRole: 'admin', platformPermissions: ['agents.manage'] }));
    expect((await grant({ email: 'new.admin@example.com', role: 'agent' }, req, { permission: 'agents.manage' })).granted).toBe(true);

    target.platformRole = null;
    lockedRows(row({ id: ACTOR, platformRole: 'admin', platformPermissions: ['agents.manage'] }));
    await expect(grant({ email: 'new.admin@example.com', role: 'agent' }, req)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('keeps the same-role no-op and the unknown address as they were, with no audit row', async () => {
    target.platformRole = 'admin';
    lockedRows(row({ id: ACTOR, platformRole: 'creator', platformPermissions: ['*'] }));
    expect((await grant({ email: 'new.admin@example.com', role: 'admin' })).granted).toBe(false);

    mockUser.findOne.mockResolvedValue(null);
    await expect(grant({ email: 'nobody@example.com', role: 'admin' })).rejects.toMatchObject({ code: 'USER_NOT_FOUND', statusCode: 404 });
    expect(recordAudit).not.toHaveBeenCalled();
  });
});
