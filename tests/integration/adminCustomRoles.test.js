'use strict';

// Custom console roles, from creating one to the account holding it.
//
//   POST   /admin/roles             admins.manage
//   PATCH  /admin/roles/:roleKey    admins.manage
//   DELETE /admin/roles/:roleKey    admins.manage

const { app, request, registerAndActivate, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');

async function makeUser(overrides = {}) {
  const auth = await registerAndActivate(overrides);
  return { ...auth, H: { Authorization: `Bearer ${auth.accessToken}` } };
}

/** An admin account whose set is exactly `permissions`. */
async function adminHolding(permissions) {
  const user = await makePlatformUser('admin');
  await db.User.update({ platformPermissions: permissions }, { where: { id: user.userId } });
  return user;
}

const createRole = (actor, body) => request(app).post('/api/v1/admin/roles').set(actor.H).send(body);
const editRole = (actor, key, body) => request(app).patch(`/api/v1/admin/roles/${key}`).set(actor.H).send(body);
const removeRole = (actor, key) => request(app).delete(`/api/v1/admin/roles/${key}`).set(actor.H);
const grant = (actor, body) => request(app).post('/api/v1/admin/admins').set(actor.H).send(body);
const edit = (actor, id, body) => request(app).patch(`/api/v1/admin/admins/${id}`).set(actor.H).send(body);
const read = (who, path) => request(app).get(`/api/v1/admin${path}`).set(who.H);
const held = async (id) => (await db.User.findByPk(id)).platformPermissions;
const audits = (action) => db.AuditLog.findAll({ where: { action }, order: [['createdAt', 'ASC']] });

describe('custom console roles', () => {
  it('makes a role with few permissions, and the account holding it reaches only those', async () => {
    const creator = await makePlatformUser('creator');
    const created = await createRole(creator, { name: 'Support desk', description: 'Answers merchants', permissions: ['support.view', 'support.manage'] });
    expect(created.status).toBe(201);
    expect(created.body.role).toMatchObject({ name: 'Support desk', builtIn: false, holders: 0, defaultPermissions: ['support.view', 'support.manage'] });
    expect(created.body.role.key).toMatch(/^support_desk_[0-9a-f]{6}$/);

    const person = await makeUser();
    const granted = await grant(creator, { email: person.email, role: created.body.role.key });
    expect(granted.status).toBe(201);
    expect(granted.body.admin).toMatchObject({ role: created.body.role.key, roleName: 'Support desk', permissions: ['support.view', 'support.manage'] });

    const me = await request(app).get('/api/v1/auth/me').set(person.H);
    expect(me.body.user).toMatchObject({ platformAdmin: true, platformRole: created.body.role.key, platformPermissions: ['support.view', 'support.manage'] });

    expect((await read(person, '/support/tickets')).status).toBe(200);
    expect((await read(person, '/suggestions')).status).toBe(200);
    for (const path of ['/metrics/overview', '/workspaces', '/subscriptions', '/plans', '/admins', '/roles', '/audit-log']) {
      expect([path, (await read(person, path)).status]).toEqual([path, 403]);
    }

    const roles = await read(creator, '/roles');
    expect(roles.body.roles.find((r) => r.key === created.body.role.key).holders).toBe(1);
    expect(roles.body.roles.find((r) => r.key === 'admin')).toMatchObject({ builtIn: true });

    const [row] = await audits('platform_role.create');
    expect(row).toMatchObject({ actorUserId: creator.userId, entityType: 'PlatformRole', entityId: created.body.role.key });
  });

  it('gets a key for a name with no latin letters', async () => {
    const creator = await makePlatformUser('creator');
    const res = await createRole(creator, { name: 'الدعم الفني', permissions: [] });
    expect(res.status).toBe(201);
    expect(res.body.role.key).toMatch(/^role_[0-9a-f]{6}$/);
    expect(res.body.role.name).toBe('الدعم الفني');
  });

  it('refuses a bad role', async () => {
    const creator = await makePlatformUser('creator');
    expect((await createRole(creator, { name: 'x', permissions: [] })).status).toBe(422);
    expect((await createRole(creator, { name: 'No set' })).status).toBe(422);
    expect((await createRole(creator, { name: 'Everything', permissions: ['*'] })).status).toBe(422);
    expect((await createRole(creator, { name: 'Unknown', permissions: ['nope.view'] })).status).toBe(422);
    const taken = await createRole(creator, { name: 'ADMIN', permissions: [] });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('ROLE_NAME_TAKEN');
  });

  it('needs admins.manage, and hands out only what its author holds', async () => {
    const viewer = await adminHolding(['admins.view']);
    expect((await read(viewer, '/roles')).status).toBe(200);
    expect((await createRole(viewer, { name: 'Nope', permissions: [] })).status).toBe(403);

    const manager = await adminHolding(['admins.view', 'admins.manage', 'support.view']);
    const refused = await createRole(manager, { name: 'Too much', permissions: ['support.view', 'plans.manage'] });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('PERMISSION_NOT_HELD');
    expect((await createRole(manager, { name: 'Support reader', permissions: ['support.view'] })).status).toBe(201);
  });

  it('assigns a custom role only to someone holding all of it', async () => {
    const creator = await makePlatformUser('creator');
    const { body } = await createRole(creator, { name: 'Billing', permissions: ['payments.record', 'subscriptions.view'] });
    const manager = await adminHolding(['admins.manage', 'subscriptions.view']);
    const person = await makeUser();

    const refused = await grant(manager, { email: person.email, role: body.role.key });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('PERMISSION_NOT_HELD');
    expect((await db.User.findByPk(person.userId)).platformRole).toBeNull();

    expect((await grant(creator, { email: person.email, role: body.role.key })).status).toBe(201);
  });

  it('applies a role edit to its holders on their next request, with no new token', async () => {
    const creator = await makePlatformUser('creator');
    const { body } = await createRole(creator, { name: 'Support desk', permissions: ['support.view', 'plans.view'] });
    const key = body.role.key;
    const person = await makeUser();
    await grant(creator, { email: person.email, role: key });
    const adjusted = await makeUser();
    await grant(creator, { email: adjusted.email, role: key, permissions: ['support.view', 'audit_log.view'] });

    expect((await read(person, '/risk/signals')).status).toBe(403);
    expect((await read(person, '/plans')).status).toBe(200);

    const res = await editRole(creator, key, { name: 'Support and risk', permissions: ['support.view', 'risk.view'] });
    expect(res.status).toBe(200);
    expect(res.body.role).toMatchObject({ name: 'Support and risk', holders: 2, defaultPermissions: ['support.view', 'risk.view'] });

    expect((await read(person, '/risk/signals')).status).toBe(200);
    expect((await read(person, '/plans')).status).toBe(403);
    expect((await request(app).get('/api/v1/auth/me').set(person.H)).body.user.platformPermissions.sort()).toEqual(['risk.view', 'support.view']);

    // What was adjusted on one account stays; the role's change still reaches it.
    expect((await held(adjusted.userId)).sort()).toEqual(['audit_log.view', 'risk.view', 'support.view']);

    const [role] = await audits('platform_role.update');
    expect(role).toMatchObject({ entityId: key, metadata: { holdersChanged: 2 } });
    expect(await audits('platform_admin.update')).toHaveLength(2);
  });

  it('keeps a role edit off the role its author holds themselves', async () => {
    const creator = await makePlatformUser('creator');
    const { body } = await createRole(creator, { name: 'Managers', permissions: ['admins.manage', 'support.view'] });
    const member = await makeUser();
    await grant(creator, { email: member.email, role: body.role.key });

    const own = await editRole(member, body.role.key, { permissions: ['admins.manage'] });
    expect(own.status).toBe(409);
    expect(own.body.error.code).toBe('CANNOT_EDIT_SELF');
  });

  it('leaves the seeded roles alone', async () => {
    const creator = await makePlatformUser('creator');
    for (const key of ['creator', 'admin', 'agent']) {
      const edited = await editRole(creator, key, { name: 'Renamed' });
      expect(edited.status).toBe(409);
      expect(edited.body.error.code).toBe('ROLE_BUILT_IN');
      expect((await removeRole(creator, key)).status).toBe(409);
    }
    expect((await editRole(creator, 'no_such_role', { name: 'Renamed' })).status).toBe(404);
  });

  it('deletes a role nobody holds, and refuses one in use', async () => {
    const creator = await makePlatformUser('creator');
    const { body } = await createRole(creator, { name: 'Short lived', permissions: ['plans.view'] });
    const key = body.role.key;
    const person = await makeUser();
    await grant(creator, { email: person.email, role: key });

    const refused = await removeRole(creator, key);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('ROLE_IN_USE');

    expect((await edit(creator, person.userId, { role: 'agent' })).status).toBe(200);
    expect((await removeRole(creator, key)).status).toBe(200);
    expect(await db.PlatformRole.findByPk(key)).toBeNull();
    expect(await audits('platform_role.delete')).toHaveLength(1);
  });
});

describe('nobody gives what they do not hold', () => {
  const notHeld = (res) => {
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_NOT_HELD');
  };

  it('refuses the admin role from someone holding only admins.manage, by grant and by role change', async () => {
    const manager = await adminHolding(['admins.view', 'admins.manage']);
    const person = await makeUser();
    notHeld(await grant(manager, { email: person.email, role: 'admin' }));
    expect((await db.User.findByPk(person.userId)).platformRole).toBeNull();

    const agent = await makePlatformUser('agent');
    notHeld(await edit(manager, agent.userId, { role: 'admin' }));
    expect((await db.User.findByPk(agent.userId)).platformRole).toBe('agent');
    expect(await audits('platform_admin.grant')).toHaveLength(0);
    expect(await audits('platform_admin.update')).toHaveLength(0);
  });

  it('gives the admin role from someone holding all of it, or a smaller set of what they hold', async () => {
    const adminRole = await db.PlatformRole.findByPk('admin');
    const full = await adminHolding([...adminRole.defaultPermissions, 'admins.manage']);
    const person = await makeUser();
    const given = await grant(full, { email: person.email, role: 'admin' });
    expect(given.status).toBe(201);
    expect(given.body.admin.permissions).toEqual(adminRole.defaultPermissions);

    const partial = await adminHolding(['admins.manage', 'support.view']);
    const other = await makeUser();
    const smaller = await grant(partial, { email: other.email, role: 'admin', permissions: ['support.view'] });
    expect(smaller.status).toBe(201);
    expect(smaller.body.admin.permissions).toEqual(['support.view']);

    const third = await makeUser();
    notHeld(await grant(partial, { email: third.email, role: 'admin', permissions: ['support.view', 'plans.view'] }));
  });

  it('gives the agent role from someone with agents.create but without its key, and only that key', async () => {
    const manager = await adminHolding(['admins.view', 'admins.manage', 'agents.create']);
    const person = await makeUser();
    const given = await grant(manager, { email: person.email, role: 'agent' });
    expect(given.status).toBe(201);
    expect(given.body.admin).toMatchObject({ role: 'agent', permissions: ['referrals.view_own'] });
    expect((await read(person, '/my/referrals')).status).toBe(200);

    const within = await adminHolding(['admins.view']);
    const moved = await edit(manager, within.userId, { role: 'agent' });
    expect(moved.status).toBe(200);
    expect(moved.body.admin).toMatchObject({ role: 'agent', permissions: ['referrals.view_own'] });

    const third = await makeUser();
    notHeld(await grant(manager, { email: third.email, role: 'agent', permissions: ['referrals.view_own', 'plans.view'] }));
  });

  it('lets a creator give anything, with no key on the row', async () => {
    const creator = await makePlatformUser('creator');
    await db.User.update({ platformPermissions: [] }, { where: { id: creator.userId } });
    const person = await makeUser();
    const given = await grant(creator, { email: person.email, role: 'admin' });
    expect(given.status).toBe(201);
    const made = await createRole(creator, { name: 'Everything but', permissions: ['plans.manage', 'risk.manage'] });
    expect(made.status).toBe(201);
    expect((await editRole(creator, made.body.role.key, { name: 'Renamed by creator' })).status).toBe(200);
  });

  it('keeps a custom role with a key the author lacks out of their reach, whatever they mean to do', async () => {
    const creator = await makePlatformUser('creator');
    const { body } = await createRole(creator, { name: 'Higher', permissions: ['support.view', 'plans.manage'] });
    const key = body.role.key;
    const outsider = await adminHolding(['admins.manage', 'support.view']);

    notHeld(await editRole(outsider, key, { name: 'Renamed' }));
    notHeld(await editRole(outsider, key, { permissions: ['support.view', 'plans.manage'] }));
    notHeld(await editRole(outsider, key, { permissions: ['support.view'] }));
    notHeld(await editRole(outsider, key, { permissions: ['support.view', 'plans.manage', 'risk.view'] }));
    notHeld(await removeRole(outsider, key));
    const kept = await db.PlatformRole.findByPk(key);
    expect(kept.name).toBe('Higher');
    expect(kept.defaultPermissions).toEqual(['support.view', 'plans.manage']);
  });

  it('lets the author edit and delete a role within what they hold, and add nothing beyond it', async () => {
    const creator = await makePlatformUser('creator');
    const { body } = await createRole(creator, { name: 'Within', permissions: ['support.view'] });
    const key = body.role.key;
    const manager = await adminHolding(['admins.manage', 'support.view', 'support.manage']);

    expect((await editRole(manager, key, { name: 'Renamed', permissions: ['support.view', 'support.manage'] })).status).toBe(200);
    notHeld(await editRole(manager, key, { permissions: ['support.view', 'plans.view'] }));
    expect((await editRole(manager, key, { permissions: ['*'] })).status).toBe(422);
    expect((await removeRole(manager, key)).status).toBe(200);
  });

});

describe('nobody touches an account above them', () => {
  const notHeld = (res) => {
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_NOT_HELD');
  };

  it('refuses taking a key, changing the role or revoking, and leaves the account as it was', async () => {
    const above = await adminHolding(['plans.manage', 'support.view']);
    const manager = await adminHolding(['admins.manage', 'support.view', 'support.manage']);

    notHeld(await edit(manager, above.userId, { permissions: ['support.view'] }));
    notHeld(await edit(manager, above.userId, { permissions: [] }));
    notHeld(await edit(manager, above.userId, { role: 'agent' }));
    notHeld(await request(app).delete(`/api/v1/admin/admins/${above.userId}`).set(manager.H));
    // Not taking anything, and only what the manager holds: still not theirs to touch.
    notHeld(await edit(manager, above.userId, { permissions: ['plans.manage', 'support.view', 'support.manage'] }));

    const row = await db.User.findByPk(above.userId);
    expect(row.platformRole).toBe('admin');
    expect(row.platformPermissions).toEqual(['plans.manage', 'support.view']);
    expect(await audits('platform_admin.update')).toHaveLength(0);
    expect(await audits('platform_admin.revoke')).toHaveLength(0);
  });

  it('lets them act on an account within what they hold, an equal one included', async () => {
    const manager = await adminHolding(['admins.manage', 'support.view', 'support.manage']);

    const below = await adminHolding(['support.view', 'support.manage']);
    const trimmed = await edit(manager, below.userId, { permissions: ['support.view'] });
    expect(trimmed.status).toBe(200);
    expect(trimmed.body.admin.permissions).toEqual(['support.view']);
    expect((await request(app).delete(`/api/v1/admin/admins/${below.userId}`).set(manager.H)).status).toBe(200);
    expect((await db.User.findByPk(below.userId)).platformRole).toBeNull();

    const peer = await adminHolding(['admins.manage', 'support.view', 'support.manage']);
    expect((await edit(manager, peer.userId, { permissions: ['support.view'] })).status).toBe(200);

    const noKeys = await adminHolding([]);
    expect((await request(app).delete(`/api/v1/admin/admins/${noKeys.userId}`).set(manager.H)).status).toBe(200);
  });

  it("doesn't count an agent's own key, and does count anything else on the agent", async () => {
    const manager = await adminHolding(['admins.manage', 'support.view']);

    const agent = await makePlatformUser('agent');
    const moved = await edit(manager, agent.userId, { permissions: ['referrals.view_own', 'support.view'] });
    expect(moved.status).toBe(200);
    const plain = await makePlatformUser('agent');
    expect((await request(app).delete(`/api/v1/admin/admins/${plain.userId}`).set(manager.H)).status).toBe(200);

    const widened = await makePlatformUser('agent');
    await db.User.update({ platformPermissions: ['referrals.view_own', 'plans.manage'] }, { where: { id: widened.userId } });
    notHeld(await request(app).delete(`/api/v1/admin/admins/${widened.userId}`).set(manager.H));
  });

  it('lets a creator through, with no key on the row', async () => {
    const creator = await makePlatformUser('creator');
    await db.User.update({ platformPermissions: [] }, { where: { id: creator.userId } });
    const above = await adminHolding(['plans.manage', 'risk.manage', 'admins.manage']);

    expect((await edit(creator, above.userId, { permissions: ['plans.view'] })).status).toBe(200);
    expect((await request(app).delete(`/api/v1/admin/admins/${above.userId}`).set(creator.H)).status).toBe(200);
  });

  it("answers about someone's own account as it always did", async () => {
    const manager = await adminHolding(['admins.manage', 'support.view']);

    const own = await edit(manager, manager.userId, { permissions: ['support.view'] });
    expect(own.status).toBe(409);
    expect(own.body.error.code).toBe('CANNOT_EDIT_SELF');
    const revoked = await request(app).delete(`/api/v1/admin/admins/${manager.userId}`).set(manager.H);
    expect(revoked.status).toBe(409);
    expect(revoked.body.error.code).toBe('CANNOT_REVOKE_SELF');

    const renamed = await request(app).patch('/api/v1/auth/me/name').set(manager.H).send({ fullName: 'Renamed Self' });
    expect(renamed.status).toBe(200);
    expect((await db.User.findByPk(manager.userId)).fullName).toBe('Renamed Self');
  });

  it('refuses reaching one through a role they hold, by editing that role', async () => {
    const creator = await makePlatformUser('creator');
    const { body } = await createRole(creator, { name: 'Shared', permissions: ['support.view'] });
    const key = body.role.key;
    const above = await makeUser();
    await grant(creator, { email: above.email, role: key });
    await db.User.update({ platformPermissions: ['support.view', 'plans.manage'] }, { where: { id: above.userId } });
    const manager = await adminHolding(['admins.manage', 'support.view', 'support.manage']);

    notHeld(await editRole(manager, key, { permissions: [] }));
    notHeld(await editRole(manager, key, { permissions: ['support.view', 'support.manage'] }));
    notHeld(await editRole(manager, key, { name: 'Renamed' }));
    expect((await db.User.findByPk(above.userId)).platformPermissions).toEqual(['support.view', 'plans.manage']);

    // With that account moved off it, the role is theirs to edit again.
    expect((await edit(creator, above.userId, { role: 'agent' })).status).toBe(200);
    expect((await editRole(manager, key, { permissions: ['support.view', 'support.manage'] })).status).toBe(200);
  });

  it('refuses deleting a role holding a key they lack, and lets them delete one within reach', async () => {
    const creator = await makePlatformUser('creator');
    const higher = await createRole(creator, { name: 'Beyond', permissions: ['plans.manage'] });
    const within = await createRole(creator, { name: 'Within reach', permissions: ['support.view'] });
    const manager = await adminHolding(['admins.manage', 'support.view']);

    notHeld(await removeRole(manager, higher.body.role.key));
    expect(await db.PlatformRole.findByPk(higher.body.role.key)).not.toBeNull();
    expect((await removeRole(manager, within.body.role.key)).status).toBe(200);
    expect((await removeRole(creator, higher.body.role.key)).status).toBe(200);
  });
});

describe('who holds everything', () => {
  it('a creator, whatever their row says', async () => {
    const creator = await makePlatformUser('creator');
    await db.User.update({ platformPermissions: [] }, { where: { id: creator.userId } });
    expect((await read(creator, '/plans')).status).toBe(200);
    expect((await read(creator, '/admins')).status).toBe(200);
  });

  it('nobody else, even with "*" written on their row', async () => {
    const admin = await adminHolding(['*']);
    expect((await read(admin, '/plans')).status).toBe(403);
    expect((await read(admin, '/admins')).status).toBe(403);
  });

  it('a creator can\'t be given less than everything', async () => {
    const creator = await makePlatformUser('creator');
    const person = await makeUser();
    const res = await grant(creator, { email: person.email, role: 'creator', permissions: ['plans.view'] });
    expect(res.status).toBe(201);
    expect(res.body.admin.permissions).toEqual(['*']);
  });
});

describe('the payment methods page', () => {
  it('opens for whoever holds a key it edits', async () => {
    for (const key of ['payments.record', 'payment_methods.manage', 'payment_methods.edit_numbers']) {
      const admin = await adminHolding([key]);
      expect([key, (await read(admin, '/payment-methods')).status]).toEqual([key, 200]);
    }
    expect((await read(await adminHolding(['plans.view']), '/payment-methods')).status).toBe(403);
  });
});
