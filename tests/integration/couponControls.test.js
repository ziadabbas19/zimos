'use strict';

// The merchant's controls on a coupon (migration 730, discounts/discountRules.js):
// each one alone, the combinations that matter, offers, the limits under a
// race, the report, and coupons made before them still behaving as before.

const { app, request, setupWorkspaceWithProduct, createProductWithVariant } = require('../helpers/factories');
const db = require('../../src/db/models');
const rules = require('../../src/modules/discounts/discountRules');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const key = () => `cc-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function twoProducts() {
  const ctx = await setupWorkspaceWithProduct({ price: 1000, stock: 100 });
  const b = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id, { price: 2000, stock: 100 });
  return { ...ctx, a: { product: ctx.product, variant: ctx.variant }, b };
}

async function coupon(ctx, body) {
  const res = await request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/discounts`).set(bearer(ctx.auth.accessToken)).send(body);
  if (res.status !== 201) throw new Error(`discount: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.discount;
}

function order(ctx, lines, discountCode, { phone = '01012340000', email } = {}) {
  return request(app)
    .post(`/api/v1/workspaces/${ctx.workspace.id}/orders`)
    .set(bearer(ctx.auth.accessToken))
    .set('Idempotency-Key', key())
    .send({
      items: lines.map((line) => (line.variantId ? line : { variantId: line.id, quantity: 1 })),
      contact: { fullName: 'Coupon Buyer', phone, ...(email ? { email } : {}) },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Code St' },
      paymentMethod: 'cod',
      ...(discountCode ? { discountCode } : {}),
    });
}

function storeCheckout(ctx, variant, discountCode, { phone, deviceId }) {
  return request(app)
    .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
    .set('Idempotency-Key', key())
    .send({
      item: { variantId: variant.id, quantity: 1 },
      contact: { fullName: 'Shop Buyer', phone },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '2 Shop St' },
      paymentMethod: 'cod',
      discountCode,
      deviceId,
    });
}

const refusal = (res) => res.body && res.body.error && res.body.error.code;

describe('who may use it', () => {
  it('first order only: a phone with an order is refused, a cancelled order does not count', async () => {
    const ctx = await twoProducts();
    await coupon(ctx, { code: 'WELCOME', type: 'percentage', value: 1000, audience: 'new' });

    const first = await order(ctx, [ctx.a.variant], 'WELCOME', { phone: '01011110001' });
    expect(first.status).toBe(201);
    expect(Number(first.body.order.discountAmount)).toBe(100);

    const again = await order(ctx, [ctx.a.variant], 'WELCOME', { phone: '01011110001' });
    expect(again.status).toBe(422);
    expect(refusal(again)).toBe('DISCOUNT_FIRST_ORDER_ONLY');

    // A phone whose only order was cancelled is still new.
    const placed = await order(ctx, [ctx.a.variant], null, { phone: '01011110002' });
    await request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${placed.body.order.id}/cancel`).set(bearer(ctx.auth.accessToken)).send({ reason: 'test' }).expect(200);
    expect((await order(ctx, [ctx.a.variant], 'WELCOME', { phone: '01011110002' })).status).toBe(201);
  });

  it('returning customers only', async () => {
    const ctx = await twoProducts();
    await coupon(ctx, { code: 'THANKS', type: 'fixed', value: 200, audience: 'existing' });
    const fresh = await order(ctx, [ctx.a.variant], 'THANKS', { phone: '01022220001' });
    expect(refusal(fresh)).toBe('DISCOUNT_RETURNING_ONLY');
    await order(ctx, [ctx.a.variant], null, { phone: '01022220001' });
    expect((await order(ctx, [ctx.a.variant], 'THANKS', { phone: '01022220001' })).status).toBe(201);
  });

  it('a list of phones, typed in any form', async () => {
    const ctx = await twoProducts();
    const made = await coupon(ctx, { code: 'VIPS', type: 'fixed', value: 100, customerPhones: ['01033330001', '+20 103 333 0002'] });
    expect(made.customerPhones).toEqual(['201033330001', '201033330002']);
    expect(refusal(await order(ctx, [ctx.a.variant], 'VIPS', { phone: '01033330009' }))).toBe('DISCOUNT_NOT_ELIGIBLE');
    expect((await order(ctx, [ctx.a.variant], 'VIPS', { phone: '01033330002' })).status).toBe(201);
  });
});

describe('when it works', () => {
  it('outside its weekly hours it is refused and says so; inside it works', async () => {
    const ctx = await twoProducts();
    const { weekday } = (() => {
      const p = require('../../src/core/utils/zonedMonth').zonedParts(new Date(), 'Africa/Cairo');
      return { weekday: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() };
    })();
    const otherDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== weekday);
    await coupon(ctx, { code: 'WEEKEND', type: 'fixed', value: 100, schedule: { days: otherDays, startMinute: 0, endMinute: 1440 } });
    await coupon(ctx, { code: 'TODAY', type: 'fixed', value: 100, schedule: { days: [weekday], startMinute: 0, endMinute: 1440 } });
    expect(refusal(await order(ctx, [ctx.a.variant], 'WEEKEND'))).toBe('DISCOUNT_NOT_ACTIVE_NOW');
    expect((await order(ctx, [ctx.a.variant], 'TODAY')).status).toBe(201);
  });

  it('a window past midnight belongs to the day it starts', () => {
    // Friday 23:30 and Saturday 01:00 Cairo (UTC+2 or +3): both inside "Friday 22:00-02:00".
    const schedule = { days: [5], startMinute: 22 * 60, endMinute: 2 * 60 };
    expect(rules.scheduleOpen(schedule, new Date('2026-10-30T20:30:00Z'))).toBe(true);
    expect(rules.scheduleOpen(schedule, new Date('2026-10-30T22:30:00Z'))).toBe(true);
    expect(rules.scheduleOpen(schedule, new Date('2026-10-31T10:00:00Z'))).toBe(false);
    expect(rules.scheduleOpen(null, new Date())).toBe(true);
  });

  it('a paused coupon says it is paused', async () => {
    const ctx = await twoProducts();
    await coupon(ctx, { code: 'PAUSED', type: 'fixed', value: 100, status: 'disabled' });
    expect(refusal(await order(ctx, [ctx.a.variant], 'PAUSED'))).toBe('DISCOUNT_DISABLED');
  });
});

describe('on what', () => {
  it('a percentage stops at its cap', async () => {
    const ctx = await twoProducts();
    await coupon(ctx, { code: 'HALF', type: 'percentage', value: 5000, maxDiscountAmount: 600 });
    const res = await order(ctx, [ctx.a.variant, ctx.b.variant], 'HALF');
    expect(Number(res.body.order.discountAmount)).toBe(600);
  });

  it('a minimum number of pieces', async () => {
    const ctx = await twoProducts();
    await coupon(ctx, { code: 'TWOPLUS', type: 'fixed', value: 100, minQuantity: 2 });
    const one = await order(ctx, [ctx.a.variant], 'TWOPLUS');
    expect(refusal(one)).toBe('DISCOUNT_MIN_QUANTITY_NOT_MET');
    expect(one.body.error.details[0]).toMatchObject({ minQuantity: 2, quantity: 1, remainingQuantity: 1 });
    expect((await order(ctx, [{ variantId: ctx.a.variant.id, quantity: 2 }], 'TWOPLUS')).status).toBe(201);
  });

  it('an excluded product is never discounted', async () => {
    const ctx = await twoProducts();
    await coupon(ctx, { code: 'NOTB', type: 'percentage', value: 1000, excludedProductIds: [ctx.b.product.id] });
    const both = await order(ctx, [ctx.a.variant, ctx.b.variant], 'NOTB');
    expect(Number(both.body.order.discountAmount)).toBe(100);
    expect(refusal(await order(ctx, [ctx.b.variant], 'NOTB'))).toBe('DISCOUNT_NOT_APPLICABLE');
  });

  it('items already on sale can be left out', async () => {
    const ctx = await twoProducts();
    await db.ProductVariant.update({ compareAtAmount: 3000 }, { where: { id: ctx.b.variant.id } });
    await coupon(ctx, { code: 'FULLPRICE', type: 'percentage', value: 1000, appliesToDiscounted: false });
    await coupon(ctx, { code: 'ANYPRICE', type: 'percentage', value: 1000 });
    expect(Number((await order(ctx, [ctx.a.variant, ctx.b.variant], 'FULLPRICE')).body.order.discountAmount)).toBe(100);
    expect(Number((await order(ctx, [ctx.a.variant, ctx.b.variant], 'ANYPRICE')).body.order.discountAmount)).toBe(300);
    expect(refusal(await order(ctx, [ctx.b.variant], 'FULLPRICE'))).toBe('DISCOUNT_NOT_COMBINABLE');
  });

  it('offers can be left out: the coupon takes nothing off an offer line', async () => {
    const ctx = await twoProducts();
    const offer = await db.Offer.create({ workspaceId: ctx.workspace.id, productId: ctx.b.product.id, name: 'Two B', priceAmount: 3500, currency: 'EGP' });
    await db.OfferVariant.create({ offerId: offer.id, variantId: ctx.b.variant.id, quantity: 2 });
    await coupon(ctx, { code: 'NOOFFERS', type: 'percentage', value: 1000, combinesWithOffers: false });
    const res = await order(ctx, [{ variantId: ctx.a.variant.id, quantity: 1 }, { variantId: ctx.b.variant.id, offerId: offer.id, quantity: 1 }], 'NOOFFERS');
    expect(res.status).toBe(201);
    expect(Number(res.body.order.discountAmount)).toBe(100);
    const offerOnly = await order(ctx, [{ variantId: ctx.b.variant.id, offerId: offer.id, quantity: 1 }], 'NOOFFERS');
    expect(refusal(offerOnly)).toBe('DISCOUNT_NOT_COMBINABLE');
  });

  it('on the delivery fee too, when it says so', async () => {
    const ctx = await twoProducts();
    await request(app).patch(`/api/v1/workspaces/${ctx.workspace.id}`).set(bearer(ctx.auth.accessToken)).send({ settings: { default_shipping_rate_amount: 500 } }).expect(200);
    await coupon(ctx, { code: 'ALLIN', type: 'fixed', value: 1300, appliesToShipping: true });
    await coupon(ctx, { code: 'ITEMS', type: 'fixed', value: 1300 });
    const all = await order(ctx, [ctx.a.variant], 'ALLIN');
    expect(Number(all.body.order.shippingAmount)).toBe(500);
    expect(Number(all.body.order.discountAmount)).toBe(1300); // 1000 off the items, 300 off the fee
    expect(Number(all.body.order.totalAmount)).toBe(200);
    const snapshot = all.body.order.discountsSnapshot.find((d) => d.code === 'ALLIN');
    expect(snapshot).toMatchObject({ amount: 1000, shippingAmount: 300 });
    const items = await order(ctx, [ctx.a.variant], 'ITEMS');
    expect(Number(items.body.order.discountAmount)).toBe(1000);
  });

  it('first order + a minimum + a collection, together', async () => {
    const ctx = await twoProducts();
    const collection = await db.Collection.create({ workspaceId: ctx.workspace.id, name: 'New in', slug: `new-${Date.now()}` });
    await db.ProductCollection.create({ productId: ctx.b.product.id, collectionId: collection.id });
    await coupon(ctx, { code: 'STARTER', type: 'percentage', value: 2000, audience: 'new', minimumSubtotal: 2500, collectionRestrictions: [collection.id] });

    expect(refusal(await order(ctx, [ctx.b.variant], 'STARTER', { phone: '01044440001' }))).toBe('DISCOUNT_MINIMUM_NOT_MET');
    expect(refusal(await order(ctx, [{ variantId: ctx.a.variant.id, quantity: 3 }], 'STARTER', { phone: '01044440001' }))).toBe('DISCOUNT_NOT_APPLICABLE');
    const ok = await order(ctx, [ctx.a.variant, ctx.b.variant], 'STARTER', { phone: '01044440001' });
    expect(ok.status).toBe(201);
    expect(Number(ok.body.order.discountAmount)).toBe(400); // 20% of B only
    expect(refusal(await order(ctx, [ctx.a.variant, ctx.b.variant], 'STARTER', { phone: '01044440001' }))).toBe('DISCOUNT_FIRST_ORDER_ONLY');
  });

  it('an automatic discount follows the same rules, silently', async () => {
    const ctx = await twoProducts();
    await db.Discount.create({ workspaceId: ctx.workspace.id, code: null, type: 'fixed', value: 150, status: 'active', audience: 'new' });
    expect(Number((await order(ctx, [ctx.a.variant], null, { phone: '01055550001' })).body.order.discountAmount)).toBe(150);
    expect(Number((await order(ctx, [ctx.a.variant], null, { phone: '01055550001' })).body.order.discountAmount)).toBe(0);
  });
});

describe('how often', () => {
  it('the first N orders, then the code is used up', async () => {
    const ctx = await twoProducts();
    await coupon(ctx, { code: 'FIRST2', type: 'fixed', value: 100, usageLimit: 2 });
    expect((await order(ctx, [ctx.a.variant], 'FIRST2', { phone: '01066660001' })).status).toBe(201);
    expect((await order(ctx, [ctx.a.variant], 'FIRST2', { phone: '01066660002' })).status).toBe(201);
    expect(refusal(await order(ctx, [ctx.a.variant], 'FIRST2', { phone: '01066660003' }))).toBe('DISCOUNT_USAGE_LIMIT_REACHED');
  });

  it('strict per-customer limit: the same e-mail or device under another phone is refused', async () => {
    const ctx = await twoProducts();
    await coupon(ctx, { code: 'ONCEEACH', type: 'fixed', value: 100, perCustomerLimit: 1, strictCustomerLimit: true });
    await coupon(ctx, { code: 'LOOSE', type: 'fixed', value: 100, perCustomerLimit: 1 });

    expect((await order(ctx, [ctx.a.variant], 'ONCEEACH', { phone: '01077770001', email: 'same@example.com' })).status).toBe(201);
    expect(refusal(await order(ctx, [ctx.a.variant], 'ONCEEACH', { phone: '01077770002', email: 'Same@Example.com' }))).toBe('DISCOUNT_PER_CUSTOMER_LIMIT_REACHED');

    expect((await storeCheckout(ctx, ctx.a.variant, 'ONCEEACH', { phone: '01077770003', deviceId: 'device-strict-0001' })).status).toBe(201);
    expect(refusal(await storeCheckout(ctx, ctx.a.variant, 'ONCEEACH', { phone: '01077770004', deviceId: 'device-strict-0001' }))).toBe('DISCOUNT_PER_CUSTOMER_LIMIT_REACHED');

    // Not strict (every coupon made before): another phone is another customer, as before.
    expect((await order(ctx, [ctx.a.variant], 'LOOSE', { phone: '01077770001', email: 'same@example.com' })).status).toBe(201);
    expect((await order(ctx, [ctx.a.variant], 'LOOSE', { phone: '01077770002', email: 'same@example.com' })).status).toBe(201);
  });

  it('two orders racing for one customer\'s last use: one wins', async () => {
    const ctx = await twoProducts();
    await coupon(ctx, { code: 'RACE1', type: 'fixed', value: 100, perCustomerLimit: 1 });
    await order(ctx, [ctx.a.variant], null, { phone: '01088880001' });
    const results = await Promise.all([0, 1, 2].map(() => order(ctx, [ctx.a.variant], 'RACE1', { phone: '01088880001' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 422).every((r) => refusal(r) === 'DISCOUNT_PER_CUSTOMER_LIMIT_REACHED')).toBe(true);
  });

  it("two first orders racing under one phone: one gets the first-order code", async () => {
    const ctx = await twoProducts();
    await coupon(ctx, { code: 'NEWRACE', type: 'fixed', value: 100, audience: 'new' });
    // The customer row exists before the race, as it does for a returning visitor's form.
    await db.Customer.create({ workspaceId: ctx.workspace.id, fullName: 'Racer', phoneRaw: '01099990001', phoneNormalized: '201099990001' });
    const results = await Promise.all([0, 1, 2].map(() => order(ctx, [ctx.a.variant], 'NEWRACE', { phone: '01099990001' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 201).every((r) => refusal(r) === 'DISCOUNT_FIRST_ORDER_ONLY')).toBe(true);
  });
});

describe('records', () => {
  it('an order keeps the coupon as it was: a later change does not reprice it', async () => {
    const ctx = await twoProducts();
    const made = await coupon(ctx, { code: 'FROZEN', type: 'percentage', value: 1000 });
    const res = await order(ctx, [ctx.a.variant], 'FROZEN');
    const stored = await db.Order.findByPk(res.body.order.id);
    expect(stored.discountsSnapshot[0].rules).toMatchObject({ type: 'percentage', value: 1000 });

    await request(app).patch(`/api/v1/workspaces/${ctx.workspace.id}/discounts/${made.id}`).set(bearer(ctx.auth.accessToken)).send({ value: 9000 }).expect(200);
    const live = await db.Discount.findByPk(made.id);
    const asPlaced = rules.asPlaced(live, stored.discountsSnapshot);
    expect(Number(asPlaced.value)).toBe(1000);
    const { amountForLines } = require('../../src/modules/discounts/discountService');
    expect(await amountForLines(asPlaced, [{ productId: ctx.a.product.id, lineTotalAmount: 2000, quantity: 2 }])).toBe(200);
  });

  it('the report: uses, discount given, revenue, who used it, and its CSV', async () => {
    const ctx = await twoProducts();
    const made = await coupon(ctx, { code: 'REPORTME', type: 'fixed', value: 100 });
    await order(ctx, [ctx.a.variant], 'REPORTME', { phone: '01012121212' });
    await order(ctx, [ctx.b.variant], 'REPORTME', { phone: '01013131313' });
    const res = await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/discounts/${made.id}/report`).set(bearer(ctx.auth.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.report.summary).toMatchObject({ uses: 2, discountGiven: 200, customers: 2 });
    expect(res.body.report.summary.revenue).toBe(900 + 1900);
    expect(res.body.report.uses[0]).toMatchObject({ customerName: 'Coupon Buyer', discountAmount: 100 });

    const csv = await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/discounts/${made.id}/report.csv`).set(bearer(ctx.auth.accessToken));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n').filter(Boolean)).toHaveLength(3);
  });

  it('a coupon made without the new settings behaves as before', async () => {
    const ctx = await twoProducts();
    const old = await db.Discount.create({ workspaceId: ctx.workspace.id, code: 'OLDONE', type: 'percentage', value: 1000, status: 'active', perCustomerLimit: 1 });
    expect(old).toMatchObject({ audience: 'any', appliesToShipping: false, appliesToDiscounted: true, combinesWithOffers: true, strictCustomerLimit: false, schedule: null });
    await db.ProductVariant.update({ compareAtAmount: 3000 }, { where: { id: ctx.b.variant.id } });
    const res = await order(ctx, [ctx.a.variant, ctx.b.variant], 'OLDONE', { phone: '01015151515' });
    expect(Number(res.body.order.discountAmount)).toBe(300);
    expect(refusal(await order(ctx, [ctx.a.variant], 'OLDONE', { phone: '01015151515' }))).toBe('DISCOUNT_PER_CUSTOMER_LIMIT_REACHED');
  });
});
