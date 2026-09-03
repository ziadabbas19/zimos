'use strict';

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

describe('Public storefront browsing', () => {
  it('lists active products with no authentication required', async () => {
    const { workspace } = await setupWorkspaceWithProduct({ price: 12000, stock: 5 });

    const res = await request(app).get(`/api/v1/store/${workspace.id}/products`);
    expect(res.status).toBe(200);
    expect(res.body.products.length).toBe(1);
    // Public shape never leaks cost price or exact stock counts.
    expect(res.body.products[0].variants[0].costAmount).toBeUndefined();
    expect(res.body.products[0].variants[0].stockOnHand).toBeUndefined();
    expect(res.body.products[0].variants[0].inStock).toBe(true);
  });

  it('does not list draft products', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/catalog/products`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({ name: 'Hidden Draft Product', status: 'draft' });

    const res = await request(app).get(`/api/v1/store/${workspace.id}/products`);
    expect(res.body.products.some((p) => p.name === 'Hidden Draft Product')).toBe(false);
  });

  it('returns 404 for a suspended or nonexistent workspace, same as tenant isolation', async () => {
    const res = await request(app).get('/api/v1/store/11111111-1111-1111-1111-111111111111/products');
    expect(res.status).toBe(404);
  });

  it('gets a single product by slug', async () => {
    const { workspace, product } = await setupWorkspaceWithProduct();
    const res = await request(app).get(`/api/v1/store/${workspace.id}/products/${product.slug}`);
    expect(res.status).toBe(200);
    expect(res.body.product.id).toBe(product.id);
  });
});

describe('Guest cart', () => {
  it('creates a cart and returns a guest token with no authentication', async () => {
    const { workspace } = await setupWorkspaceWithProduct();
    const res = await request(app).post(`/api/v1/store/${workspace.id}/cart`);
    expect(res.status).toBe(201);
    expect(res.body.guestToken).toBeDefined();
  });

  it('adds an item, computes subtotal from LIVE prices, and persists across requests using the token', async () => {
    const { workspace, variant } = await setupWorkspaceWithProduct({ price: 10000 });
    const cartRes = await request(app).post(`/api/v1/store/${workspace.id}/cart`);
    const token = cartRes.body.guestToken;

    const addRes = await request(app)
      .post(`/api/v1/store/${workspace.id}/cart/items`)
      .set('X-Cart-Token', token)
      .send({ variantId: variant.id, quantity: 3 });

    expect(addRes.status).toBe(201);
    expect(addRes.body.items.length).toBe(1);
    expect(addRes.body.subtotal).toBe(30000);

    const getRes = await request(app).get(`/api/v1/store/${workspace.id}/cart`).set('X-Cart-Token', token);
    expect(getRes.status).toBe(200);
    expect(getRes.body.items.length).toBe(1);
    expect(getRes.body.subtotal).toBe(30000);
  });

  it('a guest token from workspace A does not resolve to a cart in workspace B', async () => {
    const A = await setupWorkspaceWithProduct();
    const B = await setupWorkspaceWithProduct();

    const cartRes = await request(app).post(`/api/v1/store/${A.workspace.id}/cart`);
    const tokenFromA = cartRes.body.guestToken;

    // Using A's token against B's workspace must NOT return A's cart — it
    // gets treated as an unknown token and a fresh cart is created instead.
    const res = await request(app).post(`/api/v1/store/${B.workspace.id}/cart`).set('X-Cart-Token', tokenFromA);
    expect(res.status).toBe(201);
    expect(res.body.guestToken).not.toBe(tokenFromA);
    expect(res.body.items.length).toBe(0);
  });

  it('updates and removes items', async () => {
    const { workspace, variant } = await setupWorkspaceWithProduct({ price: 5000, stock: 10 });
    const cartRes = await request(app).post(`/api/v1/store/${workspace.id}/cart`);
    const token = cartRes.body.guestToken;

    const addRes = await request(app).post(`/api/v1/store/${workspace.id}/cart/items`).set('X-Cart-Token', token).send({ variantId: variant.id, quantity: 2 });
    const itemId = addRes.body.items[0].id;

    const updateRes = await request(app).patch(`/api/v1/store/${workspace.id}/cart/items/${itemId}`).set('X-Cart-Token', token).send({ quantity: 5 });
    expect(updateRes.body.items[0].quantity).toBe(5);

    const removeRes = await request(app).delete(`/api/v1/store/${workspace.id}/cart/items/${itemId}`).set('X-Cart-Token', token);
    expect(removeRes.body.items.length).toBe(0);
  });
});

describe('Guest checkout', () => {
  it('completes an order end-to-end with no staff authentication at all', async () => {
    const { workspace, variant } = await setupWorkspaceWithProduct({ price: 15000, stock: 10 });

    const cartRes = await request(app).post(`/api/v1/store/${workspace.id}/cart`);
    const token = cartRes.body.guestToken;
    await request(app).post(`/api/v1/store/${workspace.id}/cart/items`).set('X-Cart-Token', token).send({ variantId: variant.id, quantity: 2 });

    const checkoutRes = await request(app)
      .post(`/api/v1/store/${workspace.id}/checkout`)
      .set('X-Cart-Token', token)
      .set('Idempotency-Key', 'guest-checkout-1')
      .send({ contact: { fullName: 'Guest Shopper', phone: '01011122233' }, paymentMethod: 'cod' });

    expect(checkoutRes.status).toBe(201);
    expect(Number(checkoutRes.body.order.totalAmount)).toBe(30000);
    expect(checkoutRes.body.order.items.length).toBe(1);

    // Inventory really was reserved by a guest, through the same transactional path.
    const v = await db.ProductVariant.findByPk(variant.id);
    expect(v.reservedStock).toBe(2);

    // The cart is marked converted, not left dangling as active.
    const cart = await db.Cart.findOne({ where: { guestToken: token } });
    expect(cart.status).toBe('converted');
  });

  it('rejects checkout with neither a cart token nor a Buy Now item', async () => {
    const { workspace } = await setupWorkspaceWithProduct();
    const res = await request(app)
      .post(`/api/v1/store/${workspace.id}/checkout`)
      .set('Idempotency-Key', 'no-token-checkout')
      .send({ contact: { fullName: 'X', phone: '01000000000' }, paymentMethod: 'cod' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CART_TOKEN_OR_ITEM_REQUIRED');
  });

  it('rejects checkout of an empty cart', async () => {
    const { workspace } = await setupWorkspaceWithProduct();
    const cartRes = await request(app).post(`/api/v1/store/${workspace.id}/cart`);
    const token = cartRes.body.guestToken;

    const res = await request(app)
      .post(`/api/v1/store/${workspace.id}/checkout`)
      .set('X-Cart-Token', token)
      .set('Idempotency-Key', 'empty-cart-checkout')
      .send({ contact: { fullName: 'X', phone: '01000000000' }, paymentMethod: 'cod' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EMPTY_CART');
  });

  it('is idempotent, same as the staff-facing order endpoint', async () => {
    const { workspace, variant } = await setupWorkspaceWithProduct({ price: 8000, stock: 10 });
    const cartRes = await request(app).post(`/api/v1/store/${workspace.id}/cart`);
    const token = cartRes.body.guestToken;
    await request(app).post(`/api/v1/store/${workspace.id}/cart/items`).set('X-Cart-Token', token).send({ variantId: variant.id, quantity: 1 });

    const body = { contact: { fullName: 'Repeat Guest', phone: '01099988877' }, paymentMethod: 'cod' };
    const first = await request(app).post(`/api/v1/store/${workspace.id}/checkout`).set('X-Cart-Token', token).set('Idempotency-Key', 'guest-retry-1').send(body);
    const second = await request(app).post(`/api/v1/store/${workspace.id}/checkout`).set('X-Cart-Token', token).set('Idempotency-Key', 'guest-retry-1').send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.order.id).toBe(first.body.order.id);
  });

  it('does not let a guest checkout against another workspace by URL-swapping', async () => {
    const A = await setupWorkspaceWithProduct({ stock: 10 });
    const B = await setupWorkspaceWithProduct({ stock: 10 });

    const cartRes = await request(app).post(`/api/v1/store/${A.workspace.id}/cart`);
    const token = cartRes.body.guestToken;
    await request(app).post(`/api/v1/store/${A.workspace.id}/cart/items`).set('X-Cart-Token', token).send({ variantId: A.variant.id, quantity: 1 });

    // Try to check out that cart against workspace B's URL.
    const res = await request(app)
      .post(`/api/v1/store/${B.workspace.id}/checkout`)
      .set('X-Cart-Token', token)
      .set('Idempotency-Key', 'cross-tenant-guest-checkout')
      .send({ contact: { fullName: 'Sneaky', phone: '01000001111' }, paymentMethod: 'cod' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CART_NOT_FOUND');
  });
});
