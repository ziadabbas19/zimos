'use strict';

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const env = require('../../src/config/env');
const { isStorefrontApiPath } = require('../../src/core/middleware/cors');

const RANDOM_ORIGIN = 'https://random-store.example';
const ALLOWED_ORIGIN = env.cors.origins[0];

function headerList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function preflight(path, origin, { method = 'POST', headers = 'content-type' } = {}) {
  return request(app)
    .options(path)
    .set('Origin', origin)
    .set('Access-Control-Request-Method', method)
    .set('Access-Control-Request-Headers', headers);
}

describe('CORS', () => {
  describe('public storefront API (/api/v1/store/*)', () => {
    let workspace;

    beforeEach(async () => {
      ({ workspace } = await setupWorkspaceWithProduct());
    });

    it('answers a preflight from any origin with *, the storefront headers and no credentials', async () => {
      const res = await preflight(`/api/v1/store/${workspace.id}/checkout`, RANDOM_ORIGIN, {
        headers: 'content-type,x-cart-token,idempotency-key',
      });

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(headerList(res.headers['access-control-allow-headers']).sort()).toEqual(
        ['content-type', 'idempotency-key', 'x-cart-token']
      );
      expect(headerList(res.headers['access-control-allow-methods'])).toEqual(
        expect.arrayContaining(['get', 'post', 'patch', 'delete'])
      );
      expect(res.headers['access-control-max-age']).toBe('7200');
    });

    it('covers the bare /api/v1/store path too', async () => {
      const res = await preflight('/api/v1/store', RANDOM_ORIGIN, { method: 'GET' });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('does not allow the server-only storefront headers from a browser', async () => {
      const res = await preflight(`/api/v1/store/${workspace.id}/cart`, RANDOM_ORIGIN, {
        headers: 'content-type,x-storefront-secret,x-storefront-client-ip',
      });

      const allowed = headerList(res.headers['access-control-allow-headers']);
      expect(allowed).not.toContain('x-storefront-secret');
      expect(allowed).not.toContain('x-storefront-client-ip');
    });

    it('sends * and exposes Retry-After on an actual GET', async () => {
      const res = await request(app).get(`/api/v1/store/${workspace.id}`).set('Origin', RANDOM_ORIGIN);

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(headerList(res.headers['access-control-expose-headers'])).toContain('retry-after');
    });

    it('sends * and exposes Retry-After on an actual POST', async () => {
      const res = await request(app)
        .post(`/api/v1/store/${workspace.id}/cart`)
        .set('Origin', RANDOM_ORIGIN)
        .send({});

      expect(res.status).toBeLessThan(300);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(headerList(res.headers['access-control-expose-headers'])).toContain('retry-after');
    });

    it('also applies to store error responses, so the browser can read them', async () => {
      const res = await request(app)
        .get('/api/v1/store/00000000-0000-4000-8000-000000000000')
        .set('Origin', RANDOM_ORIGIN);

      expect(res.status).toBe(404);
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('still serves the server-side storefront client (secret header, no Origin)', async () => {
      const res = await request(app)
        .get(`/api/v1/store/${workspace.id}`)
        .set('X-Storefront-Secret', 'f'.repeat(64))
        .set('X-Storefront-Client-IP', '203.0.113.7');

      expect(res.status).toBe(200);
      expect(res.body.store).toBeDefined();
    });
  });

  describe('everything else (CORS_ORIGINS allowlist)', () => {
    let auth;
    let workspace;

    beforeEach(async () => {
      ({ auth, workspace } = await setupWorkspaceWithProduct());
    });

    it('gives an unknown origin no Access-Control-Allow-Origin on a dashboard route', async () => {
      const res = await request(app)
        .get('/api/v1/workspaces')
        .set('Origin', RANDOM_ORIGIN)
        .set('Authorization', `Bearer ${auth.accessToken}`);

      expect(res.status).toBe(200);
      // cors() still sends Allow-Credentials here (as it always has); without
      // Allow-Origin the browser blocks the response regardless.
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('does not answer a dashboard preflight from an unknown origin', async () => {
      const res = await preflight(`/api/v1/workspaces/${workspace.id}`, RANDOM_ORIGIN, {
        method: 'PATCH',
        headers: 'authorization,content-type',
      });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('echoes an allowed origin with credentials on a dashboard route', async () => {
      const res = await request(app)
        .get('/api/v1/workspaces')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Authorization', `Bearer ${auth.accessToken}`);

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('answers an allowed-origin dashboard preflight with that origin and credentials', async () => {
      const res = await preflight(`/api/v1/workspaces/${workspace.id}`, ALLOWED_ORIGIN, {
        method: 'PATCH',
        headers: 'authorization,content-type',
      });

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('keeps a path that only starts with "store" on the allowlist', async () => {
      const res = await preflight('/api/v1/storefront-x', RANDOM_ORIGIN, { method: 'GET' });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('isStorefrontApiPath', () => {
    it('matches /api/v1/store on a segment boundary only', () => {
      expect(isStorefrontApiPath('/api/v1/store')).toBe(true);
      expect(isStorefrontApiPath('/api/v1/store/')).toBe(true);
      expect(isStorefrontApiPath('/api/v1/store/ws/cart/items')).toBe(true);
      expect(isStorefrontApiPath('/API/V1/Store/ws')).toBe(true);

      expect(isStorefrontApiPath('/api/v1/storefront-x')).toBe(false);
      expect(isStorefrontApiPath('/api/v1/stores')).toBe(false);
      expect(isStorefrontApiPath('/api/v1/workspaces/ws/store')).toBe(false);
      expect(isStorefrontApiPath('/shop/ws')).toBe(false);
      expect(isStorefrontApiPath('/api/v2/store')).toBe(false);
    });
  });
});
