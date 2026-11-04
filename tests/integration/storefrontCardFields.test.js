'use strict';

// `?fields=card` on the product list: only what a product card draws.

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

describe('?fields=card on the product list', () => {
  const OMITTED = ['description', 'seo', 'cms'];

  it('leaves the list as it always was without it', async () => {
    const s = await store();
    const { body } = await request(app).get(`/api/v1/store/${s.id}/products`);
    expect(body.products[0].description).toBe('A long description of a lamp');
    expect(body.products[0].seo).toEqual({ title: 'Lamp title' });
    expect(body.products[0].cms).toBeDefined();
    const listing = await request(app).get(`/api/v1/store/${s.id}/products`).query({ sort: 'newest' });
    expect(listing.body.products[0].description).toBe('A long description of a lamp');
  });

  it.each([
    ['the plain list', {}],
    ['the listing', { sort: 'newest' }],
    ['a search', { search: 'lamp' }],
  ])('%s: only those fields go, on both paths', async (_name, query) => {
    const s = await store();
    const full = await request(app).get(`/api/v1/store/${s.id}/products`).query(query);
    const card = await request(app).get(`/api/v1/store/${s.id}/products`).query({ ...query, fields: 'card' });
    expect(card.status).toBe(200);
    const [a, b] = [full.body.products[0], card.body.products[0]];
    for (const field of OMITTED) expect(b).not.toHaveProperty(field);
    const rest = { ...a };
    for (const field of OMITTED) delete rest[field];
    expect(b).toEqual(rest);
  });

  it('a card\'s price still follows its countdown: the settings it depends on are still read', async () => {
    const s = await store();
    const card = await request(app).get(`/api/v1/store/${s.id}/products`).query({ fields: 'card' });
    // The countdown above has ended: the full price, as on the whole product.
    expect(String(card.body.products[0].variants[0].priceAmount)).toBe('9000');
    expect(card.body.products[0].variants[0].compareAtAmount).toBeNull();
  });

  it('does not read the columns it leaves out', async () => {
    const s = await store();
    const seen = [];
    const original = db.sequelize.options.logging;
    db.sequelize.options.logging = (sql) => seen.push(String(sql));
    try {
      await request(app).get(`/api/v1/store/${s.id}/products`).query({ fields: 'card' });
    } finally {
      db.sequelize.options.logging = original;
    }
    const read = seen.filter((sql) => /FROM "products" AS "Product"/.test(sql));
    expect(read.length).toBeGreaterThan(0);
    for (const sql of read) expect(sql).not.toMatch(/"Product"\."description"/);
  });

  it('a translation cannot put a left-out field back', async () => {
    const s = await store();
    await db.Workspace.update({ supportedLocales: ['ar', 'en'] }, { where: { id: s.id } }).catch(() => undefined);
    const translations = require('../../src/modules/translations/translations');
    jest.spyOn(translations, 'localizeProducts').mockImplementation(async (_req, products) => {
      for (const p of products) p.description = 'translated';
      return products;
    });
    const res = await request(app).get(`/api/v1/store/${s.id}/products`).query({ fields: 'card' });
    jest.restoreAllMocks();
    expect(res.body.products[0]).not.toHaveProperty('description');
  });

  it('refuses any other value', async () => {
    const s = await store();
    const res = await request(app).get(`/api/v1/store/${s.id}/products`).query({ fields: 'everything' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
