'use strict';

// Product lifecycle: create with an optional first variant, archive/restore
// cascades (DELETE, POST /restore, PATCH status), permanent delete with its
// PRODUCT_HAS_ORDERS / PRODUCT_IN_FUNNEL guards, and the rule that only an
// active product can be put in a cart or ordered.

const {
  app,
  request,
  registerAndActivate,
  createWorkspace,
  setupWorkspaceWithProduct,
} = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const catalog = (workspaceId) => `/api/v1/workspaces/${workspaceId}/catalog`;
const auditRow = (action, entityId) =>
  db.AuditLog.findOne({ where: { action, entityId: String(entityId) }, order: [['createdAt', 'DESC']] });

async function freshWorkspace() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken);
  return { auth, workspace, H: bearer(auth.accessToken) };
}

async function addVariant(H, workspaceId, productId, body = {}) {
  const res = await request(app)
    .post(`${catalog(workspaceId)}/products/${productId}/variants`)
    .set(H)
    .send({ priceAmount: 1000, stockOnHand: 5, ...body });
  expect(res.status).toBe(201);
  return res.body.variant;
}

async function addOffer(H, workspaceId, productId, variantId) {
  const res = await request(app)
    .post(`${catalog(workspaceId)}/products/${productId}/offers`)
    .set(H)
    .send({ name: 'Single', pricingMode: 'fixed', priceAmount: 1000, lines: [{ variantId, quantity: 1 }] });
  expect(res.status).toBe(201);
  return res.body.offer;
}

async function placeOrder(H, workspaceId, variantId) {
  return request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(H)
    .set('Idempotency-Key', `ord-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: 1 }],
      contact: { fullName: 'Lifecycle Buyer', phone: '01000000001' },
      paymentMethod: 'cod',
    });
}

async function addToCart(workspaceId, variantId) {
  const cart = await request(app).post(`/api/v1/store/${workspaceId}/cart`);
  return request(app)
    .post(`/api/v1/store/${workspaceId}/cart/items`)
    .set('X-Cart-Token', cart.body.guestToken)
    .send({ variantId, quantity: 1 });
}

describe('POST /products with an optional first variant', () => {
  it('without `variant` behaves as before: product only, no variant key, no variants', async () => {
    const { workspace, H } = await freshWorkspace();
    const res = await request(app).post(`${catalog(workspace.id)}/products`).set(H).send({ name: 'Plain', status: 'active' });

    expect(res.status).toBe(201);
    expect(res.body.product.name).toBe('Plain');
    expect(res.body.product.status).toBe('active');
    expect(res.body).not.toHaveProperty('variant');
    expect(await db.ProductVariant.count({ where: { productId: res.body.product.id } })).toBe(0);
    expect(await auditRow('product.create', res.body.product.id)).not.toBeNull();
  });

  it('creates product + priced, stocked variant; stock goes through a restock movement; sellable on the storefront', async () => {
    const { workspace, H } = await freshWorkspace();
    const res = await request(app)
      .post(`${catalog(workspace.id)}/products`)
      .set(H)
      .send({
        name: 'Simple Tee',
        status: 'active',
        variant: { priceAmount: 25000, compareAtAmount: 30000, sku: 'TEE-1', stockOnHand: 7 },
      });

    expect(res.status).toBe(201);
    const { product, variant } = res.body;
    expect(variant.productId).toBe(product.id);
    expect(String(variant.priceAmount)).toBe('25000');
    expect(String(variant.compareAtAmount)).toBe('30000');
    expect(variant.sku).toBe('TEE-1');
    expect(variant.stockOnHand).toBe(7);
    expect(variant.allowOverselling).toBe(false);

    const movement = await db.InventoryMovement.findOne({ where: { variantId: variant.id } });
    expect(movement.type).toBe('restock');
    expect(movement.quantityDelta).toBe(7);
    expect(movement.reason).toBe('Initial stock at product creation');
    expect(await auditRow('product.create', product.id)).not.toBeNull();
    expect(await auditRow('variant.create', variant.id)).not.toBeNull();

    const store = await request(app).get(`/api/v1/store/${workspace.id}/products/${product.id}`);
    expect(store.status).toBe(200);
    expect(store.body.product.variants).toHaveLength(1);
    expect(store.body.product.variants[0].inStock).toBe(true);
  });

  it('stockOnHand 0 creates the variant with no inventory movement', async () => {
    const { workspace, H } = await freshWorkspace();
    const res = await request(app)
      .post(`${catalog(workspace.id)}/products`)
      .set(H)
      .send({ name: 'No Stock', variant: { priceAmount: 100 } });
    expect(res.status).toBe(201);
    expect(res.body.variant.stockOnHand).toBe(0);
    expect(await db.InventoryMovement.count({ where: { variantId: res.body.variant.id } })).toBe(0);
  });

  it('rejects a variant without priceAmount (422) and creates nothing', async () => {
    const { workspace, H } = await freshWorkspace();
    const res = await request(app)
      .post(`${catalog(workspace.id)}/products`)
      .set(H)
      .send({ name: 'Unpriced', variant: { stockOnHand: 3 } });
    expect(res.status).toBe(422);
    expect(res.body.error.details.some((d) => d.field === 'variant.priceAmount')).toBe(true);
    expect(await db.Product.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  it('rolls the product back when the variant fails (duplicate SKU)', async () => {
    const { workspace, H } = await freshWorkspace();
    const first = await request(app)
      .post(`${catalog(workspace.id)}/products`)
      .set(H)
      .send({ name: 'First', variant: { priceAmount: 100, sku: 'DUP' } });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`${catalog(workspace.id)}/products`)
      .set(H)
      .send({ name: 'Second', variant: { priceAmount: 100, sku: 'DUP', stockOnHand: 4 } });
    expect(second.status).toBe(409);
    expect(await db.Product.count({ where: { workspaceId: workspace.id } })).toBe(1);
  });
});

describe('PATCH /products/:id', () => {
  it('leaves fields it does not send untouched (no create-time defaults)', async () => {
    const { workspace, H } = await freshWorkspace();
    const created = await request(app)
      .post(`${catalog(workspace.id)}/products`)
      .set(H)
      .send({ name: 'Keep', status: 'active', tags: ['a'], media: [{ type: 'image', url: 'https://x.test/a.png' }] });
    const id = created.body.product.id;

    const res = await request(app).patch(`${catalog(workspace.id)}/products/${id}`).set(H).send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    const row = await db.Product.findByPk(id);
    expect(row.name).toBe('Renamed');
    expect(row.status).toBe('active');
    expect(row.tags).toEqual(['a']);
    expect(row.media).toHaveLength(1);
  });

  it('status → archived cascades to variants/offers; archived → active revives only those', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const H = bearer(auth.accessToken);
    const offer = await addOffer(H, workspace.id, product.id, variant.id);
    const url = `${catalog(workspace.id)}/products/${product.id}`;

    await request(app).patch(url).set(H).send({ status: 'archived' }).expect(200);
    let v = await db.ProductVariant.findByPk(variant.id);
    let o = await db.Offer.findByPk(offer.id);
    expect([v.status, v.archivedWithProduct]).toEqual(['archived', true]);
    expect([o.status, o.archivedWithProduct]).toEqual(['archived', true]);

    // A PATCH that doesn't touch status keeps the product archived.
    await request(app).patch(url).set(H).send({ name: 'Still archived' }).expect(200);
    expect((await db.Product.findByPk(product.id)).status).toBe('archived');

    // Leaving 'archived' through PATCH honours the requested status.
    const back = await request(app).patch(url).set(H).send({ status: 'active' });
    expect(back.status).toBe(200);
    expect(back.body.product.status).toBe('active');
    v = await db.ProductVariant.findByPk(variant.id);
    o = await db.Offer.findByPk(offer.id);
    expect([v.status, v.archivedWithProduct]).toEqual(['active', false]);
    expect([o.status, o.archivedWithProduct]).toEqual(['active', false]);

    const store = await request(app).get(`/api/v1/store/${workspace.id}/products/${product.id}`);
    expect(store.body.product.variants[0].inStock).toBe(true);

    const upd = await db.AuditLog.findAll({ where: { action: 'product.update', entityId: product.id } });
    const cascades = upd.map((r) => r.metadata && r.metadata.cascade).filter(Boolean).sort();
    expect(cascades).toEqual(['archive', 'restore']);
  });
});

describe('DELETE (archive) → POST /restore', () => {
  it('restores to draft with the cascaded variants/offers; an individually archived variant stays archived', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const H = bearer(auth.accessToken);
    const base = catalog(workspace.id);
    const offer = await addOffer(H, workspace.id, product.id, variant.id);

    const retired = await addVariant(H, workspace.id, product.id, { sku: 'RETIRED' });
    await request(app).delete(`${base}/variants/${retired.id}`).set(H).expect(200);

    const del = await request(app).delete(`${base}/products/${product.id}`).set(H);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ archived: true, id: product.id });
    expect((await db.ProductVariant.findByPk(variant.id)).archivedWithProduct).toBe(true);
    expect((await db.ProductVariant.findByPk(retired.id)).archivedWithProduct).toBe(false);

    const res = await request(app).post(`${base}/products/${product.id}/restore`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.product.id).toBe(product.id);
    expect(res.body.product.status).toBe('draft');
    const byId = Object.fromEntries(res.body.product.variants.map((v) => [v.id, v]));
    expect(byId[variant.id].status).toBe('active');
    expect(byId[variant.id].archivedWithProduct).toBe(false);
    expect(byId[retired.id].status).toBe('archived');
    expect(res.body.product.offers.find((o) => o.id === offer.id).status).toBe('active');

    const audit = await auditRow('product.restore', product.id);
    expect(audit).not.toBeNull();
    expect(audit.beforeState.status).toBe('archived');
    expect(audit.afterState.status).toBe('draft');
  });

  it('409 PRODUCT_NOT_ARCHIVED when the product is not archived', async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const res = await request(app)
      .post(`${catalog(workspace.id)}/products/${product.id}/restore`)
      .set(bearer(auth.accessToken));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRODUCT_NOT_ARCHIVED');
  });
});

describe('DELETE /products/:id/permanent', () => {
  it('hard-deletes a never-ordered product and everything hanging off it, including open cart items', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const H = bearer(auth.accessToken);
    const base = catalog(workspace.id);
    const offer = await addOffer(H, workspace.id, product.id, variant.id);
    const coll = (await request(app).post(`${base}/collections`).set(H).send({ name: 'C' })).body.collection;
    await request(app).post(`${base}/products/${product.id}/collections/${coll.id}`).set(H).expect(200);
    await db.TaxRate.create({ workspaceId: workspace.id, name: 'Special', rateBasisPoints: 500, productId: product.id });
    expect((await addToCart(workspace.id, variant.id)).status).toBe(201);
    expect(await db.CartItem.count({ where: { variantId: variant.id } })).toBe(1);

    const res = await request(app).delete(`${base}/products/${product.id}/permanent`).set(H);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: product.id });

    expect(await db.Product.findByPk(product.id)).toBeNull();
    expect(await db.ProductVariant.findByPk(variant.id)).toBeNull();
    expect(await db.Offer.findByPk(offer.id)).toBeNull();
    expect(await db.OfferVariant.count({ where: { offerId: offer.id } })).toBe(0);
    expect(await db.CartItem.count({ where: { variantId: variant.id } })).toBe(0);
    expect(await db.InventoryMovement.count({ where: { variantId: variant.id } })).toBe(0);
    expect(await db.ProductCollection.count({ where: { productId: product.id } })).toBe(0);
    expect(await db.TaxRate.count({ where: { productId: product.id } })).toBe(0);
    expect(await db.Collection.findByPk(coll.id)).not.toBeNull();

    const audit = await auditRow('product.delete_permanent', product.id);
    expect(audit).not.toBeNull();
    expect(audit.beforeState.id).toBe(product.id);
    expect(audit.metadata.cartItemsRemoved).toBe(1);
  });

  it('works on an archived product too', async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const H = bearer(auth.accessToken);
    await request(app).delete(`${catalog(workspace.id)}/products/${product.id}`).set(H).expect(200);
    const res = await request(app).delete(`${catalog(workspace.id)}/products/${product.id}/permanent`).set(H);
    expect(res.status).toBe(200);
    expect(await db.Product.findByPk(product.id)).toBeNull();
  });

  it('409 PRODUCT_HAS_ORDERS when an order line names the product', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const H = bearer(auth.accessToken);
    expect((await placeOrder(H, workspace.id, variant.id)).status).toBe(201);

    const res = await request(app).delete(`${catalog(workspace.id)}/products/${product.id}/permanent`).set(H);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRODUCT_HAS_ORDERS');
    expect(await db.Product.findByPk(product.id)).not.toBeNull();
    expect(await db.ProductVariant.findByPk(variant.id)).not.toBeNull();
  });

  it('409 PRODUCT_HAS_ORDERS when an order line matches only by variant id', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const H = bearer(auth.accessToken);
    const order = (await placeOrder(H, workspace.id, variant.id)).body.order;
    await db.OrderItem.update({ productId: null }, { where: { orderId: order.id } });

    const res = await request(app).delete(`${catalog(workspace.id)}/products/${product.id}/permanent`).set(H);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRODUCT_HAS_ORDERS');
    expect(await db.Product.findByPk(product.id)).not.toBeNull();
  });

  it('409 PRODUCT_IN_FUNNEL (with funnel ids) when a draft funnel step sells one of its offers', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const H = bearer(auth.accessToken);
    const offer = await addOffer(H, workspace.id, product.id, variant.id);
    const funnel = await db.Funnel.create({ workspaceId: workspace.id, name: 'Upsell funnel' });
    await db.FunnelStep.create({
      workspaceId: workspace.id,
      funnelId: funnel.id,
      key: 'upsell-1',
      stepType: 'upsell',
      name: 'Upsell',
      offerId: offer.id,
    });

    const res = await request(app).delete(`${catalog(workspace.id)}/products/${product.id}/permanent`).set(H);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRODUCT_IN_FUNNEL');
    expect(res.body.error.details[0].field).toBe('funnelIds');
    expect(res.body.error.details[0].funnelIds).toEqual([funnel.id]);
    expect(await db.Offer.findByPk(offer.id)).not.toBeNull();
  });

  it('409 PRODUCT_IN_FUNNEL when only the published revision still sells the offer', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const H = bearer(auth.accessToken);
    const offer = await addOffer(H, workspace.id, product.id, variant.id);
    const funnel = await db.Funnel.create({ workspaceId: workspace.id, name: 'Live funnel', status: 'published' });
    const revision = await db.FunnelRevision.create({
      workspaceId: workspace.id,
      funnelId: funnel.id,
      revisionNumber: 1,
      publishedByUserId: auth.user.id,
      snapshot: { funnel: {}, steps: [{ key: 'up', stepType: 'upsell', offerId: offer.id }], edges: [] },
    });
    await funnel.update({ publishedRevisionId: revision.id });

    const res = await request(app).delete(`${catalog(workspace.id)}/products/${product.id}/permanent`).set(H);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRODUCT_IN_FUNNEL');
    expect(res.body.error.details[0].funnelIds).toEqual([funnel.id]);
  });
});

describe('cross-tenant access to the new endpoints', () => {
  it('404s restore and permanent delete on another workspace\'s product, leaving it untouched', async () => {
    const A = await setupWorkspaceWithProduct();
    const B = await freshWorkspace();
    const HA = bearer(A.auth.accessToken);
    await request(app).delete(`${catalog(A.workspace.id)}/products/${A.product.id}`).set(HA).expect(200);

    // B's token against A's workspace URL: no membership.
    const viaAUrl = await request(app).post(`${catalog(A.workspace.id)}/products/${A.product.id}/restore`).set(B.H);
    expect(viaAUrl.status).toBe(404);
    // B's own workspace URL, A's product id.
    const restore = await request(app).post(`${catalog(B.workspace.id)}/products/${A.product.id}/restore`).set(B.H);
    expect(restore.status).toBe(404);
    const permanent = await request(app).delete(`${catalog(B.workspace.id)}/products/${A.product.id}/permanent`).set(B.H);
    expect(permanent.status).toBe(404);

    const row = await db.Product.findByPk(A.product.id);
    expect(row).not.toBeNull();
    expect(row.status).toBe('archived');
  });
});

describe('only active products can be carted or ordered', () => {
  it('rejects cart add and order for a draft product even though its variant is active', async () => {
    const { workspace, H } = await freshWorkspace();
    const res = await request(app)
      .post(`${catalog(workspace.id)}/products`)
      .set(H)
      .send({ name: 'Draft', status: 'draft', variant: { priceAmount: 100, stockOnHand: 5 } });
    const { variant } = res.body;
    expect(variant.status).toBe('active');

    expect((await addToCart(workspace.id, variant.id)).status).toBe(404);
    expect((await placeOrder(H, workspace.id, variant.id)).status).toBe(404);
  });

  it('rejects cart add and order once the product is archived', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const H = bearer(auth.accessToken);
    await request(app).delete(`${catalog(workspace.id)}/products/${product.id}`).set(H).expect(200);

    expect((await addToCart(workspace.id, variant.id)).status).toBe(404);
    expect((await placeOrder(H, workspace.id, variant.id)).status).toBe(404);
  });
});

describe('GET /products status filter', () => {
  it('accepts one status, a comma-separated list, or a repeated param', async () => {
    const { workspace, H } = await freshWorkspace();
    const make = (name, status) =>
      request(app).post(`${catalog(workspace.id)}/products`).set(H).send({ name, status }).expect(201);
    await make('D', 'draft');
    await make('A', 'active');
    await make('X', 'archived');
    const names = async (qs) => {
      const res = await request(app).get(`${catalog(workspace.id)}/products?${qs}`).set(H);
      expect(res.status).toBe(200);
      return res.body.products.map((p) => p.name).sort();
    };

    expect(await names('status=active')).toEqual(['A']);
    expect(await names('status=draft,active')).toEqual(['A', 'D']);
    expect(await names('status=draft&status=archived')).toEqual(['D', 'X']);
    expect(await names('')).toEqual(['A', 'D', 'X']);

    const bad = await request(app).get(`${catalog(workspace.id)}/products?status=draft,bogus`).set(H);
    expect(bad.status).toBe(422);
  });
});
