'use strict';

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');

/**
 * GET /workspaces/:workspaceId/roles lists every role available in a
 * workspace — the system roles seeded at creation time plus any custom
 * roles the workspace has defined — for the "assign a role" pickers in the
 * members UI. Requires users.manage, same as the rest of /members.
 */
describe('GET /workspaces/:workspaceId/roles', () => {
  it('returns the seeded system roles, including Owner', async () => {
    const owner = await registerAndActivate({ fullName: 'Owner' });
    const workspace = await createWorkspace(owner.accessToken, 'Roles List Workspace');

    const res = await request(app)
      .get(`/api/v1/workspaces/${workspace.id}/roles`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.roles)).toBe(true);
    expect(res.body.roles.length).toBeGreaterThanOrEqual(1);

    const ownerRole = res.body.roles.find((r) => r.key === 'owner');
    expect(ownerRole).toBeDefined();
    expect(ownerRole.isSystem).toBe(true);
  });

  it('includes custom roles alongside the system ones, system roles first', async () => {
    const owner = await registerAndActivate({ fullName: 'Owner' });
    const workspace = await createWorkspace(owner.accessToken, 'Custom Roles Workspace');

    const created = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/roles`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Inventory Only', key: 'inventory_only', permissions: ['inventory.view', 'inventory.manage'] });
    expect(created.status).toBe(201);

    const res = await request(app)
      .get(`/api/v1/workspaces/${workspace.id}/roles`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);

    const keys = res.body.roles.map((r) => r.key);
    expect(keys).toContain('owner');
    expect(keys).toContain('inventory_only');

    // order: [['isSystem', 'DESC'], ['name', 'ASC']] — every system role
    // sorts ahead of the custom one.
    const firstCustomIdx = res.body.roles.findIndex((r) => !r.isSystem);
    const lastSystemIdx = res.body.roles.map((r) => r.isSystem).lastIndexOf(true);
    expect(lastSystemIdx).toBeLessThan(firstCustomIdx);
  });

  it('is denied to a member without users.manage', async () => {
    const owner = await registerAndActivate({ fullName: 'Owner' });
    const workspace = await createWorkspace(owner.accessToken, 'Roles RBAC Workspace');

    const rolesRes = await request(app)
      .get(`/api/v1/workspaces/${workspace.id}/roles`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    const editorRole = rolesRes.body.roles.find((r) => r.key === 'editor');

    const editor = await registerAndActivate({ fullName: 'Editor' });
    await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/members`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ email: editor.email, roleId: editorRole.id })
      .expect(201);

    const denied = await request(app)
      .get(`/api/v1/workspaces/${workspace.id}/roles`)
      .set('Authorization', `Bearer ${editor.accessToken}`);
    expect(denied.status).toBe(403);
  });
});
