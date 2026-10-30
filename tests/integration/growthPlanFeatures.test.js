'use strict';

/**
 * reviews, about_gallery, combos and advanced_coupons as plan features
 * (billing/growthFeatures.js): refused only while GROWTH_REQUIRE_PLAN_FEATURE
 * and PLAN_FEATURE_ENFORCEMENT are both on, for a store whose plan (or the
 * console's override) lacks the key. What a store already has stays stored
 * and comes back with the feature; plain coupons stay on every plan.
 */

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct, createProductWithVariant } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const ORIGINAL = { growth: env.growth.requirePlanFeature, enforcement: env.planFeatures.enforcement, combos: env.combos.enabled, submission: env.reviews.publicSubmissionEnabled };
afterEach(() => {
  env.growth.requirePlanFeature = ORIGINAL.growth;
  env.planFeatures.enforcement = ORIGINAL.enforcement;
  env.combos.enabled = ORIGINAL.combos;
  env.reviews.publicSubmissionEnabled = ORIGINAL.submission;
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const key = () => `gpf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const code = (res) => res.body && res.body.error && res.body.error.code;
const gateOn = () => {
  env.growth.requirePlanFeature = true;
  env.planFeatures.enforcement = true;
};

async function onPlan(ctx, features) {
  const plan = await db.Plan.create({ key: `gpf-${crypto.randomBytes(4).toString('hex')}`, name: 'Plan', currency: 'EGP', monthlyPriceAmount: 10000, yearlyPriceAmount: 100000, trialDays: 14, isActive: true, isPublic: true, features });
  await db.Subscription.update({ planId: plan.id }, { where: { workspaceId: ctx.workspace.id } });
}

const staff = (ctx, method, url, body) => request(app)[method](`/api/v1/workspaces/${ctx.workspace.id}${url}`).set(bearer(ctx.auth.accessToken)).send(body);
const store = (ctx, url) => request(app).get(`/api/v1/store/${ctx.workspace.id}${url}`);

describe('off (the default)', () => {
  it('with only one of the two switches on, a plan without the keys loses nothing', async () => {
    const ctx = await setupWorkspaceWithProduct();
    await onPlan(ctx, []);
    for (const [growth, enforcement] of [[false, true], [true, false]]) {
      env.growth.requirePlanFeature = growth;
      env.planFeatures.enforcement = enforcement;
      expect((await staff(ctx, 'get', '/reviews')).status).toBe(200);
      const made = await staff(ctx, 'post', '/discounts', { code: `NEW${growth ? 1 : 0}`, type: 'fixed', value: 100, audience: 'new' });
      expect(made.status).toBe(201);
      expect((await staff(ctx, 'get', `/discounts/${made.body.discount.id}/report`)).status).toBe(200);
    }
    const plan = await staff(ctx, 'get', '/plan-features');
    expect(plan.body.planFeatures).toMatchObject({ enforced: false, growthEnforced: false });
  });
});

describe('reviews', () => {
  it('without the key: the staff screen refuses, the store shows none and takes none; with it they are back', async () => {
    const ctx = await setupWorkspaceWithProduct();
    await onPlan(ctx, []);
    expect((await staff(ctx, 'post', '/reviews', { productId: ctx.product.id, authorName: 'Mona', rating: 5, comment: 'Great', externalSource: 'facebook' })).status).toBe(201);
    expect((await staff(ctx, 'post', '/reviews', { kind: 'store', authorName: 'Ali', rating: 4, comment: 'Fast', externalSource: 'google' })).status).toBe(201);

    gateOn();
    env.reviews.publicSubmissionEnabled = true;
    const refused = await staff(ctx, 'get', '/reviews');
    expect(refused.status).toBe(403);
    expect(refused.body.error.details).toEqual({ feature: 'reviews', label: { en: 'Product and store reviews', ar: 'تقييمات المنتجات والمتجر' } });
    expect((await staff(ctx, 'get', '/plan-features')).body.planFeatures).toMatchObject({ enforced: true, growthEnforced: true });

    const product = (await store(ctx, `/products/${ctx.product.id}`)).body.product;
    expect(product).toMatchObject({ reviews: [], externalReviews: [], rating: { average: null, count: 0 } });
    expect((await store(ctx, '/store-reviews')).body).toMatchObject({ reviews: [], externalReviews: [] });
    expect((await store(ctx, '')).body.store.reviews).toEqual({ open: false, storeRating: { average: null, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } } });
    const sent = await request(app).post(`/api/v1/store/${ctx.workspace.id}/products/${ctx.product.id}/reviews`).send({ phone: '01012345678', rating: 5 });
    expect(sent.status).toBe(404);
    expect(await db.Review.count({ where: { workspaceId: ctx.workspace.id } })).toBe(2);

    await onPlan(ctx, ['reviews']);
    expect((await staff(ctx, 'get', '/reviews')).status).toBe(200);
    expect((await store(ctx, `/products/${ctx.product.id}`)).body.product.externalReviews).toHaveLength(1);
    expect((await store(ctx, '/store-reviews')).body.externalReviews).toHaveLength(1);
    expect((await store(ctx, '')).body.store.reviews.open).toBe(true);
  });
});

describe('about_gallery', () => {
  const gallery = (items) => ({ id: 'g1', type: 'story_gallery', props: { title: 'قصتنا', columns: 3, items } });
  const heading = { id: 'h1', type: 'heading', props: { text: 'أهلاً' } };
  const tree = (elements) => ({ version: 1, sections: [{ id: 's1', type: 'section', settings: {}, rows: [{ id: 'r1', type: 'row', settings: {}, columns: [{ id: 'c1', type: 'column', span: 12, settings: {}, elements }] }] }] });
  const photos = [{ src: 'https://cdn.example.com/a.jpg', title: 'المحل' }, { src: 'https://cdn.example.com/b.jpg' }];

  it('without the key: a gallery already saved stays (hidden from shoppers), a new or changed one is refused', async () => {
    const ctx = await setupWorkspaceWithProduct();
    await onPlan(ctx, []);
    const site = await staff(ctx, 'post', '/websites', { name: 'Story' });
    const base = `/websites/${site.body.website.id}`;
    expect((await staff(ctx, 'post', `${base}/pages`, { path: '/', title: 'Home', draftData: tree([heading]) })).status).toBe(201);
    const about = await staff(ctx, 'post', `${base}/pages`, { path: '/about', title: 'About', draftData: tree([heading, gallery(photos)]) });
    expect(about.status).toBe(201);
    expect((await staff(ctx, 'post', `${base}/publish`, {})).status).toBe(201);
    const live = async () => (await store(ctx, '/pages?path=/about')).body.page.tree.sections[0].rows[0].columns[0].elements.map((e) => e.type);
    expect(await live()).toEqual(['heading', 'story_gallery']);

    gateOn();
    expect(await live()).toEqual(['heading']);
    // Saved again as it is, with its keys in another order: passes.
    const same = { ...tree([heading, { props: { items: photos, columns: 3, title: 'قصتنا' }, type: 'story_gallery', id: 'g1' }]) };
    expect((await staff(ctx, 'patch', `${base}/pages/${about.body.page.id}`, { draftData: same })).status).toBe(200);
    const changed = await staff(ctx, 'patch', `${base}/pages/${about.body.page.id}`, { draftData: tree([heading, gallery([photos[1]])]) });
    expect(changed.status).toBe(403);
    expect(changed.body.error.details.feature).toBe('about_gallery');
    expect(code(await staff(ctx, 'post', `${base}/pages`, { path: '/story', title: 'Story', draftData: tree([heading, gallery(photos)]) }))).toBe('PLAN_FEATURE_REQUIRED');
    // Taking it out passes.
    expect((await staff(ctx, 'patch', `${base}/pages/${about.body.page.id}`, { draftData: tree([heading]) })).status).toBe(200);

    await db.WorkspaceFeatureOverride.create({ workspaceId: ctx.workspace.id, featureKey: 'about_gallery', mode: 'grant', reason: 'test' });
    expect(await live()).toEqual(['heading', 'story_gallery']);
    expect((await staff(ctx, 'patch', `${base}/pages/${about.body.page.id}`, { draftData: tree([heading, gallery([photos[1]])]) })).status).toBe(200);
  });
});

describe('combos', () => {
  it('without the key: the staff routes refuse, the store offers none and a checkout naming one gets 404', async () => {
    env.combos.enabled = true;
    const ctx = await setupWorkspaceWithProduct({ price: 1000, stock: 10 });
    const b = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id, { price: 2000, stock: 10 });
    await onPlan(ctx, []);
    const made = await staff(ctx, 'post', '/combos', { name: 'Pair', status: 'active', pricingMode: 'fixed_price', priceValue: 2500, items: [{ productId: ctx.product.id, variantId: ctx.variant.id }, { productId: b.product.id, variantId: b.variant.id }] });
    expect(made.status).toBe(201);
    const buy = () =>
      request(app)
        .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
        .set('Idempotency-Key', key())
        .send({ item: { comboId: made.body.combo.id, quantity: 1 }, contact: { fullName: 'Combo Buyer', phone: '01012121234' }, shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 St' }, paymentMethod: 'cod' });

    gateOn();
    expect(code(await staff(ctx, 'get', '/combos'))).toBe('PLAN_FEATURE_REQUIRED');
    expect((await store(ctx, `/combos?productId=${ctx.product.id}`)).body.combos).toEqual([]);
    expect((await store(ctx, `/products/${ctx.product.id}`)).body.product.combos).toEqual([]);
    expect((await buy()).status).toBe(404);

    await onPlan(ctx, ['combos']);
    expect((await store(ctx, `/combos?productId=${ctx.product.id}`)).body.combos).toHaveLength(1);
    const bought = await buy();
    expect(bought.status).toBe(201);
    expect(Number(bought.body.order.subtotalAmount)).toBe(2500);
  });
});

describe('advanced_coupons', () => {
  it('without the key: plain coupons as before, the controls and the report refused, a saved coupon kept as it is', async () => {
    const ctx = await setupWorkspaceWithProduct({ price: 1000, stock: 10 });
    await onPlan(ctx, []);
    const saved = await staff(ctx, 'post', '/discounts', { code: 'TWOPLUS', type: 'fixed', value: 100, minQuantity: 2 });
    expect(saved.status).toBe(201);

    gateOn();
    expect((await staff(ctx, 'post', '/discounts', { code: 'PLAIN', type: 'percentage', value: 1000, minimumSubtotal: 500, usageLimit: 10, productRestrictions: [ctx.product.id] })).status).toBe(201);
    // Each control at its default is the old coupon: passes.
    expect((await staff(ctx, 'post', '/discounts', { code: 'DEFAULTS', type: 'fixed', value: 50, audience: 'any', appliesToDiscounted: true, combinesWithOffers: true, customerPhones: [] })).status).toBe(201);
    const refused = await staff(ctx, 'post', '/discounts', { code: 'FIRST', type: 'fixed', value: 100, audience: 'new' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.details.feature).toBe('advanced_coupons');
    expect(code(await staff(ctx, 'post', '/discounts/bulk', { prefix: 'BULK', count: 3, type: 'fixed', value: 100, appliesToShipping: true }))).toBe('PLAN_FEATURE_REQUIRED');

    const id = saved.body.discount.id;
    // Edited with its control unchanged (as the form sends it back), or the control cleared: passes.
    expect((await staff(ctx, 'patch', `/discounts/${id}`, { value: 150, minQuantity: 2 })).status).toBe(200);
    expect(code(await staff(ctx, 'patch', `/discounts/${id}`, { minQuantity: 3 }))).toBe('PLAN_FEATURE_REQUIRED');
    expect(code(await staff(ctx, 'get', `/discounts/${id}/report`))).toBe('PLAN_FEATURE_REQUIRED');
    expect(code(await staff(ctx, 'get', `/discounts/${id}/report.csv`))).toBe('PLAN_FEATURE_REQUIRED');

    // Still applies its saved rule at the checkout.
    const order = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders`)
      .set(bearer(ctx.auth.accessToken))
      .set('Idempotency-Key', key())
      .send({ items: [{ variantId: ctx.variant.id, quantity: 1 }], contact: { fullName: 'Coupon Buyer', phone: '01012340000' }, shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 St' }, paymentMethod: 'cod', discountCode: 'TWOPLUS' });
    expect(code(order)).toBe('DISCOUNT_MIN_QUANTITY_NOT_MET');

    expect((await staff(ctx, 'patch', `/discounts/${id}`, { minQuantity: null })).status).toBe(200);
    await onPlan(ctx, ['advanced_coupons']);
    expect((await staff(ctx, 'post', '/discounts', { code: 'FIRST', type: 'fixed', value: 100, audience: 'new' })).status).toBe(201);
    expect((await staff(ctx, 'get', `/discounts/${id}/report`)).status).toBe(200);
  });
});
