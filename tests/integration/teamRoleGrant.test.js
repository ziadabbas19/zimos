'use strict';

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');

/**
 * Nobody hands out more access than they hold (workspaceService.assertCanGrant):
 * a Workspace Manager (users.manage + roles.manage) can neither make themselves
 * Owner, nor demote or remove an Owner, nor give a permission they lack.
 */
async function setup() {
  const owner = await registerAndActivate({ fullName: 'Owner' });
  const workspace = await createWorkspace(owner.accessToken, 'Role Grant Workspace');
  const base = `/api/v1/workspaces/${workspace.id}`;
  const auth = (u) => ({ Authorization: `Bearer ${u.accessToken}` });

  const roles = (await request(app).get(`${base}/roles`).set(auth(owner))).body.roles;
  const role = (key) => roles.find((r) => r.key === key);

  const admin = await registerAndActivate({ fullName: 'Admin' });
  await request(app).post(`${base}/members`).set(auth(owner)).send({ email: admin.email, roleId: role('workspace_manager').id }).expect(201);

  const members = (await request(app).get(`${base}/members`).set(auth(owner))).body.members;
  const membershipOf = (u) => members.find((m) => m.user && m.user.email === u.email);
  return { owner, admin, base, auth, role, membershipOf };
}

describe('team role grants', () => {
  it('refuses a Workspace Manager making themselves Owner', async () => {
    const { admin, base, auth, role, membershipOf } = await setup();
    const res = await request(app)
      .patch(`${base}/members/${membershipOf(admin).id}`)
      .set(auth(admin))
      .send({ roleId: role('owner').id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ROLE_ABOVE_YOURS');
  });

  it('refuses a Workspace Manager removing an Owner, even when a second Owner exists', async () => {
    const { owner, admin, base, auth, role, membershipOf } = await setup();
    const owner2 = await registerAndActivate({ fullName: 'Second Owner' });
    await request(app).post(`${base}/members`).set(auth(owner)).send({ email: owner2.email, roleId: role('owner').id }).expect(201);

    const res = await request(app).delete(`${base}/members/${membershipOf(owner).id}`).set(auth(admin));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ROLE_ABOVE_YOURS');
  });

  it('refuses inviting with the Owner role or creating a role above the caller', async () => {
    const { admin, base, auth, role } = await setup();
    const someone = await registerAndActivate({ fullName: 'Someone' });

    const invite = await request(app).post(`${base}/members`).set(auth(admin)).send({ email: someone.email, roleId: role('owner').id });
    expect(invite.status).toBe(403);
    expect(invite.body.error.code).toBe('ROLE_ABOVE_YOURS');

    const created = await request(app)
      .post(`${base}/roles`)
      .set(auth(admin))
      .send({ name: 'Billing', key: 'billing_only', permissions: ['billing.manage'] });
    expect(created.status).toBe(403);
    expect(created.body.error.code).toBe('ROLE_ABOVE_YOURS');
  });

  it('still lets a Workspace Manager work within their own access, and the Owner promote them', async () => {
    const { owner, admin, base, auth, role, membershipOf } = await setup();

    const created = await request(app)
      .post(`${base}/roles`)
      .set(auth(admin))
      .send({ name: 'Products', key: 'products_only', permissions: ['products.view', 'products.manage'] });
    expect(created.status).toBe(201);

    const someone = await registerAndActivate({ fullName: 'Someone' });
    await request(app).post(`${base}/members`).set(auth(admin)).send({ email: someone.email, roleId: created.body.role.id }).expect(201);

    const promoted = await request(app)
      .patch(`${base}/members/${membershipOf(admin).id}`)
      .set(auth(owner))
      .send({ roleId: role('owner').id });
    expect(promoted.status).toBe(200);
    // The answer carries the role the teammate now has.
    expect(promoted.body.membership.roleId).toBe(role('owner').id);
    expect(promoted.body.membership.role.key).toBe('owner');
  });
});

describe('team changes by a member whose own access just changed', () => {
  const db = require('../../src/db/models');
  const workspaceService = require('../../src/modules/workspaces/workspaceService');

  // The request as it was authenticated while the member was still a Workspace
  // Manager: req.tenant is the copy resolveTenant built then.
  async function staleManager() {
    const ctx = await setup();
    const workspaceId = ctx.base.split('/').pop();
    const managerPermissions = ctx.role('workspace_manager').permissions;
    const req = {
      user: { id: ctx.admin.userId },
      tenant: { workspaceId, role: ctx.role('workspace_manager'), hasPermission: (p) => managerPermissions.includes(p) },
      headers: {},
    };
    return { ...ctx, workspaceId, req };
  }
  const demote = (ctx) =>
    request(app).patch(`${ctx.base}/members/${ctx.membershipOf(ctx.admin).id}`).set(ctx.auth(ctx.owner)).send({ roleId: ctx.role('editor').id }).expect(200);

  it('cannot finish an invite, a role change or a new role with the access they had', async () => {
    const ctx = await staleManager();
    const someone = await registerAndActivate({ fullName: 'Someone' });
    const other = await registerAndActivate({ fullName: 'Other' });
    await request(app).post(`${ctx.base}/members`).set(ctx.auth(ctx.owner)).send({ email: other.email, roleId: ctx.role('editor').id }).expect(201);
    const otherMembership = await db.Membership.findOne({ where: { workspaceId: ctx.workspaceId, userId: other.userId } });
    await demote(ctx);

    await expect(
      workspaceService.inviteMember({ workspaceId: ctx.workspaceId, email: someone.email, roleId: ctx.role('editor').id }, ctx.req)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await db.Membership.count({ where: { workspaceId: ctx.workspaceId, userId: someone.userId } })).toBe(0);

    await expect(
      workspaceService.updateMemberRole({ workspaceId: ctx.workspaceId, membershipId: otherMembership.id, roleId: ctx.role('order_operator').id }, ctx.req)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await db.Membership.findByPk(otherMembership.id)).roleId).toBe(ctx.role('editor').id);

    await expect(
      workspaceService.createCustomRole({ workspaceId: ctx.workspaceId, name: 'Late', key: 'late_role', permissions: ['website.edit'] }, ctx.req)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await db.Role.count({ where: { workspaceId: ctx.workspaceId, key: 'late_role' } })).toBe(0);
  });

  it('a member removed from the store cannot finish one either', async () => {
    const ctx = await staleManager();
    const someone = await registerAndActivate({ fullName: 'Someone' });
    await request(app).delete(`${ctx.base}/members/${ctx.membershipOf(ctx.admin).id}`).set(ctx.auth(ctx.owner)).expect(200);
    await expect(
      workspaceService.inviteMember({ workspaceId: ctx.workspaceId, email: someone.email, roleId: ctx.role('editor').id }, ctx.req)
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('two Owners demoting each other at the same moment never leave the store without one', async () => {
    for (let round = 0; round < 3; round += 1) {
      const ctx = await setup();
      const workspaceId = ctx.base.split('/').pop();
      const owner2 = await registerAndActivate({ fullName: 'Second Owner' });
      await request(app).post(`${ctx.base}/members`).set(ctx.auth(ctx.owner)).send({ email: owner2.email, roleId: ctx.role('owner').id }).expect(201);
      const idOf = async (u) => (await db.Membership.findOne({ where: { workspaceId, userId: u.userId } })).id;
      const [first, second] = await Promise.all([
        request(app).patch(`${ctx.base}/members/${await idOf(owner2)}`).set(ctx.auth(ctx.owner)).send({ roleId: ctx.role('editor').id }),
        request(app).patch(`${ctx.base}/members/${await idOf(ctx.owner)}`).set(ctx.auth(owner2)).send({ roleId: ctx.role('editor').id }),
      ]);
      // One goes through; the other finds itself no longer an Owner, or the last one. Never a deadlock.
      expect([first.status, second.status].filter((s) => s === 200)).toHaveLength(1);
      expect([first.status, second.status].some((s) => [403, 404, 409].includes(s))).toBe(true);
      expect(await db.Membership.count({ where: { workspaceId, roleId: ctx.role('owner').id, status: 'active' } })).toBe(1);
    }
  });
});
