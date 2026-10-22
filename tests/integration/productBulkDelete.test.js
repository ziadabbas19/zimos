'use strict';

// Bulk product delete (POST /catalog/products/bulk-delete) and the count
// behind "select all N" (GET /catalog/products/count): archive or delete for
// good by the single delete's rules, a chunk per request, ticked ids or every
// product the list's filters match up to the count's cut-off.

const {
  app,
  request,
  registerAndActivate,
  createWorkspace,
  createProductWithVariant,
  addMemberWithRole,
} = require('../helpers/factories');
const db = require('../../src/db/models');
const { BULK_DELETE_CHUNK } = require('../../src/modules/catalog/catalogBulk');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const catalog = (workspaceId) => `/api/v1/workspaces/${workspaceId}/catalog`;

async function freshWorkspace() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken);
  return { auth, workspace, H: bearer(auth.accessToken) };
}

/** Plain products straight in the table: many of them, fast. */
async function insertProducts(workspaceId, count, { name = 'Bulk', status = 'draft', createdAt } = {}) {
  const rows = Array.from({ length: count }, (_, i) => ({
    workspaceId,
    name: `${name} ${i + 1}`,
    slug: `${name.toLowerCase()}-${i + 1}-${Math.random().toString(36).slice(2, 8)}`,
    productCode: String(Math.floor(Math.random() * 1e9)).padStart(9, '0'),
    status,
    ...(createdAt ? { createdAt } : {}),
  }));
  return db.Product.bulkCreate(rows);
}

async function placeOrder(H, workspaceId, variantId) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(H)
    .set('Idempotency-Key', `ord-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({ items: [{ variantId, quantity: 1 }], contact: { fullName: 'Bulk Buyer', phone: '01000000001' }, paymentMethod: 'cod' });
  expect(res.status).toBe(201);
  return res.body.order;
}

async function sellInFunnel(H, workspaceId, productId, variantId) {
  const offer = await request(app)
    .post(`${catalog(workspaceId)}/products/${productId}/offers`)
    .set(H)
    .send({ name: 'Single', pricingMode: 'fixed', priceAmount: 1000, lines: [{ variantId, quantity: 1 }] });
  expect(offer.status).toBe(201);
  const funnel = await db.Funnel.create({ workspaceId, name: 'Upsell funnel' });
  await db.FunnelStep.create({ workspaceId, funnelId: funnel.id, key: 'upsell-1', stepType: 'upsell', name: 'Upsell', offerId: offer.body.offer.id });
  return funnel;
}

const bulkDelete = (H, workspaceId, body) => request(app).post(`${catalog(workspaceId)}/products/bulk-delete`).set(H).send(body);

describe('GET /catalog/products/count', () => {
  it('counts every product the list filters match, across pages, with the time it counted', async () => {
    const { workspace, H } = await freshWorkspace();
    await insertProducts(workspace.id, 3, { name: 'Shirt', status: 'active' });
    await insertProducts(workspace.id, 2, { name: 'Mug', status: 'draft' });
    await insertProducts(workspace.id, 1, { name: 'Old', status: 'archived' });

    const before = Date.now();
    const all = await request(app).get(`${catalog(workspace.id)}/products/count`).query({ status: 'draft,active' }).set(H);
    expect(all.status).toBe(200);
    expect(all.body.count).toBe(5);
    expect(new Date(all.body.asOf).getTime()).toBeGreaterThanOrEqual(before - 1000);

    const shirts = await request(app).get(`${catalog(workspace.id)}/products/count`).query({ status: 'draft,active', q: 'shirt' }).set(H);
    expect(shirts.body.count).toBe(3);
    const archived = await request(app).get(`${catalog(workspace.id)}/products/count`).query({ status: 'archived' }).set(H);
    expect(archived.body.count).toBe(1);
  });

  it('counts a collection filter once per product', async () => {
    const { workspace, H } = await freshWorkspace();
    const [a, b] = await insertProducts(workspace.id, 2);
    const collection = await db.Collection.create({ workspaceId: workspace.id, name: 'Summer', slug: 'summer' });
    await db.ProductCollection.create({ productId: a.id, collectionId: collection.id, position: 0 });
    const res = await request(app).get(`${catalog(workspace.id)}/products/count`).query({ collectionId: collection.id }).set(H);
    expect(res.body.count).toBe(1);
    expect(b.id).toBeTruthy();
  });
});

describe('POST /catalog/products/bulk-delete — ticked products', () => {
  it('archive: the same cascade and audit rows as the single archive, plus one summary row', async () => {
    const { auth, workspace, H } = await freshWorkspace();
    const one = await createProductWithVariant(auth.accessToken, workspace.id);
    const two = await createProductWithVariant(auth.accessToken, workspace.id);

    const res = await bulkDelete(H, workspace.id, { mode: 'archive', productIds: [one.product.id, two.product.id] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'archive', deleted: 2, skipped: [], nextCursor: null });

    for (const { product, variant } of [one, two]) {
      expect((await db.Product.findByPk(product.id)).status).toBe('archived');
      const v = await db.ProductVariant.findByPk(variant.id);
      expect(v.status).toBe('archived');
      expect(v.archivedWithProduct).toBe(true);
      expect(await db.AuditLog.count({ where: { action: 'product.delete', entityId: product.id } })).toBe(1);
    }
    const summary = await db.AuditLog.findOne({ where: { workspaceId: workspace.id, action: 'product.bulk_delete' } });
    expect(summary.metadata).toMatchObject({ mode: 'archive', deleted: 2, skipped: 0, by: 'ids' });
  });

  it('archive skips a product that is archived already', async () => {
    const { workspace, H } = await freshWorkspace();
    const [archived] = await insertProducts(workspace.id, 1, { status: 'archived' });
    const res = await bulkDelete(H, workspace.id, { mode: 'archive', productIds: [archived.id] });
    expect(res.body.deleted).toBe(0);
    expect(res.body.skipped).toEqual([{ id: archived.id, name: archived.name, reason: 'already_archived' }]);
  });

  it('permanent: deletes what the single delete would, skips orders and funnels with the reason', async () => {
    const { auth, workspace, H } = await freshWorkspace();
    const plain = await createProductWithVariant(auth.accessToken, workspace.id);
    const ordered = await createProductWithVariant(auth.accessToken, workspace.id);
    const funnelled = await createProductWithVariant(auth.accessToken, workspace.id);
    await placeOrder(H, workspace.id, ordered.variant.id);
    const funnel = await sellInFunnel(H, workspace.id, funnelled.product.id, funnelled.variant.id);

    const res = await bulkDelete(H, workspace.id, {
      mode: 'permanent',
      productIds: [plain.product.id, ordered.product.id, funnelled.product.id],
    });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
    expect(res.body.skipped).toEqual(
      expect.arrayContaining([
        { id: ordered.product.id, name: ordered.product.name, reason: 'has_orders' },
        { id: funnelled.product.id, name: funnelled.product.name, reason: 'in_funnel', funnelIds: [funnel.id] },
      ])
    );
    expect(res.body.skipped).toHaveLength(2);

    expect(await db.Product.findByPk(plain.product.id)).toBeNull();
    expect(await db.ProductVariant.findByPk(plain.variant.id)).toBeNull();
    expect(await db.AuditLog.count({ where: { action: 'product.delete_permanent', entityId: plain.product.id } })).toBe(1);
    // The refused ones are untouched: their savepoints were rolled back, not the chunk.
    expect((await db.Product.findByPk(ordered.product.id)).status).toBe(ordered.product.status);
    expect(await db.ProductVariant.findByPk(funnelled.variant.id)).not.toBeNull();
  });

  it("another store's product, or one that is gone, is skipped as not_found and left alone", async () => {
    const { workspace, H } = await freshWorkspace();
    const other = await freshWorkspace();
    const [mine] = await insertProducts(workspace.id, 1);
    const [theirs] = await insertProducts(other.workspace.id, 1);
    const gone = '00000000-0000-4000-8000-000000000000';

    const res = await bulkDelete(H, workspace.id, { mode: 'permanent', productIds: [mine.id, theirs.id, gone] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
    expect(res.body.skipped).toEqual(
      expect.arrayContaining([
        { id: theirs.id, name: null, reason: 'not_found' },
        { id: gone, name: null, reason: 'not_found' },
      ])
    );
    expect(await db.Product.findByPk(theirs.id)).not.toBeNull();
  });
});

describe('POST /catalog/products/bulk-delete — every product the filters match', () => {
  it('works through the matches a chunk at a time, following nextCursor', async () => {
    const { workspace, H } = await freshWorkspace();
    await insertProducts(workspace.id, BULK_DELETE_CHUNK + 1, { name: 'Bulk', status: 'active' });
    const { body: counted } = await request(app).get(`${catalog(workspace.id)}/products/count`).query({ status: 'draft,active' }).set(H);
    expect(counted.count).toBe(BULK_DELETE_CHUNK + 1);
    const filter = { status: ['draft', 'active'], createdBefore: counted.asOf };

    const first = await bulkDelete(H, workspace.id, { mode: 'permanent', filter });
    expect(first.status).toBe(200);
    expect(first.body.deleted).toBe(BULK_DELETE_CHUNK);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await bulkDelete(H, workspace.id, { mode: 'permanent', filter, cursor: first.body.nextCursor });
    expect(second.body).toEqual({ mode: 'permanent', deleted: 1, skipped: [], nextCursor: null });
    expect(await db.Product.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  it('leaves products the filter does not match, and products added after the count', async () => {
    const { workspace, H } = await freshWorkspace();
    await insertProducts(workspace.id, 2, { name: 'Shirt' });
    await insertProducts(workspace.id, 1, { name: 'Mug' });
    const { body: counted } = await request(app).get(`${catalog(workspace.id)}/products/count`).query({ q: 'shirt' }).set(H);
    const [late] = await insertProducts(workspace.id, 1, { name: 'Shirt late', createdAt: new Date(Date.now() + 60 * 1000) });

    const res = await bulkDelete(H, workspace.id, { mode: 'archive', filter: { q: 'shirt', createdBefore: counted.asOf } });
    expect(res.body.deleted).toBe(2);
    expect((await db.Product.findByPk(late.id)).status).toBe('draft');
    expect(await db.Product.count({ where: { workspaceId: workspace.id, status: 'archived' } })).toBe(2);
    const summary = await db.AuditLog.findOne({ where: { workspaceId: workspace.id, action: 'product.bulk_delete' } });
    expect(summary.metadata).toMatchObject({ by: 'filter', filter: { q: 'shirt' } });
  });

  it('a skipped product is passed over by the cursor, not picked again', async () => {
    const { auth, workspace, H } = await freshWorkspace();
    const ordered = await createProductWithVariant(auth.accessToken, workspace.id);
    await placeOrder(H, workspace.id, ordered.variant.id);
    const { body: counted } = await request(app).get(`${catalog(workspace.id)}/products/count`).set(H);

    const res = await bulkDelete(H, workspace.id, { mode: 'permanent', filter: { createdBefore: counted.asOf } });
    expect(res.body.deleted).toBe(0);
    expect(res.body.skipped).toEqual([{ id: ordered.product.id, name: ordered.product.name, reason: 'has_orders' }]);
    expect(res.body.nextCursor).toBeNull();
  });
});

describe('POST /catalog/products/bulk-delete — who and what', () => {
  it('403 without products.manage; the count needs products.view only', async () => {
    const { auth, workspace } = await freshWorkspace();
    const [product] = await insertProducts(workspace.id, 1);
    const operator = await addMemberWithRole(auth.accessToken, workspace.id, 'order_operator');
    const OH = bearer(operator.accessToken);

    expect((await bulkDelete(OH, workspace.id, { mode: 'archive', productIds: [product.id] })).status).toBe(403);
    expect((await request(app).get(`${catalog(workspace.id)}/products/count`).set(OH)).status).toBe(200);
    expect((await db.Product.findByPk(product.id)).status).toBe('draft');
  });

  it('422 for a body that names no products, both kinds, or too many', async () => {
    const { workspace, H } = await freshWorkspace();
    const id = '00000000-0000-4000-8000-000000000000';
    const createdBefore = new Date().toISOString();
    const tooMany = Array.from({ length: BULK_DELETE_CHUNK + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

    for (const body of [
      { mode: 'archive' },
      { mode: 'archive', productIds: [id], filter: { createdBefore } },
      { mode: 'archive', productIds: [id], cursor: id },
      { mode: 'archive', productIds: tooMany },
      { mode: 'archive', filter: {} },
      { mode: 'purge', productIds: [id] },
    ]) {
      const res = await bulkDelete(H, workspace.id, body);
      expect(res.status).toBe(422);
    }
  });
});
