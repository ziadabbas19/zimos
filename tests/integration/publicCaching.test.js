'use strict';

// Only what is the same for everyone may be kept by a browser or a shared
// cache: the public plans and the template gallery, for a minute, then
// revalidated by ETag. A signed-in member's answers never say "public".

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');

describe('public caching', () => {
  for (const path of ['/api/v1/plans/public', '/api/v1/templates', '/api/v1/templates?kind=store']) {
    it(`${path}: public for a minute, with an ETag that answers 304 when unchanged`, async () => {
      const first = await request(app).get(path);
      expect(first.status).toBe(200);
      expect(first.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=300');
      expect(first.headers.etag).toBeTruthy();

      const again = await request(app).get(path).set('If-None-Match', first.headers.etag);
      expect(again.status).toBe(304);
    });
  }

  it('never marks a member’s own answers public', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const H = { Authorization: `Bearer ${auth.accessToken}` };

    for (const path of ['/api/v1/workspaces', `/api/v1/workspaces/${workspace.id}/access`, '/api/v1/auth/me']) {
      const res = await request(app).get(path).set(H);
      expect(res.status).toBe(200);
      expect(String(res.headers['cache-control'] || '')).not.toMatch(/public/);
    }
  });
});
