'use strict';

const { app, request, registerAndActivate, createWorkspace, createProductWithVariant } = require('../helpers/factories');
const db = require('../../src/db/models');

/**
 * Proves authorization is enforced server-side, not just hidden in a
 * frontend: a Confirmation Agent (who only has orders.view/orders.confirm/
 * customers.view) is denied product-management and inventory-management
 * actions even when they hit the API directly with a valid token for a
 * workspace they really do belong to.
 */
describe('RBAC', () => {
  it('a Confirmation Agent cannot manage products despite being a real member of the workspace', async () => {
    const owner = await registerAndActivate({ fullName: 'Owner' });
    const workspace = await createWorkspace(owner.accessToken, 'RBAC Test Workspace');
    const { product } = await createProductWithVariant(owner.accessToken, workspace.id);

    const agent = await registerAndActivate({ fullName: 'Confirmation Agent' });
    const agentRole = await db.Role.findOne({ where: { workspaceId: workspace.id, key: 'confirmation_agent' } });

    await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/members`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ email: agent.email, roleId: agentRole.id })
      .expect(201);

    // The agent IS a real member of this workspace now — resolveTenant
    // succeeds — but requirePermission must still block product management.
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/catalog/products`)
      .set('Authorization', `Bearer ${agent.accessToken}`)
      .send({ name: 'Should Not Be Allowed', status: 'active' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');

    // But the agent CAN view/confirm orders, per their role.
    const queueRes = await request(app)
      .get(`/api/v1/workspaces/${workspace.id}/confirmation-tasks`)
      .set('Authorization', `Bearer ${agent.accessToken}`);
    expect(queueRes.status).toBe(200);
  });

  it('a custom role is limited to exactly the permissions it was granted', async () => {
    const owner = await registerAndActivate({ fullName: 'Owner' });
    const workspace = await createWorkspace(owner.accessToken, 'Custom Role Workspace');

    const roleRes = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/roles`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Inventory Only', key: 'inventory_only', permissions: ['inventory.view', 'inventory.manage'] });
    expect(roleRes.status).toBe(201);

    const staffer = await registerAndActivate({ fullName: 'Inventory Staffer' });
    await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/members`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ email: staffer.email, roleId: roleRes.body.role.id })
      .expect(201);

    // Allowed: inventory management.
    const { variant } = await createProductWithVariant(owner.accessToken, workspace.id, { stock: 5 });
    const adjustRes = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/inventory/${variant.id}/adjust`)
      .set('Authorization', `Bearer ${staffer.accessToken}`)
      .send({ delta: 5, reason: 'recount' });
    expect(adjustRes.status).toBe(200);

    // Denied: this custom role was never granted products.manage.
    const productRes = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/catalog/products`)
      .set('Authorization', `Bearer ${staffer.accessToken}`)
      .send({ name: 'Nope', status: 'active' });
    expect(productRes.status).toBe(403);
  });

  it('the last Owner of a workspace cannot be demoted or removed', async () => {
    const owner = await registerAndActivate({ fullName: 'Sole Owner' });
    const workspace = await createWorkspace(owner.accessToken, 'Single Owner Workspace');

    const ownerMembership = await db.Membership.findOne({ where: { workspaceId: workspace.id } });
    const managerRole = await db.Role.findOne({ where: { workspaceId: workspace.id, key: 'workspace_manager' } });

    const demoteRes = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/members/${ownerMembership.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ roleId: managerRole.id });
    expect(demoteRes.status).toBe(409);
    expect(demoteRes.body.error.code).toBe('LAST_OWNER');
  });
});
