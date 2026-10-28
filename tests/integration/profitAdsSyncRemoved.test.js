'use strict';

// POST /profit/ads/sync called a syncSpend that was never defined (a 500 on
// every call) and nothing called it: the route is gone, and spend comes in by
// hand or from a CSV.

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const profitRoutes = require('../../src/modules/profit/profitRoutes');

describe('ad spend sync', () => {
  it('is no longer a route', () => {
    const paths = profitRoutes.stack.filter((layer) => layer.route).map((layer) => layer.route.path);
    expect(paths).not.toContain('/ads/sync');
    expect(paths).toContain('/ad-spend/import');
  });

  it('answers 404, not 500, for an owner', async () => {
    const owner = await registerAndActivate();
    const workspace = await createWorkspace(owner.accessToken, 'Ads Co');
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/profit/ads/sync`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(404);
  });
});
