'use strict';

// Reviews the merchant brings from other sites (source 'external',
// migration 731, reviews/manualReviews.js): shown apart with their source,
// never as a verified buyer, never in the stars; only the merchant's team adds
// or edits them; the reviews added by hand before stay as they were.

const { app, request, setupWorkspaceWithProduct, addMemberWithRole, confirmCodOrder } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

const add = (ctx, body, token = ctx.auth.accessToken) =>
  request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/reviews`).set(bearer(token)).send(body);
const edit = (ctx, id, body) => request(app).patch(`/api/v1/workspaces/${ctx.workspace.id}/reviews/${id}/content`).set(bearer(ctx.auth.accessToken)).send(body);
const publicProduct = (ctx) => request(app).get(`/api/v1/store/${ctx.workspace.id}/products/${ctx.product.id}`);

async function deliveredBuyerReview(ctx, rating) {
  const phone = '01020304050';
  const order = await request(app)
    .post(`/api/v1/workspaces/${ctx.workspace.id}/orders`)
    .set(bearer(ctx.auth.accessToken))
    .set('Idempotency-Key', `ext-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({ items: [{ variantId: ctx.variant.id, quantity: 1 }], contact: { fullName: 'Real Buyer', phone }, shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 St' }, paymentMethod: 'cod' });
  await confirmCodOrder(ctx.auth.accessToken, ctx.workspace.id, order.body.order.id);
  const ship = await request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${order.body.order.id}/shipments`).set(bearer(ctx.auth.accessToken)).send({ carrierCode: 'local-courier' });
  await request(app).patch(`/api/v1/workspaces/${ctx.workspace.id}/orders/${order.body.order.id}/shipments/${ship.body.shipment.id}`).set(bearer(ctx.auth.accessToken)).send({ status: 'delivered' }).expect(200);
  env.reviews.publicSubmissionEnabled = true;
  try {
    await request(app).post(`/api/v1/store/${ctx.workspace.id}/products/${ctx.product.id}/reviews`).send({ phone, rating }).expect(201);
  } finally {
    env.reviews.publicSubmissionEnabled = false;
  }
  const row = await db.Review.findOne({ where: { workspaceId: ctx.workspace.id, source: 'customer' } });
  await request(app).patch(`/api/v1/workspaces/${ctx.workspace.id}/reviews/${row.id}`).set(bearer(ctx.auth.accessToken)).send({ action: 'approve' }).expect(200);
}

describe('reviews from other sites', () => {
  it('show apart with their source, never verified and never in the stars', async () => {
    const ctx = await setupWorkspaceWithProduct();
    await deliveredBuyerReview(ctx, 4);
    const res = await add(ctx, {
      productId: ctx.product.id,
      authorName: 'Mona Ahmed',
      rating: 1,
      comment: 'seen on <b>facebook</b>',
      externalSource: 'facebook',
      externalUrl: 'https://facebook.com/some/post',
      reviewedAt: '2026-09-01',
    });
    expect(res.status).toBe(201);
    expect(res.body.review).toMatchObject({ source: 'external', externalSource: 'facebook', comment: 'seen on facebook' });

    const pub = await publicProduct(ctx);
    // The stars are the delivered buyer's alone.
    expect(pub.body.product.rating).toMatchObject({ average: 4, count: 1 });
    expect(pub.body.product.reviews).toHaveLength(1);
    expect(pub.body.product.reviews[0].verified).toBe(true);
    expect(pub.body.product.externalReviews).toEqual([
      expect.objectContaining({ rating: 1, authorName: 'Mona', source: 'facebook', sourceLabel: null, url: 'https://facebook.com/some/post', reviewedAt: '2026-09-01', verified: false }),
    ]);
  });

  it('on the whole store, with a source the merchant names', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const res = await add(ctx, { kind: 'store', authorName: 'Ali', rating: 5, externalSource: 'other', externalSourceLabel: 'A forum' });
    expect(res.status).toBe(201);
    const store = await request(app).get(`/api/v1/store/${ctx.workspace.id}/store-reviews`);
    expect(store.body.rating.count).toBe(0);
    expect(store.body.reviews).toEqual([]);
    expect(store.body.externalReviews[0]).toMatchObject({ source: 'other', sourceLabel: 'A forum', verified: false });
  });

  it('refuses a link that is not a web address, and a date still to come', async () => {
    const ctx = await setupWorkspaceWithProduct();
    expect((await add(ctx, { productId: ctx.product.id, authorName: 'A', rating: 5, externalSource: 'google', externalUrl: 'javascript:alert(1)' })).status).toBe(422);
    expect((await add(ctx, { productId: ctx.product.id, authorName: 'A', rating: 5, externalSource: 'google', reviewedAt: '2999-01-01' })).status).toBe(422);
    expect((await add(ctx, { productId: ctx.product.id, authorName: 'A', rating: 5, externalSource: 'myspace' })).status).toBe(422);
  });

  it('only the merchant\'s team adds them (products.manage), and nobody from the storefront', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const operator = await addMemberWithRole(ctx.auth.accessToken, ctx.workspace.id, 'order_operator', 'No Products');
    expect((await add(ctx, { productId: ctx.product.id, authorName: 'A', rating: 5, externalSource: 'google' }, operator.accessToken)).status).toBe(403);
    expect((await request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/reviews`).send({ productId: ctx.product.id, authorName: 'A', rating: 5, externalSource: 'google' })).status).toBe(401);
    const editor = await addMemberWithRole(ctx.auth.accessToken, ctx.workspace.id, 'editor', 'Products');
    expect((await add(ctx, { productId: ctx.product.id, authorName: 'A', rating: 5, externalSource: 'google' }, editor.accessToken)).status).toBe(201);
  });

  it('are edited, hidden and deleted like the rest; a shopper\'s own words are never edited', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const created = (await add(ctx, { productId: ctx.product.id, authorName: 'Sara', rating: 3, externalSource: 'instagram' })).body.review;
    const edited = await edit(ctx, created.id, { rating: 4, externalSource: 'whatsapp', comment: 'better' });
    expect(edited.status).toBe(200);
    expect(edited.body.review).toMatchObject({ rating: 4, externalSource: 'whatsapp', comment: 'better', source: 'external' });

    await request(app).patch(`/api/v1/workspaces/${ctx.workspace.id}/reviews/${created.id}`).set(bearer(ctx.auth.accessToken)).send({ action: 'hide' }).expect(200);
    expect((await publicProduct(ctx)).body.product.externalReviews).toEqual([]);

    const list = await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/reviews?source=external`).set(bearer(ctx.auth.accessToken));
    expect(list.body.reviews.map((r) => r.id)).toEqual([created.id]);

    expect((await request(app).delete(`/api/v1/workspaces/${ctx.workspace.id}/reviews/${created.id}`).set(bearer(ctx.auth.accessToken))).status).toBe(200);

    env.reviews.publicSubmissionEnabled = true;
    try {
      await request(app).post(`/api/v1/store/${ctx.workspace.id}/products/${ctx.product.id}/reviews`).send({ phone: '01099887766', rating: 2, comment: 'mine' }).expect(201);
    } finally {
      env.reviews.publicSubmissionEnabled = false;
    }
    const shopper = await db.Review.findOne({ where: { workspaceId: ctx.workspace.id, source: 'customer' } });
    const refused = await edit(ctx, shopper.id, { comment: 'nicer words' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('REVIEW_NOT_EDITABLE');
  });

  it('a review added by hand before stays where and how it was, and can be given a source', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const old = (await add(ctx, { productId: ctx.product.id, authorName: 'Old Friend', rating: 5, comment: 'by hand' })).body.review;
    expect(old.source).toBe('manual');
    let pub = await publicProduct(ctx);
    expect(pub.body.product.reviews[0]).toMatchObject({ comment: 'by hand', authorName: 'Old', verified: false });
    expect(pub.body.product.externalReviews).toEqual([]);

    await edit(ctx, old.id, { externalSource: 'google' }).expect(200);
    pub = await publicProduct(ctx);
    expect(pub.body.product.reviews).toEqual([]);
    expect(pub.body.product.externalReviews[0]).toMatchObject({ source: 'google', comment: 'by hand' });
  });
});
