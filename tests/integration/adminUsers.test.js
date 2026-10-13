'use strict';

// Platform users: roles and permission sets (migration 105), and every
// /admin route checking a permission key instead of the old boolean flag.
//
//   GET    /admin/roles              admins.view
//   GET    /admin/admins             admins.view
//   POST   /admin/admins             admins.manage
//   PATCH  /admin/admins/:userId     admins.manage
//   DELETE /admin/admins/:userId     admins.manage

const { app, request, registerAndActivate, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');

async function makeUser(overrides = {}) {
  const auth = await registerAndActivate(overrides);
  return { ...auth, H: { Authorization: `Bearer ${auth.accessToken}` } };
}

const grant = (actor, body) => request(app).post('/api/v1/admin/admins').set(actor.H).send(body);
const edit = (actor, userId, body) => request(app).patch(`/api/v1/admin/admins/${userId}`).set(actor.H).send(body);
const revoke = (actor, userId) => request(app).delete(`/api/v1/admin/admins/${userId}`).set(actor.H);
const audits = (action) => db.AuditLog.findAll({ where: { action }, order: [['createdAt', 'ASC']] });
const reload = (userId) => db.User.findByPk(userId);

// Any id: a refused request never gets as far as looking it up.
const SOME_ID = '00000000-0000-4000-8000-000000000000';

// Read-only console routes, one per section. None of them reaches the
// network (the system-services GET only reads its cache; health checks are
// POSTs and left out), so "allowed" can be asserted as a plain 200.
const SECTION_READS = [
  '/api/v1/admin/metrics/overview',
  '/api/v1/admin/workspaces',
  '/api/v1/admin/subscriptions',
  '/api/v1/admin/plans',
  '/api/v1/admin/templates',
  '/api/v1/admin/risk/blocklist',
  '/api/v1/admin/risk/signals',
  '/api/v1/admin/carriers',
  '/api/v1/admin/payment-gateways',
  '/api/v1/admin/feature-flags',
  '/api/v1/admin/announcements',
  '/api/v1/admin/support/tickets',
  '/api/v1/admin/audit-log',
  '/api/v1/admin/admins',
  '/api/v1/admin/roles',
  '/api/v1/admin/agents',
  '/api/v1/admin/commissions',
  '/api/v1/admin/dashboard',
];

describe('permission enforcement on the console routes', () => {
  it('refuses an account with no platform role everywhere', async () => {
    const plain = await makeUser();
    for (const path of [...SECTION_READS, '/api/v1/admin/my/referrals', '/api/v1/admin/system/services']) {
      const res = await request(app).get(path).set(plain.H);
      expect([path, res.status]).toEqual([path, 403]);
    }
    expect((await request(app).post('/api/v1/billing/run-trial-check').set(plain.H)).status).toBe(403);
  });

  it('lets an agent reach only their own referral views', async () => {
    const agent = await makePlatformUser('agent');
    for (const path of [...SECTION_READS, '/api/v1/admin/system/services']) {
      const res = await request(app).get(path).set(agent.H);
      expect([path, res.status]).toEqual([path, 403]);
    }
    // Writes elsewhere, one per section.
    const writes = [
      ['post', '/api/v1/admin/risk/blocklist', { type: 'phone', value: '01000000000', reason: 'x' }],
      ['post', '/api/v1/admin/plans', {}],
      ['post', '/api/v1/admin/admins', { email: agent.email, role: 'admin' }],
      ['post', '/api/v1/admin/agents', { email: agent.email }],
      ['post', '/api/v1/admin/system/services/check', {}],
      ['post', '/api/v1/admin/carriers/bosta/health-check', {}],
      ['post', '/api/v1/billing/run-trial-check', {}],
      ['get', `/api/v1/admin/workspaces/${SOME_ID}/charges`, undefined],
      ['post', `/api/v1/admin/workspaces/${SOME_ID}/charges`, {}],
      ['post', `/api/v1/admin/charges/${SOME_ID}/record-payment`, { amountReceived: 100 }],
      ['post', `/api/v1/admin/charges/${SOME_ID}/reverse-payment`, {}],
      ['patch', `/api/v1/admin/workspaces/${SOME_ID}/subscription`, { billingCycle: 'yearly' }],
      ['post', `/api/v1/admin/workspaces/${SOME_ID}/special-terms`, { kind: 'free_months', months: 1, note: 'x' }],
      ['get', `/api/v1/admin/workspaces/${SOME_ID}/access`, undefined],
      ['post', `/api/v1/admin/workspaces/${SOME_ID}/suspend`, { reason: 'x' }],
      ['post', `/api/v1/admin/workspaces/${SOME_ID}/reactivate`, { reason: 'x' }],
    ];
    for (const [method, path, body] of writes) {
      const res = await request(app)[method](path).set(agent.H).send(body);
      expect([path, res.status]).toEqual([path, 403]);
    }

    expect((await request(app).get('/api/v1/admin/my/referrals').set(agent.H)).status).toBe(200);
    expect((await request(app).get('/api/v1/admin/my/commissions').set(agent.H)).status).toBe(200);
  });

  it('lets an admin read every section but not manage platform users', async () => {
    const admin = await makePlatformUser('admin');
    const other = await makePlatformUser('admin');
    for (const path of SECTION_READS) {
      const res = await request(app).get(path).set(admin.H);
      expect([path, res.status]).toEqual([path, 200]);
    }
    // The agent-only view is not part of the admin role.
    expect((await request(app).get('/api/v1/admin/my/referrals').set(admin.H)).status).toBe(403);

    const target = await makeUser();
    expect((await grant(admin, { email: target.email, role: 'agent' })).status).toBe(403);
    expect((await edit(admin, other.userId, { role: 'agent' })).status).toBe(403);
    expect((await revoke(admin, other.userId)).status).toBe(403);
    expect((await reload(other.userId)).platformRole).toBe('admin');
    expect((await reload(target.userId)).platformRole).toBeNull();
  });

  it('lets a creator in everywhere, including platform-user management', async () => {
    const creator = await makePlatformUser('creator');
    for (const path of SECTION_READS) {
      const res = await request(app).get(path).set(creator.H);
      expect([path, res.status]).toEqual([path, 200]);
    }
    const target = await makeUser();
    expect((await grant(creator, { email: target.email, role: 'admin' })).status).toBe(201);
    expect((await edit(creator, target.userId, { role: 'agent' })).status).toBe(200);
    expect((await revoke(creator, target.userId)).status).toBe(200);
  });
});

describe('platform users: roles and permissions', () => {
  it('lists the roles and every permission key', async () => {
    const admin = await makePlatformUser('admin');
    const res = await request(app).get('/api/v1/admin/roles').set(admin.H);
    expect(res.status).toBe(200);
    expect(res.body.roles.map((r) => r.key).sort()).toEqual(['admin', 'agent', 'creator']);
    const byKey = Object.fromEntries(res.body.roles.map((r) => [r.key, r]));
    expect(byKey.creator.defaultPermissions).toEqual(['*']);
    expect(byKey.agent.defaultPermissions).toEqual(['referrals.view_own']);
    expect(byKey.admin.defaultPermissions).not.toContain('admins.manage');
    expect(byKey.admin.defaultPermissions).toContain('admins.view');
    // Added by migration 107.
    expect(byKey.admin.defaultPermissions).toContain('payments.record');
    // Added by migration 111.
    expect(byKey.admin.defaultPermissions).toContain('workspaces.manage');
    expect(res.body.permissions).toContain('admins.manage');
  });

  it('lists platform users with their role and permissions, marking the viewer', async () => {
    const me = await makePlatformUser('creator', { fullName: 'First Creator' });
    const agent = await makePlatformUser('agent', { fullName: 'An Agent' });
    await makeUser();

    const res = await request(app).get('/api/v1/admin/admins').set(me.H);
    expect(res.status).toBe(200);
    expect(res.body.admins.map((a) => a.id)).toEqual([me.userId, agent.userId]);
    expect(res.body.admins[0]).toMatchObject({
      email: me.email,
      role: 'creator',
      roleName: 'Creator',
      permissions: ['*'],
      isYou: true,
    });
    expect(res.body.admins[1]).toMatchObject({ role: 'agent', permissions: ['referrals.view_own'], isYou: false });
    expect(res.body.admins[0]).not.toHaveProperty('passwordHash');
  });

  it("reports the account's role and console access on /auth/me", async () => {
    const agent = await makePlatformUser('agent');
    const me = await request(app).get('/api/v1/auth/me').set(agent.H);
    expect(me.body.user).toMatchObject({
      platformRole: 'agent',
      platformPermissions: ['referrals.view_own'],
      platformAdmin: true,
    });
    const plain = await makeUser();
    const plainMe = await request(app).get('/api/v1/auth/me').set(plain.H);
    expect(plainMe.body.user).toMatchObject({ platformRole: null, platformPermissions: [], platformAdmin: false });
  });

  it("grants a role by email, whatever its case, with the role's default set, and audits it", async () => {
    const creator = await makePlatformUser('creator');
    const user = await makeUser();

    const res = await grant(creator, { email: user.email.toUpperCase(), role: 'admin' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ granted: true, admin: { id: user.userId, role: 'admin' } });
    const adminRole = await db.PlatformRole.findByPk('admin');
    const saved = await reload(user.userId);
    expect(saved.platformRole).toBe('admin');
    expect(saved.platformPermissions).toEqual(adminRole.defaultPermissions);

    const [row] = await audits('platform_admin.grant');
    expect(row).toMatchObject({
      workspaceId: null,
      actorUserId: creator.userId,
      entityType: 'User',
      entityId: user.userId,
      beforeState: { platformRole: null, platformPermissions: [] },
      afterState: { platformRole: 'admin', platformPermissions: adminRole.defaultPermissions },
      metadata: { email: user.email },
    });

    // Effective on the very next request — no new token needed.
    expect((await request(app).get('/api/v1/admin/plans').set(user.H)).status).toBe(200);
  });

  it('grants an explicit permission set instead of the default', async () => {
    const creator = await makePlatformUser('creator');
    const user = await makeUser();
    const duplicated = await grant(creator, { email: user.email, role: 'admin', permissions: ['plans.view', 'plans.view'] });
    expect(duplicated.status).toBe(422);

    const res = await grant(creator, { email: user.email, role: 'admin', permissions: ['plans.view'] });
    expect(res.status).toBe(201);
    expect(res.body.admin.permissions).toEqual(['plans.view']);
    expect((await request(app).get('/api/v1/admin/plans').set(user.H)).status).toBe(200);
    expect((await request(app).get('/api/v1/admin/risk/blocklist').set(user.H)).status).toBe(403);
  });

  it('treats granting the same role again as a no-op, and refuses a different one', async () => {
    const creator = await makePlatformUser('creator');
    const other = await makePlatformUser('admin');
    const same = await grant(creator, { email: other.email, role: 'admin' });
    expect(same.status).toBe(200);
    expect(same.body.granted).toBe(false);

    const different = await grant(creator, { email: other.email, role: 'agent' });
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe('ALREADY_PLATFORM_USER');
    expect(await audits('platform_admin.grant')).toHaveLength(0);
  });

  it('refuses unknown emails and roles, inactive accounts and bad permission sets', async () => {
    const creator = await makePlatformUser('creator');
    const unknown = await grant(creator, { email: 'nobody@example.com', role: 'admin' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('USER_NOT_FOUND');

    const pendingEmail = `pending${Date.now()}@example.com`;
    await request(app).post('/api/v1/auth/register').send({ phone: '01012345678', email: pendingEmail, password: 'Passw0rd!123', fullName: 'Pending' });
    const pending = await grant(creator, { email: pendingEmail, role: 'admin' });
    expect(pending.status).toBe(409);
    expect(pending.body.error.code).toBe('USER_NOT_ACTIVE');

    const user = await makeUser();
    expect((await grant(creator, { email: user.email, role: 'overlord' })).status).toBe(422);
    expect((await grant(creator, { email: user.email })).status).toBe(422);
    expect((await grant(creator, { email: user.email, role: 'admin', permissions: ['plans.fly'] })).status).toBe(422);
    // '*' belongs to the creator role only.
    expect((await grant(creator, { email: user.email, role: 'admin', permissions: ['*'] })).status).toBe(422);
    expect((await grant(creator, { email: 'not-an-email', role: 'admin' })).status).toBe(422);

    expect((await reload(user.userId)).platformRole).toBeNull();
    expect(await audits('platform_admin.grant')).toHaveLength(0);
  });

  it('changes a role, resetting the set to the new default, effective immediately', async () => {
    const creator = await makePlatformUser('creator');
    const admin = await makePlatformUser('admin');

    const res = await edit(creator, admin.userId, { role: 'agent' });
    expect(res.status).toBe(200);
    expect(res.body.admin).toMatchObject({ role: 'agent', permissions: ['referrals.view_own'] });
    expect((await request(app).get('/api/v1/admin/plans').set(admin.H)).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/my/referrals').set(admin.H)).status).toBe(200);

    const [row] = await audits('platform_admin.update');
    expect(row).toMatchObject({
      actorUserId: creator.userId,
      entityId: admin.userId,
      beforeState: { platformRole: 'admin' },
      afterState: { platformRole: 'agent', platformPermissions: ['referrals.view_own'] },
    });
  });

  it("edits one account's permission set and keeps its role", async () => {
    const creator = await makePlatformUser('creator');
    const admin = await makePlatformUser('admin');
    const res = await edit(creator, admin.userId, { permissions: ['support.view', 'support.manage'] });
    expect(res.status).toBe(200);
    expect(res.body.admin).toMatchObject({ role: 'admin', permissions: ['support.view', 'support.manage'] });
    expect((await request(app).get('/api/v1/admin/support/tickets').set(admin.H)).status).toBe(200);
    expect((await request(app).get('/api/v1/admin/plans').set(admin.H)).status).toBe(403);
  });

  it('keeps the creator role and creator accounts to creators', async () => {
    const creator = await makePlatformUser('creator');
    const other = await makePlatformUser('creator');
    // An admin a creator has trusted with user management.
    const manager = await makePlatformUser('admin');
    const managerSet = [...(await reload(manager.userId)).platformPermissions, 'admins.manage'];
    expect((await edit(creator, manager.userId, { permissions: managerSet })).status).toBe(200);
    const target = await makeUser();

    const makeCreator = await grant(manager, { email: target.email, role: 'creator' });
    expect(makeCreator.status).toBe(403);
    expect(makeCreator.body.error.code).toBe('CREATOR_REQUIRED');
    expect((await edit(manager, other.userId, { role: 'admin' })).body.error.code).toBe('CREATOR_REQUIRED');
    expect((await revoke(manager, other.userId)).body.error.code).toBe('CREATOR_REQUIRED');
    // Nor can they hand out a key they do not hold themselves.
    const agent = await makePlatformUser('agent');
    const escalate = await edit(manager, agent.userId, { permissions: ['referrals.view_own', 'secret.key'] });
    expect(escalate.status).toBe(422);
    const trimmed = await edit(creator, manager.userId, { permissions: ['admins.view', 'admins.manage'] });
    expect(trimmed.status).toBe(200);
    const notHeld = await edit(manager, agent.userId, { permissions: ['referrals.view_own', 'plans.manage'] });
    expect(notHeld.status).toBe(403);
    expect(notHeld.body.error.code).toBe('PERMISSION_NOT_HELD');

    // What they may do: give an ordinary account a non-creator role.
    expect((await grant(manager, { email: target.email, role: 'agent' })).status).toBe(201);
    expect((await reload(other.userId)).platformRole).toBe('creator');
  });

  it('refuses to edit or revoke yourself', async () => {
    const creator = await makePlatformUser('creator');
    await makePlatformUser('creator');
    const selfEdit = await edit(creator, creator.userId, { role: 'admin' });
    expect(selfEdit.status).toBe(409);
    expect(selfEdit.body.error.code).toBe('CANNOT_EDIT_SELF');
    const selfRevoke = await revoke(creator, creator.userId);
    expect(selfRevoke.status).toBe(409);
    expect(selfRevoke.body.error.code).toBe('CANNOT_REVOKE_SELF');
    expect((await reload(creator.userId)).platformRole).toBe('creator');
  });

  it('revokes access, effective immediately, and audits it', async () => {
    const creator = await makePlatformUser('creator');
    const admin = await makePlatformUser('admin');
    const res = await revoke(creator, admin.userId);
    expect(res.status).toBe(200);
    const saved = await reload(admin.userId);
    expect(saved.platformRole).toBeNull();
    expect(saved.platformPermissions).toEqual([]);
    expect((await request(app).get('/api/v1/admin/plans').set(admin.H)).status).toBe(403);

    const [row] = await audits('platform_admin.revoke');
    expect(row).toMatchObject({
      workspaceId: null,
      actorUserId: creator.userId,
      entityId: admin.userId,
      beforeState: { platformRole: 'admin' },
      afterState: { platformRole: null, platformPermissions: [] },
    });
  });

  it('404s an account with no platform role', async () => {
    const creator = await makePlatformUser('creator');
    const user = await makeUser();
    expect((await revoke(creator, user.userId)).status).toBe(404);
    expect((await edit(creator, user.userId, { role: 'admin' })).status).toBe(404);
    expect((await revoke(creator, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await revoke(creator, 'not-a-uuid')).status).toBe(422);
  });

  it('never removes the last creator, even when two creators revoke each other at once', async () => {
    const a = await makePlatformUser('creator');
    const b = await makePlatformUser('creator');

    const results = await Promise.all([revoke(a, b.userId), revoke(b, a.userId)]);
    const statuses = results.map((r) => r.status).sort();
    // The loser is either no longer allowed (it was revoked a moment before)
    // or finds itself the last creator; either way nothing more happens.
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);

    expect(await db.User.count({ where: { platformRole: 'creator' } })).toBe(1);
    expect(await audits('platform_admin.revoke')).toHaveLength(1);
  });

  it('a requester revoked a moment ago cannot finish a grant with the access they had', async () => {
    const adminUsers = require('../../src/modules/platformAdmin/adminUsersService');
    const stale = await makePlatformUser('creator');
    const other = await makePlatformUser('creator');
    const target = await makeUser();
    // The request was authenticated while this creator still held the role.
    const staleReq = { user: await reload(stale.userId), headers: {} };
    expect((await revoke(other, stale.userId)).status).toBe(200);

    // Granting to someone else: refused on the row as it is now.
    await expect(adminUsers.grantAdmin({ email: target.email, role: 'creator' }, staleReq)).rejects.toMatchObject({ statusCode: 403 });
    expect((await reload(target.userId)).platformRole).toBeNull();
    // Granting their own role back: refused before anything is read.
    await expect(adminUsers.grantAdmin({ email: stale.email, role: 'creator' }, staleReq)).rejects.toMatchObject({ code: 'CANNOT_ACT_ON_SELF' });
    expect((await reload(stale.userId)).platformRole).toBeNull();
    expect((await reload(stale.userId)).platformPermissions).toEqual([]);
    expect(await audits('platform_admin.grant')).toHaveLength(0);
  });

  it('nobody grants a role to their own account', async () => {
    const creator = await makePlatformUser('creator');
    const res = await grant(creator, { email: creator.email, role: 'creator' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANNOT_ACT_ON_SELF');
    expect(await audits('platform_admin.grant')).toHaveLength(0);
  });

  it('a grant and a revoke of the requester at the same moment never leave both done', async () => {
    for (let round = 0; round < 3; round += 1) {
      const a = await makePlatformUser('creator');
      const b = await makePlatformUser('creator');
      const target = await makeUser();
      const [granted, revoked] = await Promise.all([grant(a, { email: target.email, role: 'admin' }), revoke(b, a.userId)]);
      expect(revoked.status).toBe(200);
      // Either the grant ran first (201) or it found its requester revoked (403): never a deadlock (500).
      expect([201, 403]).toContain(granted.status);
    }
  });

  it('creating an agent re-reads the requester for agents.manage', async () => {
    const adminUsers = require('../../src/modules/platformAdmin/adminUsersService');
    const agentService = require('../../src/modules/referrals/agentService');
    const creator = await makePlatformUser('creator');
    const manager = await makePlatformUser('admin');
    const target = await makeUser();
    const staleReq = { user: await reload(manager.userId), headers: {} };
    expect((await revoke(creator, manager.userId)).status).toBe(200);
    await expect(agentService.createAgent({ email: target.email }, staleReq)).rejects.toMatchObject({ statusCode: 403 });
    expect((await reload(target.userId)).platformRole).toBeNull();
    expect(typeof adminUsers.grantRoleInTransaction).toBe('function');
  });
});
