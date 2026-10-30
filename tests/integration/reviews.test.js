'use strict';

// Product and store reviews (modules/reviews). Anyone may send stars; every
// review waits for the merchant; the stars a shopper sees count only
// published reviews from a delivered purchase; one review per phone and per
// device for the same product (or the store); the customer's details reach
// the merchant only.

const fs = require('fs');
const path = require('path');
const { app, request, setupWorkspaceWithProduct, registerAndActivate, createWorkspace, confirmCodOrder, addMemberWithRole } = require('../helpers/factories');
const { pngWithAlpha } = require('../helpers/images');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { PRIVATE_ROOT } = require('../../src/modules/media/storage/localStorage');
const { tokenFor } = require('../../src/modules/storefront/orderTrackingExtras');

// Sending is closed by default (REVIEWS_PUBLIC_SUBMISSION_ENABLED); these
// tests are about it open. authHardening.test.js covers it closed.
beforeEach(() => {
  env.reviews.publicSubmissionEnabled = true;
});
afterEach(() => {
  env.reviews.publicSubmissionEnabled = false;
});
afterAll(() => {
  fs.rmSync(path.join(PRIVATE_ROOT, 'customer-uploads'), { recursive: true, force: true });
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const PHONE = '01000009999';

async function placeOrder(token, workspaceId, variantId, phone = PHONE, fullName = 'Review Buyer Person') {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `rev-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: 1 }],
      contact: { fullName, phone, email: 'buyer@example.com' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '9 Rev St' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

async function markDelivered(token, workspaceId, orderId) {
  // A COD order ships only once confirmed.
  await confirmCodOrder(token, workspaceId, orderId);
  const ship = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/shipments`)
    .set(bearer(token))
    .send({ carrierCode: 'local-courier' });
  await request(app)
    .patch(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/shipments/${ship.body.shipment.id}`)
    .set(bearer(token))
    .send({ status: 'delivered' })
    .expect(200);
}

const submitReview = (workspaceId, productId, body, headers = {}) =>
  request(app).post(`/api/v1/store/${workspaceId}/products/${productId}/reviews`).set(headers).send(body);
const submitStoreReview = (workspaceId, body) => request(app).post(`/api/v1/store/${workspaceId}/store-reviews`).send(body);
const publicProduct = (workspaceId, productId) => request(app).get(`/api/v1/store/${workspaceId}/products/${productId}`);
const staffList = (token, workspaceId, query = '') => request(app).get(`/api/v1/workspaces/${workspaceId}/reviews${query}`).set(bearer(token));
const moderate = (token, workspaceId, reviewId, action) =>
  request(app).patch(`/api/v1/workspaces/${workspaceId}/reviews/${reviewId}`).set(bearer(token)).send({ action });

describe('sending a review', () => {
  it('is open to anyone: a phone that never ordered gets 201 and the review waits', async () => {
    const { workspace, product } = await setupWorkspaceWithProduct();
    const res = await submitReview(workspace.id, product.id, { phone: PHONE, rating: 5, name: 'Mona Ali', comment: 'nice' });
    expect(res.status).toBe(201);
    expect(res.body.review).toMatchObject({ received: true, status: 'pending' });
    const row = await db.Review.findOne({ where: { workspaceId: workspace.id } });
    expect(row).toMatchObject({ kind: 'product', status: 'pending', customerId: null, orderId: null, phoneNormalized: '201000009999' });
  });

  it('needs a valid phone unless it comes from an order link', async () => {
    const { workspace, product } = await setupWorkspaceWithProduct();
    const res = await submitReview(workspace.id, product.id, { rating: 5 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_PHONE');
  });

  it('rejects an out-of-range rating', async () => {
    const { workspace, product } = await setupWorkspaceWithProduct();
    expect((await submitReview(workspace.id, product.id, { phone: PHONE, rating: 6 })).status).toBe(422);
    expect((await submitReview(workspace.id, product.id, { phone: PHONE, rating: 0 })).status).toBe(422);
  });

  it('keeps one review per phone and per device for the same product', async () => {
    const { workspace, product } = await setupWorkspaceWithProduct();
    expect((await submitReview(workspace.id, product.id, { phone: PHONE, rating: 5, deviceId: 'device-aaaa-1111' })).status).toBe(201);

    const samePhone = await submitReview(workspace.id, product.id, { phone: '+20 100 000 9999', rating: 1 });
    expect(samePhone.status).toBe(409);
    expect(samePhone.body.error.code).toBe('ALREADY_REVIEWED');

    const sameDevice = await submitReview(workspace.id, product.id, { phone: '01000001234', rating: 1, deviceId: 'device-aaaa-1111' });
    expect(sameDevice.status).toBe(409);

    expect(await db.Review.count({ where: { workspaceId: workspace.id } })).toBe(1);
  });

  it('takes the tags and hidden characters out of the text', async () => {
    const { workspace, product } = await setupWorkspaceWithProduct();
    await submitReview(workspace.id, product.id, { phone: PHONE, rating: 4, name: '<b>Mona</b>', comment: 'good <script>alert(1)</script> one‮' });
    const row = await db.Review.findOne({ where: { workspaceId: workspace.id } });
    expect(row.comment).toBe('good alert(1) one');
    expect(row.authorName).toBe('Mona');
  });

  it('tells the team (review.new) and counts it as waiting', async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    await submitReview(workspace.id, product.id, { phone: PHONE, rating: 3 });
    expect(await db.MerchantNotification.count({ where: { workspaceId: workspace.id, type: 'review.new' } })).toBeGreaterThan(0);
    const summary = await request(app).get(`/api/v1/workspaces/${workspace.id}/reviews/summary`).set(bearer(auth.accessToken));
    expect(summary.status).toBe(200);
    expect(summary.body.counts).toEqual({ pending: 1, approved: 0, rejected: 0 });
  });
});

describe('what counts in the stars', () => {
  it('a new review shows to nobody and moves nothing until the merchant approves it', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await markDelivered(auth.accessToken, workspace.id, order.id);
    await submitReview(workspace.id, product.id, { phone: PHONE, rating: 4, comment: 'solid' });

    let pub = await publicProduct(workspace.id, product.id);
    expect(pub.status).toBe(200);
    expect(pub.body.product.rating).toMatchObject({ average: null, count: 0 });
    expect(pub.body.product.reviews).toEqual([]);

    const queue = await staffList(auth.accessToken, workspace.id, '?status=pending');
    expect(queue.body.reviews).toHaveLength(1);
    const reviewId = queue.body.reviews[0].id;

    expect((await moderate(auth.accessToken, workspace.id, reviewId, 'approve')).body.review.status).toBe('approved');
    pub = await publicProduct(workspace.id, product.id);
    expect(pub.body.product.rating).toMatchObject({ average: 4, count: 1 });
    expect(pub.body.product.reviews[0]).toMatchObject({ comment: 'solid', verified: true, authorName: 'Review' });

    // Hidden: gone from the page and from the stars.
    await moderate(auth.accessToken, workspace.id, reviewId, 'hide').expect(200);
    pub = await publicProduct(workspace.id, product.id);
    expect(pub.body.product.rating.count).toBe(0);
    expect(pub.body.product.reviews).toEqual([]);
  });

  it('a review with no purchase can be published but never moves the stars', async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    await submitReview(workspace.id, product.id, { phone: PHONE, rating: 1, name: 'Stranger', comment: 'meh' });
    const [row] = (await staffList(auth.accessToken, workspace.id)).body.reviews;
    expect(row.purchase).toEqual({ state: 'none', orderId: null, orderNumber: null });
    await moderate(auth.accessToken, workspace.id, row.id, 'approve').expect(200);

    const pub = await publicProduct(workspace.id, product.id);
    expect(pub.body.product.rating).toMatchObject({ average: null, count: 0 });
    expect(pub.body.product.reviews).toHaveLength(1);
    expect(pub.body.product.reviews[0]).toMatchObject({ verified: false, comment: 'meh' });
  });

  it('a review from an order still on its way counts only once the order is delivered', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await submitReview(workspace.id, product.id, { phone: PHONE, rating: 2 });
    const [row] = (await staffList(auth.accessToken, workspace.id)).body.reviews;
    expect(row.purchase).toMatchObject({ state: 'ordered', orderId: order.id, orderNumber: order.orderNumber });
    await moderate(auth.accessToken, workspace.id, row.id, 'approve').expect(200);

    expect((await publicProduct(workspace.id, product.id)).body.product.rating.count).toBe(0);

    await markDelivered(auth.accessToken, workspace.id, order.id);
    const pub = await publicProduct(workspace.id, product.id);
    expect(pub.body.product.rating).toMatchObject({ average: 2, count: 1 });
    expect((await staffList(auth.accessToken, workspace.id)).body.reviews[0]).toMatchObject({ counted: true, purchase: { state: 'delivered' } });
  });

  it('a cancelled order does not count', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await request(app).post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/cancel`).set(bearer(auth.accessToken)).send({ reason: 'test' });
    await submitReview(workspace.id, product.id, { phone: PHONE, rating: 5 });
    const [row] = (await staffList(auth.accessToken, workspace.id)).body.reviews;
    expect(row.purchase.state).toBe('cancelled');
    await moderate(auth.accessToken, workspace.id, row.id, 'approve').expect(200);
    expect((await publicProduct(workspace.id, product.id)).body.product.rating.count).toBe(0);
  });

  it('stars only: the stars count, the text and photos stay with the merchant', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await markDelivered(auth.accessToken, workspace.id, order.id);
    await submitReview(workspace.id, product.id, { phone: PHONE, rating: 5, comment: 'private words' });
    const [row] = (await staffList(auth.accessToken, workspace.id)).body.reviews;
    const res = await moderate(auth.accessToken, workspace.id, row.id, 'approve_stars');
    expect(res.body.review).toMatchObject({ status: 'approved', showText: false });

    const pub = await publicProduct(workspace.id, product.id);
    expect(pub.body.product.rating).toMatchObject({ average: 5, count: 1 });
    expect(pub.body.product.reviews[0]).toMatchObject({ rating: 5, comment: null, photos: [] });
  });

  it('averages several delivered buyers, leaving out the others', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct({ stock: 20 });
    for (const phone of ['01000001111', '01000002222']) {
      const order = await placeOrder(auth.accessToken, workspace.id, variant.id, phone, `Buyer ${phone}`);
      await markDelivered(auth.accessToken, workspace.id, order.id);
    }
    await submitReview(workspace.id, product.id, { phone: '01000001111', rating: 5 });
    await submitReview(workspace.id, product.id, { phone: '01000002222', rating: 2 });
    await submitReview(workspace.id, product.id, { phone: '01000003333', rating: 1 });
    for (const r of (await staffList(auth.accessToken, workspace.id)).body.reviews) await moderate(auth.accessToken, workspace.id, r.id, 'approve');

    const pub = await publicProduct(workspace.id, product.id);
    expect(pub.body.product.rating).toMatchObject({ average: 3.5, count: 2, distribution: { 1: 0, 2: 1, 3: 0, 4: 0, 5: 1 } });
    expect(pub.body.product.reviews).toHaveLength(3);
  });

  it('a review the merchant added by hand shows but does not count', async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/reviews`)
      .set(bearer(auth.accessToken))
      .send({ productId: product.id, authorName: 'Sara Hassan', rating: 5, comment: 'from WhatsApp' });
    expect(res.status).toBe(201);
    const pub = await publicProduct(workspace.id, product.id);
    expect(pub.body.product.rating.count).toBe(0);
    expect(pub.body.product.reviews[0]).toMatchObject({ authorName: 'Sara', verified: false });
  });
});

describe('the order a review is linked to', () => {
  it("the store's review link (an order's signed token) links that order without a phone", async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    const stored = await db.Order.findByPk(order.id);
    const res = await submitReview(workspace.id, product.id, { orderToken: tokenFor(stored), rating: 4 });
    expect(res.status).toBe(201);
    const row = await db.Review.findOne({ where: { workspaceId: workspace.id } });
    expect(row.orderId).toBe(order.id);
    expect(row.phoneNormalized).toBe('201000009999');
  });

  it('a forged token links nothing and then needs a phone', async () => {
    const { workspace, product } = await setupWorkspaceWithProduct();
    const res = await submitReview(workspace.id, product.id, { orderToken: 'AAAAAAAAAAAAAAAAAAAAAA.forged', rating: 4 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_PHONE');
  });
});

describe("the customer's details", () => {
  it('reach the merchant in full; the page shows a first name only', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, PHONE, 'Mona Ahmed Ali');
    await markDelivered(auth.accessToken, workspace.id, order.id);
    await submitReview(workspace.id, product.id, { phone: PHONE, rating: 5 });

    const [row] = (await staffList(auth.accessToken, workspace.id)).body.reviews;
    expect(row.customer).toMatchObject({ fullName: 'Mona Ahmed Ali', email: 'buyer@example.com' });
    expect(row.customer.phone).toBeTruthy();
    expect(row.reviewerPhone).toBe('201000009999');
    expect(row.product).toMatchObject({ id: product.id });
    await moderate(auth.accessToken, workspace.id, row.id, 'approve').expect(200);

    const pub = await publicProduct(workspace.id, product.id);
    const text = JSON.stringify(pub.body.product.reviews);
    expect(pub.body.product.reviews[0].authorName).toBe('Mona');
    expect(text).not.toContain('Ahmed');
    expect(text).not.toContain('9999');
    expect(text).not.toContain('buyer@example.com');
  });

  it('a teammate without customers.view sees the review but not the phone or email', async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    await submitReview(workspace.id, product.id, { phone: PHONE, rating: 5, name: 'Mona' });
    const editor = await addMemberWithRole(auth.accessToken, workspace.id, 'editor', 'Rev Editor');
    const res = await staffList(editor.accessToken, workspace.id);
    expect(res.status).toBe(200);
    expect(res.body.reviews[0]).toMatchObject({ authorName: 'Mona', reviewerPhone: null });
  });

  it('staff moderation is workspace-scoped (404 cross-workspace)', async () => {
    const { workspace, product } = await setupWorkspaceWithProduct();
    await submitReview(workspace.id, product.id, { phone: PHONE, rating: 5 });
    const review = await db.Review.findOne({ where: { workspaceId: workspace.id } });

    const other = await registerAndActivate({ fullName: 'Rev Other' });
    await createWorkspace(other.accessToken, 'Rev Other WS');
    const res = await moderate(other.accessToken, workspace.id, review.id, 'approve');
    expect(res.status).toBe(404);
  });
});

describe('store reviews', () => {
  it('are their own: the store gets its stars, the product none', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await markDelivered(auth.accessToken, workspace.id, order.id);
    const sent = await submitStoreReview(workspace.id, { phone: PHONE, rating: 5, comment: 'great store' });
    expect(sent.status).toBe(201);
    expect((await submitStoreReview(workspace.id, { phone: PHONE, rating: 1 })).status).toBe(409);

    const [row] = (await staffList(auth.accessToken, workspace.id, '?kind=store')).body.reviews;
    expect(row).toMatchObject({ kind: 'store', product: null, purchase: { state: 'delivered', orderId: order.id } });
    await moderate(auth.accessToken, workspace.id, row.id, 'approve').expect(200);

    const store = await request(app).get(`/api/v1/store/${workspace.id}/store-reviews`);
    expect(store.status).toBe(200);
    expect(store.body.rating).toMatchObject({ average: 5, count: 1 });
    expect(store.body.reviews[0]).toMatchObject({ comment: 'great store', verified: true });

    const storefront = await request(app).get(`/api/v1/store/${workspace.id}`);
    expect(storefront.body.store.reviews).toMatchObject({ open: true, storeRating: { average: 5, count: 1 } });

    const pub = await publicProduct(workspace.id, product.id);
    expect(pub.body.product.rating.count).toBe(0);
    expect(pub.body.product.reviews).toEqual([]);
  });
});

describe('photos and deleting', () => {
  it("a shopper's photo shows only while its published review shows it, and goes with the review", async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const visitor = 'visitor-review-1';
    const upload = await request(app)
      .post(`/api/v1/store/${workspace.id}/uploads`)
      .set('X-Visitor-Id', visitor)
      .attach('file', await pngWithAlpha(), { filename: 'p.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    const uploadId = upload.body.upload.uploadId;

    // Another visitor cannot take it.
    const stolen = await submitReview(workspace.id, product.id, { phone: '01000004444', rating: 4, photoUploadIds: [uploadId] }, { 'X-Visitor-Id': 'visitor-other-2' });
    expect(stolen.status).toBe(422);

    const sent = await submitReview(workspace.id, product.id, { phone: PHONE, rating: 4, photoUploadIds: [uploadId] }, { 'X-Visitor-Id': visitor });
    expect(sent.status).toBe(201);
    expect((await db.CustomerUpload.findByPk(uploadId)).status).toBe('attached');

    const photoUrl = `/api/v1/store/${workspace.id}/review-photos/${uploadId}`;
    expect((await request(app).get(photoUrl)).status).toBe(404);

    const [row] = (await staffList(auth.accessToken, workspace.id)).body.reviews;
    expect(row.photos[0]).toMatch(/\/customer-uploads\//);
    await moderate(auth.accessToken, workspace.id, row.id, 'approve').expect(200);
    const pub = await publicProduct(workspace.id, product.id);
    expect(pub.body.product.reviews[0].photos[0]).toContain(photoUrl);
    const photo = await request(app).get(photoUrl);
    expect(photo.status).toBe(200);
    expect(photo.headers['content-type']).toMatch(/^image\//);

    const removed = await request(app).delete(`/api/v1/workspaces/${workspace.id}/reviews/${row.id}`).set(bearer(auth.accessToken));
    expect(removed.status).toBe(200);
    expect(await db.Review.count({ where: { workspaceId: workspace.id } })).toBe(0);
    expect(await db.CustomerUpload.findByPk(uploadId)).toBeNull();
    expect((await request(app).get(photoUrl)).status).toBe(404);
  });
});
