'use strict';

// Product reviews. A shopper can review only after a delivered order that
// contained the product; one review per customer per product (resubmit
// updates, no duplicate); reviews start pending and only approved ones show
// on the public product endpoint.

const { app, request, setupWorkspaceWithProduct, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const PHONE = '01000009999';

async function placeOrder(token, workspaceId, variantId) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `rev-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: 1 }],
      contact: { fullName: 'Review Buyer', phone: PHONE },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '9 Rev St' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

async function markDelivered(token, workspaceId, orderId) {
  const ship = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/shipments`)
    .set(bearer(token))
    .send({ carrierCode: 'bosta' });
  await request(app)
    .patch(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/shipments/${ship.body.shipment.id}`)
    .set(bearer(token))
    .send({ status: 'delivered' })
    .expect(200);
}

const submitReview = (workspaceId, productId, body) =>
  request(app).post(`/api/v1/store/${workspaceId}/products/${productId}/reviews`).send(body);

describe('submitting a review', () => {
  it('is refused for a phone with no delivered purchase of the product', async () => {
    const { workspace, product } = await setupWorkspaceWithProduct();
    const res = await submitReview(workspace.id, product.id, { phone: PHONE, rating: 5, comment: 'nice' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NO_DELIVERED_PURCHASE');
  });

  it('is refused while the order is only placed, not delivered', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    await placeOrder(auth.accessToken, workspace.id, variant.id);
    const res = await submitReview(workspace.id, product.id, { phone: PHONE, rating: 4 });
    expect(res.status).toBe(403);
  });

  it('succeeds after a delivered order and starts pending; resubmitting updates the same row', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await markDelivered(auth.accessToken, workspace.id, order.id);

    const first = await submitReview(workspace.id, product.id, { phone: PHONE, rating: 5, comment: 'love it' });
    expect(first.status).toBe(201);
    expect(first.body.review.status).toBe('pending');

    const again = await submitReview(workspace.id, product.id, { phone: PHONE, rating: 2, comment: 'changed my mind' });
    expect(again.status).toBe(200);
    expect(again.body.review.rating).toBe(2);
    expect(again.body.review.status).toBe('pending');

    expect(await db.Review.count({ where: { workspaceId: workspace.id, productId: product.id } })).toBe(1);
  });

  it('rejects an out-of-range rating', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await markDelivered(auth.accessToken, workspace.id, order.id);
    const res = await submitReview(workspace.id, product.id, { phone: PHONE, rating: 6 });
    expect(res.status).toBe(422);
  });
});

describe('moderation + public aggregate', () => {
  it('only approved reviews show on the public product; staff can approve/reject', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await markDelivered(auth.accessToken, workspace.id, order.id);
    await submitReview(workspace.id, product.id, { phone: PHONE, rating: 4, comment: 'solid' });

    // pending — not visible publicly yet
    let pub = await request(app).get(`/api/v1/store/${workspace.id}/products/${product.id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.product.rating).toEqual({ average: null, count: 0 });
    expect(pub.body.product.reviews).toEqual([]);

    // staff queue
    const queue = await request(app)
      .get(`/api/v1/workspaces/${workspace.id}/reviews?status=pending`)
      .set(bearer(auth.accessToken));
    expect(queue.status).toBe(200);
    expect(queue.body.reviews).toHaveLength(1);
    const reviewId = queue.body.reviews[0].id;

    // approve
    const approve = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/reviews/${reviewId}`)
      .set(bearer(auth.accessToken))
      .send({ action: 'approve' });
    expect(approve.status).toBe(200);
    expect(approve.body.review.status).toBe('approved');

    // now public
    pub = await request(app).get(`/api/v1/store/${workspace.id}/products/${product.id}`);
    expect(pub.body.product.rating.count).toBe(1);
    expect(pub.body.product.rating.average).toBe(4);
    expect(pub.body.product.reviews).toHaveLength(1);
    expect(pub.body.product.reviews[0].comment).toBe('solid');

    // reject it again -> disappears from public
    await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/reviews/${reviewId}`)
      .set(bearer(auth.accessToken))
      .send({ action: 'reject' })
      .expect(200);
    pub = await request(app).get(`/api/v1/store/${workspace.id}/products/${product.id}`);
    expect(pub.body.product.rating.count).toBe(0);
  });

  it('averages multiple approved ratings', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct({ stock: 20 });
    // two different customers, each with a delivered order
    for (const phone of ['01000001111', '01000002222']) {
      const res = await request(app)
        .post(`/api/v1/workspaces/${workspace.id}/orders`)
        .set(bearer(auth.accessToken))
        .set('Idempotency-Key', `avg-${phone}`)
        .send({
          items: [{ variantId: variant.id, quantity: 1 }],
          contact: { fullName: `Buyer ${phone}`, phone },
          shippingAddress: { country: 'EG', city: 'Cairo', addressLine: 'x' },
          paymentMethod: 'cod',
        });
      await markDelivered(auth.accessToken, workspace.id, res.body.order.id);
    }
    await submitReview(workspace.id, product.id, { phone: '01000001111', rating: 5 });
    await submitReview(workspace.id, product.id, { phone: '01000002222', rating: 2 });

    const all = await request(app).get(`/api/v1/workspaces/${workspace.id}/reviews`).set(bearer(auth.accessToken));
    for (const r of all.body.reviews) {
      await request(app)
        .patch(`/api/v1/workspaces/${workspace.id}/reviews/${r.id}`)
        .set(bearer(auth.accessToken))
        .send({ action: 'approve' });
    }

    const pub = await request(app).get(`/api/v1/store/${workspace.id}/products/${product.id}`);
    expect(pub.body.product.rating.count).toBe(2);
    expect(pub.body.product.rating.average).toBe(3.5);
  });

  it('staff moderation is workspace-scoped (404 cross-workspace)', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await markDelivered(auth.accessToken, workspace.id, order.id);
    await submitReview(workspace.id, product.id, { phone: PHONE, rating: 5 });
    const review = await db.Review.findOne({ where: { workspaceId: workspace.id } });

    const other = await registerAndActivate({ fullName: 'Rev Other' });
    await createWorkspace(other.accessToken, 'Rev Other WS');
    const res = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/reviews/${review.id}`)
      .set(bearer(other.accessToken))
      .send({ action: 'approve' });
    expect(res.status).toBe(404);
  });
});
