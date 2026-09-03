'use strict';

// Every product carries a distinct 9-digit `productCode`, assigned by the
// server (not the UUID PK, not the ORD-.../zg... patterns), unique, and
// generated with a collision-retry loop.

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const catalogService = require('../../src/modules/catalog/catalogService');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const PATTERN = /^\d{9}$/;

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken);
  return { auth, workspace, H: bearer(auth.accessToken) };
}

const createProduct = (workspaceId, H, body = {}) =>
  request(app)
    .post(`/api/v1/workspaces/${workspaceId}/catalog/products`)
    .set(H)
    .send({ name: `P ${Math.random().toString(36).slice(2)}`, status: 'active', ...body });

describe('product code', () => {
  it('generateProductCode always produces exactly 9 digits', () => {
    for (let i = 0; i < 2000; i++) {
      expect(catalogService.generateProductCode()).toMatch(PATTERN);
    }
  });

  it('a created product gets a 9-digit productCode, distinct from its id', async () => {
    const { workspace, H } = await setup();
    const res = await createProduct(workspace.id, H);
    expect(res.status).toBe(201);
    expect(res.body.product.productCode).toMatch(PATTERN);
    expect(res.body.product.productCode).not.toBe(res.body.product.id);

    const row = await db.Product.findByPk(res.body.product.id);
    expect(row.productCode).toBe(res.body.product.productCode);
  });

  it('returns the productCode in get, list and update responses and never changes it', async () => {
    const { workspace, H } = await setup();
    const created = await createProduct(workspace.id, H);
    const { id, productCode } = created.body.product;

    const got = await request(app).get(`/api/v1/workspaces/${workspace.id}/catalog/products/${id}`).set(H);
    expect(got.body.product.productCode).toBe(productCode);

    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/catalog/products`).set(H);
    const listed = list.body.products.find((p) => p.id === id);
    expect(listed.productCode).toBe(productCode);

    // PATCH cannot set it, and it survives an unrelated edit
    const patched = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/catalog/products/${id}`)
      .set(H)
      .send({ description: 'edited', productCode: '000000001' });
    expect(patched.status).toBe(200);
    expect(patched.body.product.productCode).toBe(productCode);
  });

  it('ignores a client-supplied productCode on create', async () => {
    const { workspace, H } = await setup();
    const res = await createProduct(workspace.id, H, { productCode: '123456789' });
    expect(res.status).toBe(201);
    expect(res.body.product.productCode).not.toBe('123456789');
    expect(res.body.product.productCode).toMatch(PATTERN);
  });

  it('codes stay unique and well-formed under concurrent product creation', async () => {
    const { workspace, H } = await setup();

    const results = await Promise.all(Array.from({ length: 25 }, () => createProduct(workspace.id, H)));
    expect(results.every((r) => r.status === 201)).toBe(true);

    const codes = results.map((r) => r.body.product.productCode);
    expect(codes.every((c) => PATTERN.test(c))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length); // all distinct

    // the DB unique index agrees
    const rows = await db.Product.findAll({ where: { workspaceId: workspace.id }, attributes: ['productCode'] });
    expect(new Set(rows.map((r) => r.productCode)).size).toBe(rows.length);
    expect(rows.every((r) => PATTERN.test(r.productCode))).toBe(true);
  });
});
