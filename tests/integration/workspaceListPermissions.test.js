'use strict';

// GET /workspaces names each store's role with its permissions, the list
// resolveTenant checks every route against — the dashboard shows a page only
// to a role its API lets in.

const { app, request, registerAndActivate, createWorkspace, addMemberWithRole } = require('../helpers/factories');
const { SYSTEM_ROLES } = require('../../src/core/security/permissions');

const listFor = async (accessToken) =>
  (await request(app).get('/api/v1/workspaces').set('Authorization', `Bearer ${accessToken}`)).body.workspaces;

describe('the store list', () => {
  it("gives each role's permissions: '*' for the owner, the role's own list for a teammate", async () => {
    const owner = await registerAndActivate();
    const workspace = await createWorkspace(owner.accessToken, 'Perm Co');

    const [own] = await listFor(owner.accessToken);
    expect(own.role).toEqual({ key: 'owner', name: 'Owner', permissions: ['*'] });

    for (const key of ['workspace_manager', 'editor', 'order_operator', 'confirmation_agent', 'accountant']) {
      const member = await addMemberWithRole(owner.accessToken, workspace.id, key, `Member ${key}`);
      const [entry] = await listFor(member.accessToken);
      expect(entry.workspace.id).toBe(workspace.id);
      expect(entry.role.key).toBe(key);
      expect([...entry.role.permissions].sort()).toEqual([...SYSTEM_ROLES[key].permissions].sort());
    }
  });
});
