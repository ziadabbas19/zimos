'use strict';

// Cart rewards (modules/cartRewards, migration 747, CART_REWARDS_ENABLED):
// spend thresholds in the cart that unlock a discount or free shipping. The
// merchant's settings and their checks, the public config, the shipping
// quote's `rewards` (what the cart and the checkout show) and the order the
// checkout then charges — priced by the server only, the single best benefit
// against a code unless the store lets them combine.

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct, createProductWithVariant, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const ORIGINAL = { enabled: env.cartRewards.enabled, growth: env.growth.requirePlanFeature, enforcement: env.planFeatures.enforcement };
beforeEach(() => {
  env.cartRewards.enabled = true;
});
afterEach(() => {
  env.cartRewards.enabled = ORIGINAL.enabled;
  env.growth.requirePlanFeature = ORIGINAL.growth;
  env.planFeatures.enforcement = ORIGINAL.enforcement;
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const key = () => `cr-${crypto.randomUUID()}`;
const CAIRO = 'القاهرة (Cairo)';
const contact = { fullName: 'Reward Buyer', phone: '01012345678' };
const address = { country: 'EG', province: CAIRO, city: 'Cairo', addressLine: '5 Reward Street' };

// EGP 500 a piece, EGP 60 to deliver: free shipping from EGP 500, 5% from EGP 1,000, 10% from EGP 2,000.
const PRICE = 50000;
const FEE = 6000;
const TIERS = [
  { thresholdAmount: 50000, type: 'free_shipping' },
  { thresholdAmount: 100000, type: 'percent', value: 5 },
  { thresholdAmount: 200000, type: 'percent', value: 10 },
];

async function store({ tiers = TIERS, allowCouponStacking = false, fee = FEE } = {}) {
  const ctx = await setupWorkspaceWithProduct({ price: PRICE, stock: 100 });
  const ws = ctx.workspace.id;
  const api = (method, path) => request(app)[method](`/api/v1/workspaces/${ws}${path}`).set(bearer(ctx.auth.accessToken));
  if (fee !== null) {
    const shipping = await api('patch', '/shipping/settings').send({ defaultRateAmount: fee });
    if (shipping.status !== 200) throw new Error(`shipping: ${shipping.status} ${JSON.stringify(shipping.body)}`);
  }
  const out = { ...ctx, ws, api };
  if (tiers) {
    const saved = await api('put', '/cart-rewards').send({ enabled: true, allowCouponStacking, tiers, trustItems: [] });
    if (saved.status !== 200) throw new Error(`cart rewards: ${saved.status} ${JSON.stringify(saved.body)}`);
  }
  return out;
}

const quote = (ctx, quantity, extra = {}) =>
  request(app)
    .post(`/api/v1/store/${ctx.ws}/shipping-quote`)
    .send({ governorate: CAIRO, items: [{ variantId: ctx.variant.id, quantity }], ...extra });

function buyNow(ctx, quantity, extra = {}) {
  return request(app)
    .post(`/api/v1/store/${ctx.ws}/checkout`)
    .set('Idempotency-Key', key())
    .send({ item: { variantId: ctx.variant.id, quantity }, contact, shippingAddress: address, paymentMethod: 'cod', ...extra });
}

async function cartCheckout(ctx, quantity, extra = {}) {
  const cart = await request(app).post(`/api/v1/store/${ctx.ws}/cart`).send({});
  const token = cart.body.guestToken;
  const added = await request(app).post(`/api/v1/store/${ctx.ws}/cart/items`).set('X-Cart-Token', token).send({ variantId: ctx.variant.id, quantity });
  if (added.status !== 201) throw new Error(`cart add: ${added.status} ${JSON.stringify(added.body)}`);
  const q = await request(app).post(`/api/v1/store/${ctx.ws}/shipping-quote`).set('X-Cart-Token', token).send({ governorate: CAIRO });
  const res = await request(app)
    .post(`/api/v1/store/${ctx.ws}/checkout`)
    .set('X-Cart-Token', token)
    .set('Idempotency-Key', key())
    .send({ contact, shippingAddress: address, paymentMethod: 'cod', ...extra });
  return { quote: q.body.quote, res };
}

async function coupon(ctx, body) {
  const res = await ctx.api('post', '/discounts').send({ status: 'active', ...body });
  if (res.status !== 201) throw new Error(`coupon: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.discount;
}

const rewardOf = (order) => (order.discountsSnapshot || []).find((d) => d.kind === 'cart_reward') || null;
const money = (v) => Number(v);
/** What the quote says the shopper pays: the same sum the storefront makes (subtotal − discounts + shipping). */
const quotedTotal = (q) => q.subtotal - (q.rewards ? q.rewards.discountAmount : 0) - (q.automaticDiscount ? q.automaticDiscount.amount : 0) + q.amount;

describe('off (the default)', () => {
  it('without CART_REWARDS_ENABLED: the routes 404, the quote has no rewards and the order is priced as before', async () => {
    const ctx = await store();
    env.cartRewards.enabled = false;
    expect((await ctx.api('get', '/cart-rewards')).status).toBe(404);
    expect((await ctx.api('put', '/cart-rewards').send({ enabled: false })).status).toBe(404);
    expect((await request(app).get(`/api/v1/store/${ctx.ws}/cart-rewards`)).status).toBe(404);
    const q = (await quote(ctx, 4)).body.quote;
    expect(q.rewards).toBeUndefined();
    expect(q.amount).toBe(FEE);
    const res = await buyNow(ctx, 4);
    expect(res.status).toBe(201);
    expect(money(res.body.order.discountAmount)).toBe(0);
    expect(money(res.body.order.totalAmount)).toBe(4 * PRICE + FEE);
    expect(rewardOf(res.body.order)).toBeNull();
  });

  it('a store that never saved the section, or switched it off, gets nothing', async () => {
    const ctx = await store({ tiers: null });
    expect((await ctx.api('get', '/cart-rewards')).body.cartRewards).toMatchObject({ enabled: false, allowCouponStacking: false, tiers: [], trustItems: [], currency: 'EGP' });
    expect((await request(app).get(`/api/v1/store/${ctx.ws}/cart-rewards`)).body).toEqual({ cartRewards: null });
    expect((await quote(ctx, 4)).body.quote.rewards).toBeUndefined();

    await ctx.api('put', '/cart-rewards').send({ enabled: false, tiers: TIERS }).expect(200);
    expect((await quote(ctx, 4)).body.quote.rewards).toBeUndefined();
    expect(money((await buyNow(ctx, 4)).body.order.totalAmount)).toBe(4 * PRICE + FEE);
  });
});

describe('the settings', () => {
  it('saves the section lowest threshold first, with each tier’s automatic name, and audits it', async () => {
    const ctx = await store({ tiers: null });
    const res = await ctx.api('put', '/cart-rewards').send({
      enabled: true,
      allowCouponStacking: true,
      tiers: [
        { thresholdAmount: 100000, type: 'percent', value: 5, label: { ar: 'هدية', en: '' } },
        { thresholdAmount: 50000, type: 'free_shipping', value: 99 },
        { thresholdAmount: 300000, type: 'fixed', value: 25000 },
      ],
      trustItems: [{ text: { ar: 'الدفع عند الاستلام', en: 'Cash on delivery' } }, { text: { ar: '', en: 'Inspect before paying' }, enabled: false }],
      somethingElse: 'dropped',
    });
    expect(res.status).toBe(200);
    expect(res.body.cartRewards).toEqual({
      enabled: true,
      allowCouponStacking: true,
      currency: 'EGP',
      tiers: [
        { thresholdAmount: 50000, type: 'free_shipping', label: null, autoLabel: { en: 'Free shipping', ar: 'شحن مجاني' } },
        { thresholdAmount: 100000, type: 'percent', value: 5, label: { ar: 'هدية', en: null }, autoLabel: { en: '5% off', ar: 'خصم 5%' } },
        { thresholdAmount: 300000, type: 'fixed', value: 25000, label: null, autoLabel: expect.objectContaining({ en: expect.stringMatching(/^EGP\s250 off$/) }) },
      ],
      trustItems: [
        { text: { ar: 'الدفع عند الاستلام', en: 'Cash on delivery' }, enabled: true },
        { text: { ar: '', en: 'Inspect before paying' }, enabled: false },
      ],
    });
    expect((await ctx.api('get', '/cart-rewards')).body.cartRewards).toEqual(res.body.cartRewards);
    expect(await db.AuditLog.count({ where: { workspaceId: ctx.ws, action: 'cart_rewards.update' } })).toBe(1);
  });

  it('refuses thresholds that do not rise within a kind, a bad value, more than six tiers and an empty trust line', async () => {
    const ctx = await store({ tiers: null });
    const put = (body) => ctx.api('put', '/cart-rewards').send({ enabled: true, ...body });
    const fields = (res) => res.body.error.details.map((d) => d.field);

    const falling = await put({ tiers: [{ thresholdAmount: 200000, type: 'percent', value: 10 }, { thresholdAmount: 100000, type: 'fixed', value: 500 }] });
    expect(falling.status).toBe(422);
    expect(fields(falling)).toEqual(['tiers.1.thresholdAmount']);
    // The same threshold twice for one kind is not higher.
    expect((await put({ tiers: [{ thresholdAmount: 100000, type: 'free_shipping' }, { thresholdAmount: 100000, type: 'free_shipping' }] })).status).toBe(422);
    // Different kinds may share one.
    expect((await put({ tiers: [{ thresholdAmount: 100000, type: 'free_shipping' }, { thresholdAmount: 100000, type: 'percent', value: 5 }] })).status).toBe(200);

    expect(fields(await put({ tiers: [{ thresholdAmount: 100000, type: 'percent', value: 101 }] }))).toEqual(['tiers.0.value']);
    expect(fields(await put({ tiers: [{ thresholdAmount: 100000, type: 'percent', value: 0 }] }))).toEqual(['tiers.0.value']);
    expect(fields(await put({ tiers: [{ thresholdAmount: 100000, type: 'fixed' }] }))).toEqual(['tiers.0.value']);
    expect(fields(await put({ tiers: [{ thresholdAmount: 0, type: 'free_shipping' }] }))).toEqual(['tiers.0.thresholdAmount']);
    expect(fields(await put({ tiers: [{ thresholdAmount: 100, type: 'cashback', value: 1 }] }))).toContain('tiers.0.type');
    const seven = Array.from({ length: 7 }, (_, i) => ({ thresholdAmount: (i + 1) * 10000, type: 'fixed', value: i + 1 }));
    expect(fields(await put({ tiers: seven }))).toEqual(['tiers']);
    expect(fields(await put({ tiers: [] }))).toEqual(['tiers']);
    expect(fields(await put({ tiers: TIERS, trustItems: [{ text: { ar: ' ', en: '' } }] }))).toEqual(['trustItems.0.text']);
  });

  it('needs discounts.manage, like the coupons', async () => {
    const ctx = await store({ tiers: null });
    const agent = await addMemberWithRole(ctx.auth.accessToken, ctx.ws, 'confirmation_agent', 'Agent');
    const res = await request(app).get(`/api/v1/workspaces/${ctx.ws}/cart-rewards`).set(bearer(agent.accessToken));
    expect(res.status).toBe(403);
  });
});

describe('as a plan feature', () => {
  async function onPlan(ctx, features) {
    const plan = await db.Plan.create({ key: `cr-${crypto.randomBytes(4).toString('hex')}`, name: 'Plan', currency: 'EGP', monthlyPriceAmount: 10000, yearlyPriceAmount: 100000, trialDays: 14, isActive: true, isPublic: true, features });
    await db.Subscription.update({ planId: plan.id }, { where: { workspaceId: ctx.ws } });
  }

  it('without the key while the growth gate is on: the screen refuses, the store and the checkout give nothing; the settings stay', async () => {
    const ctx = await store();
    await onPlan(ctx, []);
    env.growth.requirePlanFeature = true;
    env.planFeatures.enforcement = true;

    const refused = await ctx.api('get', '/cart-rewards');
    expect(refused.status).toBe(403);
    expect(refused.body.error.details).toEqual({ feature: 'cart_rewards', label: { en: 'Cart rewards', ar: 'مكافآت السلة' } });
    expect((await request(app).get(`/api/v1/store/${ctx.ws}/cart-rewards`)).body).toEqual({ cartRewards: null });
    expect((await quote(ctx, 4)).body.quote.rewards).toBeUndefined();
    expect(money((await buyNow(ctx, 4)).body.order.totalAmount)).toBe(4 * PRICE + FEE);

    await onPlan(ctx, ['cart_rewards']);
    expect((await ctx.api('get', '/cart-rewards')).status).toBe(200);
    expect(money((await buyNow(ctx, 4)).body.order.totalAmount)).toBe(4 * PRICE - 20000 + FEE);
  });
});

describe('the public config', () => {
  it('the tiers with their names and only the trust lines switched on', async () => {
    const ctx = await store();
    await ctx.api('put', '/cart-rewards').send({
      enabled: true,
      tiers: TIERS,
      trustItems: [{ text: { ar: 'الدفع عند الاستلام', en: 'Cash on delivery' } }, { text: { ar: 'معاينة قبل الدفع', en: '' }, enabled: false }],
    });
    const res = await request(app).get(`/api/v1/store/${ctx.ws}/cart-rewards`);
    expect(res.status).toBe(200);
    expect(res.body.cartRewards).toEqual({
      currency: 'EGP',
      allowCouponStacking: false,
      tiers: [
        { thresholdAmount: 50000, type: 'free_shipping', value: null, label: { en: 'Free shipping', ar: 'شحن مجاني' } },
        { thresholdAmount: 100000, type: 'percent', value: 5, label: { en: '5% off', ar: 'خصم 5%' } },
        { thresholdAmount: 200000, type: 'percent', value: 10, label: { en: '10% off', ar: 'خصم 10%' } },
      ],
      trustItems: [{ text: { ar: 'الدفع عند الاستلام', en: 'Cash on delivery' } }],
    });
  });
});

describe('the quote (what the cart and the checkout show)', () => {
  it('below every tier: nothing applied, the first tier next with what it needs', async () => {
    const ctx = await store();
    await db.ProductVariant.update({ priceAmount: 20000 }, { where: { id: ctx.variant.id } });
    const q = (await quote(ctx, 1)).body.quote;
    expect(q.rewards).toMatchObject({
      applied: null,
      discountAmount: 0,
      next: { index: 0, thresholdAmount: 50000, remainingAmount: 30000, type: 'free_shipping' },
      notes: [],
      savedAmount: 0,
      shippingFeeAmount: FEE,
    });
    expect(q.rewards.tiers.map((t) => t.reached)).toEqual([false, false, false]);
    expect(q.amount).toBe(FEE);
  });

  it('free shipping reached and worth more than 5%: the quote ships free', async () => {
    const ctx = await store();
    const q = (await quote(ctx, 2)).body.quote;
    expect(q.rewards.applied).toMatchObject({ type: 'free_shipping', amount: FEE, freeShipping: true, label: { en: 'Free shipping', ar: 'شحن مجاني' } });
    expect(q.rewards).toMatchObject({ discountAmount: 0, next: { index: 2, remainingAmount: 100000 }, savedAmount: FEE });
    expect(q).toMatchObject({ amount: 0, freeShipping: null });
  });

  it('5% saving more than the fee: the discount, with the note, and the fee charged', async () => {
    const ctx = await store();
    const q = (await quote(ctx, 3)).body.quote;
    expect(q.rewards.applied).toMatchObject({ type: 'percent', value: 5, amount: 7500, freeShipping: false });
    expect(q.rewards).toMatchObject({ discountAmount: 7500, notes: ['discount_over_free_shipping'], savedAmount: 7500 });
    expect(q.amount).toBe(FEE);
  });

  it('no governorate yet: a reached discount shows, without comparing it to a fee nobody knows', async () => {
    const ctx = await store();
    const q = (await quote(ctx, 2, { governorate: null })).body.quote;
    expect(q.rewards).toMatchObject({ applied: { type: 'percent', amount: 5000 }, notes: [], shippingFeeAmount: null });
  });

  it('pickup: no fee, so free shipping is worth nothing and the discount wins', async () => {
    const ctx = await store();
    const q = (await quote(ctx, 2, { deliveryMethod: 'pickup' })).body.quote;
    expect(q.rewards.applied).toMatchObject({ type: 'percent', amount: 5000 });
  });

  it('what the shopper saves counts the compare-at prices too', async () => {
    const ctx = await store();
    await db.ProductVariant.update({ compareAtAmount: 60000 }, { where: { id: ctx.variant.id } });
    const q = (await quote(ctx, 4)).body.quote;
    expect(q.rewards).toMatchObject({ compareAtSavings: 40000, discountAmount: 20000, savedAmount: 60000 });
  });

  it('a code typed at checkout is weighed against the reward; a refused code says why', async () => {
    const ctx = await store();
    await coupon(ctx, { code: 'TENOFF', type: 'percentage', value: 1000 });
    const won = (await quote(ctx, 3, { discountCode: 'tenoff' })).body.quote;
    expect(won.rewards).toMatchObject({ applied: null, discountAmount: 0, coupon: { code: 'TENOFF', applied: true, amount: 15000 }, notes: ['coupon_over_reward'] });
    const refused = (await quote(ctx, 3, { discountCode: 'NOPE' })).body.quote;
    expect(refused.rewards.coupon).toEqual({ code: 'NOPE', automatic: false, applied: false, amount: 0, refused: 'INVALID_DISCOUNT_CODE' });
    expect(refused.rewards.applied).toMatchObject({ type: 'percent', amount: 7500 });
  });

  it('a funnel’s quote has no rewards', async () => {
    const ctx = await store();
    const q = await quote(ctx, 4, { funnelId: crypto.randomUUID() });
    expect(q.status).toBe(200);
    expect(q.body.quote.rewards).toBeUndefined();
  });
});

describe('the order (what the checkout charges)', () => {
  it('charges exactly what the cart’s quote showed, and keeps the reward on the order', async () => {
    const ctx = await store();
    for (const [quantity, reward, shipping] of [
      [1, { rewardType: 'free_shipping', amount: FEE, freeShipping: true }, 0],
      [2, { rewardType: 'free_shipping', amount: FEE, freeShipping: true }, 0],
      [3, { rewardType: 'percent', value: 5, amount: 7500, freeShipping: false }, FEE],
      [4, { rewardType: 'percent', value: 10, amount: 20000, freeShipping: false }, FEE],
    ]) {
      const { quote: q, res } = await cartCheckout(ctx, quantity);
      expect(res.status).toBe(201);
      const order = res.body.order;
      expect(rewardOf(order)).toMatchObject({ kind: 'cart_reward', ...reward });
      expect(money(order.shippingAmount)).toBe(shipping);
      expect(money(order.discountAmount)).toBe(reward.freeShipping ? 0 : reward.amount);
      expect(money(order.totalAmount)).toBe(quantity * PRICE - (reward.freeShipping ? 0 : reward.amount) + shipping);
      expect(money(order.totalAmount)).toBe(quotedTotal(q));
    }
  });

  it('a subtotal exactly on a threshold reaches it; one minor unit below does not', async () => {
    const ctx = await store({ tiers: [{ thresholdAmount: 100000, type: 'fixed', value: 10000 }] });
    expect(rewardOf((await buyNow(ctx, 2)).body.order)).toMatchObject({ amount: 10000 });
    await db.ProductVariant.update({ priceAmount: 49999 }, { where: { id: ctx.variant.id } });
    const below = (await buyNow(ctx, 2)).body.order;
    expect(rewardOf(below)).toBeNull();
    expect(money(below.totalAmount)).toBe(2 * 49999 + FEE);
  });

  it('rounds a percentage half up to the minor unit', async () => {
    const ctx = await store({ tiers: [{ thresholdAmount: 100, type: 'percent', value: 5 }] });
    await db.ProductVariant.update({ priceAmount: 1010 }, { where: { id: ctx.variant.id } });
    expect(money((await buyNow(ctx, 1)).body.order.discountAmount)).toBe(51);
  });

  it('never trusts an amount from the browser', async () => {
    const ctx = await store();
    const res = await buyNow(ctx, 1, { discountAmount: 999999, totalAmount: 1, rewards: { discountAmount: 50000 }, cartRewards: true });
    expect(res.status).toBe(201);
    expect(money(res.body.order.totalAmount)).toBe(PRICE);
  });

  it('thresholds look at the subtotal after a quantity bundle', async () => {
    const ctx = await store();
    const bundle = await ctx.api('post', '/bundles').send({
      name: 'Two for less',
      tiers: [
        { quantity: 1, discountType: 'percentage', discountValue: 0 },
        { quantity: 4, discountType: 'percentage', discountValue: 1000 },
      ],
    });
    expect(bundle.status).toBe(201);
    await ctx.api('put', `/bundles/${bundle.body.bundle.id}/products`).send({ productIds: [ctx.product.id] }).expect(200);
    // 4 × 500 = 2,000, 10% bundle → 1,800: the 10% tier (2,000) is not reached, 5% is.
    const order = (await buyNow(ctx, 4)).body.order;
    expect(money(order.subtotalAmount)).toBe(180000);
    expect(rewardOf(order)).toMatchObject({ rewardType: 'percent', value: 5, amount: 9000 });
  });

  it('a staff order and a store priced in another currency get no reward', async () => {
    const ctx = await store();
    const staffOrder = await ctx.api('post', '/orders').set('Idempotency-Key', key()).send({ items: [{ variantId: ctx.variant.id, quantity: 4 }], contact, shippingAddress: address, paymentMethod: 'cod' });
    expect(staffOrder.status).toBe(201);
    expect(rewardOf(staffOrder.body.order)).toBeNull();

    await db.Workspace.update({ defaultCurrency: 'USD' }, { where: { id: ctx.ws } });
    expect(rewardOf((await buyNow(ctx, 4)).body.order)).toBeNull();
    expect((await quote(ctx, 4)).body.quote.rewards).toBeUndefined();
  });
});

describe('against a code', () => {
  it('not combined: the reward saves more, so the code is left out and not used up', async () => {
    const ctx = await store();
    const code = await coupon(ctx, { code: 'FIFTY', type: 'fixed', value: 5000, usageLimit: 1 });
    const order = (await buyNow(ctx, 3, { discountCode: 'FIFTY' })).body.order;
    expect(rewardOf(order)).toMatchObject({ rewardType: 'percent', amount: 7500 });
    expect(order.discountsSnapshot.some((d) => d.code === 'FIFTY')).toBe(false);
    expect(money(order.discountAmount)).toBe(7500);
    expect(await db.DiscountRedemption.count({ where: { orderId: order.id } })).toBe(0);
    expect((await db.Discount.findByPk(code.id)).usageCount).toBe(0);
  });

  it('not combined: the code saves more, so it stays and the reward is left out', async () => {
    const ctx = await store();
    await coupon(ctx, { code: 'TENOFF', type: 'percentage', value: 1000 });
    const order = (await buyNow(ctx, 3, { discountCode: 'TENOFF' })).body.order;
    expect(rewardOf(order)).toBeNull();
    expect(money(order.discountAmount)).toBe(15000);
    expect(money(order.totalAmount)).toBe(3 * PRICE - 15000 + FEE);
    expect(await db.DiscountRedemption.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('a free-shipping code is worth the fee: a bigger discount tier beats it', async () => {
    const ctx = await store();
    await coupon(ctx, { code: 'SHIPFREE', type: 'free_shipping', value: 0 });
    const order = (await buyNow(ctx, 3, { discountCode: 'SHIPFREE' })).body.order;
    expect(rewardOf(order)).toMatchObject({ rewardType: 'percent', amount: 7500 });
    expect(money(order.shippingAmount)).toBe(FEE);
    expect(order.shippingSnapshot.freeShippingGranted).toBeUndefined();
  });

  it('the store’s automatic discount counts as the code', async () => {
    const ctx = await store();
    // No code: applied by itself (discounts/couponExtras.bestAutomatic).
    await coupon(ctx, { type: 'fixed', value: 2000 });
    const order = (await buyNow(ctx, 4)).body.order;
    expect(rewardOf(order)).toMatchObject({ amount: 20000 });
    expect(money(order.discountAmount)).toBe(20000);
    const q = (await quote(ctx, 4)).body.quote;
    expect(q.automaticDiscount).toBeNull();
    expect(q.rewards.coupon).toMatchObject({ automatic: true, applied: false });
  });

  it('combined: both apply, the code on the subtotal after the reward', async () => {
    const ctx = await store({ allowCouponStacking: true });
    await coupon(ctx, { code: 'TENOFF', type: 'percentage', value: 1000 });
    const { quote: q } = await cartCheckout(ctx, 4, {});
    const order = (await buyNow(ctx, 4, { discountCode: 'TENOFF' })).body.order;
    // 2,000 − 10% reward (200) = 1,800; the code's 10% of that = 180.
    expect(rewardOf(order)).toMatchObject({ amount: 20000 });
    expect(order.discountsSnapshot.find((d) => d.code === 'TENOFF')).toMatchObject({ amount: 18000 });
    expect(money(order.discountAmount)).toBe(38000);
    expect(money(order.totalAmount)).toBe(200000 - 38000 + FEE);
    const redemption = await db.DiscountRedemption.findOne({ where: { orderId: order.id } });
    expect(money(redemption.amountAllocated)).toBe(18000);
    const withCode = (await quote(ctx, 4, { discountCode: 'TENOFF' })).body.quote;
    expect(withCode.rewards).toMatchObject({ discountAmount: 20000, coupon: { applied: true, amount: 18000 } });
    expect(q.rewards.discountAmount).toBe(20000);
  });
});

describe('after the order is placed', () => {
  it('an items edit keeps the reward as given, and the order can be cancelled', async () => {
    const ctx = await store();
    const order = (await buyNow(ctx, 4)).body.order;
    const edited = await ctx.api('put', `/orders/${order.id}/items`).send({ items: [{ variantId: ctx.variant.id, quantity: 5 }] });
    expect(edited.status).toBe(200);
    const after = await db.Order.findByPk(order.id);
    expect(money(after.discountAmount)).toBe(20000);
    expect(money(after.totalAmount)).toBe(5 * PRICE - 20000 + FEE);
    expect(rewardOf(after)).toMatchObject({ amount: 20000 });

    const cancelled = await ctx.api('post', `/orders/${order.id}/cancel`).send({ reason: 'Customer asked' });
    expect(cancelled.status).toBe(200);
    expect((await db.Order.findByPk(order.id)).cancelledAt).not.toBeNull();
  });

  it('a stacked code is worked out after the reward again when the items change', async () => {
    const ctx = await store({ allowCouponStacking: true });
    await coupon(ctx, { code: 'TENOFF', type: 'percentage', value: 1000 });
    const order = (await buyNow(ctx, 4, { discountCode: 'TENOFF' })).body.order;
    await ctx.api('put', `/orders/${order.id}/items`).send({ items: [{ variantId: ctx.variant.id, quantity: 6 }] }).expect(200);
    const after = await db.Order.findByPk(order.id);
    // 3,000 − the reward as given (200) = 2,800; the code's 10% = 280.
    expect(money(after.discountAmount)).toBe(20000 + 28000);
    expect(money(after.totalAmount)).toBe(300000 - 48000 + FEE);
  });

  it('free shipping given by the reward stays free after an edit', async () => {
    const ctx = await store();
    const order = (await buyNow(ctx, 1)).body.order;
    expect(order.shippingSnapshot.freeShippingGranted).toBe(true);
    await ctx.api('put', `/orders/${order.id}/items`).send({ items: [{ variantId: ctx.variant.id, quantity: 2 }] }).expect(200);
    expect(money((await db.Order.findByPk(order.id)).shippingAmount)).toBe(0);
  });
});

describe('an empty cart', () => {
  it('has nothing to price: the checkout refuses it as before', async () => {
    const ctx = await store();
    const cart = await request(app).post(`/api/v1/store/${ctx.ws}/cart`).send({});
    const res = await request(app)
      .post(`/api/v1/store/${ctx.ws}/checkout`)
      .set('X-Cart-Token', cart.body.guestToken)
      .set('Idempotency-Key', key())
      .send({ contact, shippingAddress: address, paymentMethod: 'cod' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('EMPTY_CART');
  });
});

describe('another product in the cart', () => {
  it('counts toward the same thresholds', async () => {
    const ctx = await store();
    const other = await createProductWithVariant(ctx.auth.accessToken, ctx.ws, { price: 150000, stock: 10 });
    const res = await request(app)
      .post(`/api/v1/store/${ctx.ws}/checkout`)
      .set('Idempotency-Key', key())
      .send({ item: { variantId: ctx.variant.id, quantity: 1 }, extraItems: [{ variantId: other.variant.id, quantity: 1 }], contact, shippingAddress: address, paymentMethod: 'cod' });
    expect(res.status).toBe(201);
    expect(rewardOf(res.body.order)).toMatchObject({ rewardType: 'percent', value: 10, amount: 20000 });
  });
});
