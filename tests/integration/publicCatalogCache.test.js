'use strict';

// STOREFRONT_API_CACHE_ENABLED: Cache-Control on the public catalogue's GETs.

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { generateProductCode } = require('../../src/modules/catalog/catalogService');

async function store() {
  const owner = await registerAndActivate();
  const workspace = await createWorkspace(owner.accessToken, 'Catalogue Store');
  const product = await db.Product.create({
    workspaceId: workspace.id,
    name: 'Lamp',
    slug: `lamp-${Date.now()}`,
    productCode: generateProductCode(),
    status: 'active',
    description: 'A long description of a lamp',
    seo: { title: 'Lamp title' },
    cms: { features: [{ title: 'Bright' }] },
    pageSettings: { countdown: { ends_at: '2020-01-01T00:00:00.000Z' } },
    media: [{ url: 'https://media.example.com/lamp.webp' }],
  });
  await db.ProductVariant.create({ workspaceId: workspace.id, productId: product.id, sku: `L-${Date.now()}`, priceAmount: 5000, compareAtAmount: 9000, stockOnHand: 3 });
  return { id: workspace.id, slug: workspace.slug, product };
}

const ORIGINAL = { ...env.storefrontPerf.apiCache };
const PUBLIC = 'public, max-age=0, s-maxage=30, stale-while-revalidate=60';

afterEach(() => {
  Object.assign(env.storefrontPerf.apiCache, ORIGINAL);
  env.visitorGate.enabled = false;
});

describe('Cache-Control on the public catalogue', () => {
  it('is off by default: no such header and no Vary from it, on any route', async () => {
    expect(env.storefrontPerf.apiCache.enabled).toBe(false);
    const s = await store();
    for (const path of ['', '/products', `/products/${s.product.slug}`, '/collections']) {
      const res = await request(app).get(`/api/v1/store/${s.id}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control'] === undefined || !/s-maxage/.test(res.headers['cache-control'])).toBe(true);
      expect(res.headers.vary || '').not.toMatch(/X-Store-Locale/i);
    }
  });

  describe('switched on', () => {
    beforeEach(() => {
      env.storefrontPerf.apiCache.enabled = true;
    });

    it('marks the catalogue, with the shopper\'s language in Vary', async () => {
      const s = await store();
      for (const path of ['', '/products', '/products?search=lamp', `/products/${s.product.slug}`, '/collections']) {
        const res = await request(app).get(`/api/v1/store/${s.id}${path}`);
        expect(res.status).toBe(200);
        expect([path, res.headers['cache-control']]).toEqual([path, PUBLIC]);
        expect(res.headers.vary).toMatch(/X-Store-Locale/i);
      }
    });

    it('never marks a request that names someone', async () => {
      const s = await store();
      for (const header of ['X-Store-Preview', 'X-Shopper-Token', 'X-Cart-Token', 'X-Student-Token', 'X-Visitor-Id', 'Authorization', 'Cookie']) {
        const res = await request(app).get(`/api/v1/store/${s.id}/products`).set(header, 'something');
        expect([header, /s-maxage/.test(res.headers['cache-control'] || '')]).toEqual([header, false]);
      }
    });

    it('never marks an answer that is not a 200, or anything that is not a catalogue read', async () => {
      const s = await store();
      const missing = await request(app).get(`/api/v1/store/${s.id}/products/no-such-product`);
      expect(missing.status).toBe(404);
      expect(missing.headers['cache-control'] || '').not.toMatch(/s-maxage/);
      const gone = await request(app).get('/api/v1/store/no-such-store/products');
      expect(gone.status).toBe(404);
      expect(gone.headers['cache-control'] || '').not.toMatch(/s-maxage/);
      const suggest = await request(app).get(`/api/v1/store/${s.id}/products/suggest?q=lamp`);
      expect(suggest.headers['cache-control'] || '').not.toMatch(/s-maxage/);
    });

    it('stays off while the visitor gate is on: a kept copy would reach a blocked visitor', async () => {
      env.visitorGate.enabled = true;
      const s = await store();
      const res = await request(app).get(`/api/v1/store/${s.id}/products`);
      expect(res.headers['cache-control'] || '').not.toMatch(/s-maxage/);
    });

    it('takes its numbers from settings', async () => {
      env.storefrontPerf.apiCache.sMaxage = 10;
      env.storefrontPerf.apiCache.swr = 0;
      const s = await store();
      const res = await request(app).get(`/api/v1/store/${s.id}/products`);
      expect(res.headers['cache-control']).toBe('public, max-age=0, s-maxage=10');
    });

    it('answers 304 to the same ETag', async () => {
      const s = await store();
      const first = await request(app).get(`/api/v1/store/${s.id}/products`);
      expect(first.headers.etag).toBeTruthy();
      const again = await request(app).get(`/api/v1/store/${s.id}/products`).set('If-None-Match', first.headers.etag);
      expect(again.status).toBe(304);
    });
  });
});
