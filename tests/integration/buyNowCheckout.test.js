'use strict';

// "Buy Now": POST /store/:workspaceId/checkout with a single `item` in the
// body and no X-Cart-Token, bypassing the cart. Same orderService.createOrder
// path as the cart checkout.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

const buyNow = (workspaceId, body, key) =>
  request(app)
    .post(`/api/v1/store/${workspaceId}/checkout`)
    .set('Idempotency-Key', key || `bn-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send(body);

const contact = { fullName: 'Buy Now Guest', phone: '01055551234' };

describe('Buy Now (cartless single-item checkout)', () => {
  it('creates an order from one body item, with no cart involved', async () => {
    const { workspace, variant } = await setupWorkspaceWithProduct({ price: 15000, stock: 10 });

    const res = await buyNow(workspace.id, {
      item: { variantId: variant.id, quantity: 1 },
      contact,
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Now St' },
      paymentMethod: 'cod',
    });

    expect(res.status).toBe(201);
    expect(res.body.order.items).toHaveLength(1);
    expect(res.body.order.items[0].quantity).toBe(1);
    expect(String(res.body.order.items[0].unitPriceAmount)).toBe('15000');

    // inventory reserved through the same path
    expect((await db.ProductVariant.findByPk(variant.id)).reservedStock).toBe(1);
    // nothing was written to a cart
    expect(await db.Cart.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  it('defaults quantity to 1 and also honours an explicit quantity', async () => {
    const { workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });

    const one = await buyNow(workspace.id, { item: { variantId: variant.id }, contact, paymentMethod: 'cod' });
    expect(one.status).toBe(201);
    expect(one.body.order.items[0].quantity).toBe(1);

    const three = await buyNow(workspace.id, {
      item: { variantId: variant.id, quantity: 3 },
      contact: { ...contact, phone: '01055559999' },
      paymentMethod: 'cod',
    });
    expect(three.status).toBe(201);
    expect(three.body.order.items[0].quantity).toBe(3);
  });

  it('is idempotent with an Idempotency-Key, like the staff order endpoint', async () => {
    const { workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const body = { item: { variantId: variant.id, quantity: 1 }, contact, paymentMethod: 'cod' };

    const first = await buyNow(workspace.id, body, 'buynow-key-1');
    const second = await buyNow(workspace.id, body, 'buynow-key-1');
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.order.id).toBe(first.body.order.id);
    expect(await db.Order.count({ where: { workspaceId: workspace.id } })).toBe(1);
  });

  it('rejects a Buy Now for a variant that is not in this workspace', async () => {
    const A = await setupWorkspaceWithProduct({ workspaceName: 'BN A' });
    const B = await setupWorkspaceWithProduct({ workspaceName: 'BN B' });

    const res = await buyNow(A.workspace.id, {
      item: { variantId: B.variant.id, quantity: 1 },
      contact,
      paymentMethod: 'cod',
    });
    expect(res.status).toBe(404);
  });

  it('still uses the cart when an X-Cart-Token is present (cart wins)', async () => {
    const { workspace, variant } = await setupWorkspaceWithProduct({ stock: 10, price: 5000 });
    const cart = await request(app).post(`/api/v1/store/${workspace.id}/cart`);
    const token = cart.body.guestToken;
    await request(app)
      .post(`/api/v1/store/${workspace.id}/cart/items`)
      .set('X-Cart-Token', token)
      .send({ variantId: variant.id, quantity: 2 });

    // body also carries an `item` — it must be ignored in favour of the cart
    const res = await request(app)
      .post(`/api/v1/store/${workspace.id}/checkout`)
      .set('X-Cart-Token', token)
      .set('Idempotency-Key', 'cart-wins-1')
      .send({ item: { variantId: variant.id, quantity: 99 }, contact, paymentMethod: 'cod' });

    expect(res.status).toBe(201);
    expect(res.body.order.items[0].quantity).toBe(2); // from the cart, not 99
    expect((await db.Cart.findOne({ where: { guestToken: token } })).status).toBe('converted');
  });
});
