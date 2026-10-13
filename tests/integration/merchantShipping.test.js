'use strict';

// Merchant-defined shipping: the store's default rate, per-governorate prices,
// the free-shipping threshold, per-product free shipping / extra fees, the
// default courier — and that the storefront quote is always the number the
// order is then charged, whatever the client sends.

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct, createProductWithVariant, addMemberWithRole, confirmCodOrder } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const key = () => `ship-${crypto.randomUUID()}`;
const contact = { fullName: 'Salma Nabil', phone: '01012345678' };
const address = (province) => ({ country: 'EG', province, city: 'Somewhere', addressLine: '12 Nile Street, floor 3' });
// What the storefront sends for a governorate (storefront lib/orderForm.provinceFor).
const CAIRO = 'القاهرة (Cairo)';
const ASWAN = 'أسوان (Aswan)';

async function setup(opts = {}) {
  const ctx = await setupWorkspaceWithProduct({ price: 10000, stock: 100, ...opts });
  const token = ctx.auth.accessToken;
  const ws = ctx.workspace.id;
  return {
    ...ctx,
    token,
    ws,
    api: (method, path) => request(app)[method](`/api/v1/workspaces/${ws}${path}`).set(bearer(token)),
  };
}

const quote = (ctx, body) => request(app).post(`/api/v1/store/${ctx.ws}/shipping-quote`).send(body);

async function checkout(ctx, items, province, extra = {}) {
  const res = await request(app)
    .post(`/api/v1/store/${ctx.ws}/checkout`)
    .set('Idempotency-Key', key())
    .send({ item: items[0], contact, shippingAddress: address(province), paymentMethod: 'cod', ...extra });
  return res;
}

async function cartCheckout(ctx, items, province) {
  const cart = await request(app).post(`/api/v1/store/${ctx.ws}/cart`).send({});
  const token = cart.body.guestToken;
  for (const item of items) {
    const added = await request(app).post(`/api/v1/store/${ctx.ws}/cart/items`).set('X-Cart-Token', token).send(item);
    if (added.status !== 201) throw new Error(`cart add: ${added.status} ${JSON.stringify(added.body)}`);
  }
  const res = await request(app)
    .post(`/api/v1/store/${ctx.ws}/checkout`)
    .set('X-Cart-Token', token)
    .set('Idempotency-Key', key())
    .send({ contact, shippingAddress: address(province), paymentMethod: 'cod' });
  if (res.status !== 201) throw new Error(`checkout: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

async function saveSettings(ctx, body) {
  const res = await ctx.api('patch', '/shipping/settings').send(body);
  if (res.status !== 200) throw new Error(`settings: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.settings;
}

async function productWithMode(ctx, { price = 10000, mode, extra }) {
  const { product, variant } = await createProductWithVariant(ctx.token, ctx.ws, { price, stock: 100 });
  const res = await ctx.api('patch', `/catalog/products/${product.id}`).send({
    shippingMode: mode,
    ...(extra !== undefined ? { shippingExtraAmount: extra } : {}),
  });
  if (res.status !== 200) throw new Error(`product mode: ${res.status} ${JSON.stringify(res.body)}`);
  return { product: res.body.product, variant };
}

describe('a store that never set shipping', () => {
  it('prices every order at 0 and tells the storefront it is not configured', async () => {
    const ctx = await setup();
    const q = await quote(ctx, { governorate: CAIRO, items: [{ variantId: ctx.variant.id }] });
    expect(q.status).toBe(200);
    expect(q.body.quote).toMatchObject({ amount: 0, configured: false, rule: 'no_rate', freeShipping: null });

    const res = await checkout(ctx, [{ variantId: ctx.variant.id }], CAIRO);
    expect(res.status).toBe(201);
    expect(Number(res.body.order.shippingAmount)).toBe(0);
    expect(Number(res.body.order.totalAmount)).toBe(10000);
  });
});

describe('default rate with governorate overrides', () => {
  it('quotes each governorate and charges the order exactly the quote', async () => {
    const ctx = await setup();
    await saveSettings(ctx, { defaultRateAmount: 6000, governorateRates: { cairo: 4500 } });

    const cairo = (await quote(ctx, { governorate: CAIRO, items: [{ variantId: ctx.variant.id, quantity: 2 }] })).body.quote;
    expect(cairo).toMatchObject({
      amount: 4500,
      rule: 'governorate_rate',
      governorate: 'cairo',
      configured: true,
      destinationRequired: true,
    });
    const aswan = (await quote(ctx, { governorate: ASWAN, items: [{ variantId: ctx.variant.id, quantity: 2 }] })).body.quote;
    expect(aswan).toMatchObject({ amount: 6000, rule: 'default_rate', governorate: null });

    const toCairo = await checkout(ctx, [{ variantId: ctx.variant.id, quantity: 2 }], CAIRO);
    expect(Number(toCairo.body.order.shippingAmount)).toBe(cairo.amount);
    expect(Number(toCairo.body.order.totalAmount)).toBe(20000 + 4500);
    expect(toCairo.body.order.shippingSnapshot).toMatchObject({ rule: 'governorate_rate', governorate: 'cairo', baseAmount: 4500 });

    const toAswan = await checkout(ctx, [{ variantId: ctx.variant.id, quantity: 2 }], ASWAN);
    expect(Number(toAswan.body.order.shippingAmount)).toBe(aswan.amount);
  });

  it('ignores any shipping amount the client sends', async () => {
    const ctx = await setup();
    await saveSettings(ctx, { defaultRateAmount: 6000 });
    const res = await checkout(ctx, [{ variantId: ctx.variant.id }], CAIRO, { shippingAmount: 1, totalAmount: 1 });
    expect(res.status).toBe(201);
    expect(Number(res.body.order.shippingAmount)).toBe(6000);
    expect(Number(res.body.order.totalAmount)).toBe(16000);
  });

  it('matches a governorate typed as a staff order would (English name)', async () => {
    const ctx = await setup();
    await saveSettings(ctx, { defaultRateAmount: 6000, governorateRates: { aswan: 9000 } });
    const res = await ctx
      .api('post', '/orders')
      .set('Idempotency-Key', key())
      .send({ items: [{ variantId: ctx.variant.id, quantity: 1 }], contact, shippingAddress: address('Aswan'), paymentMethod: 'cod' });
    expect(res.status).toBe(201);
    expect(Number(res.body.order.shippingAmount)).toBe(9000);
  });

  it('keeps zones in charge of a governorate the merchant did not override', async () => {
    const ctx = await setup();
    const zone = await ctx.api('post', '/shipping/zones').send({ name: 'Egypt', countries: ['EG'] });
    await ctx.api('post', `/shipping/zones/${zone.body.zone.id}/rates`).send({ name: 'Std', rateType: 'flat', config: { amount: 5500 } });
    await saveSettings(ctx, { governorateRates: { cairo: 3000 } });

    expect((await quote(ctx, { governorate: CAIRO, items: [{ variantId: ctx.variant.id }] })).body.quote).toMatchObject({
      amount: 3000,
      rule: 'governorate_rate',
    });
    expect((await quote(ctx, { governorate: ASWAN, items: [{ variantId: ctx.variant.id }] })).body.quote).toMatchObject({
      amount: 5500,
      rule: 'zone_rate',
    });
  });

  it('does not apply governorate prices while the store prices by weight tier', async () => {
    const ctx = await setup();
    const tiers = await ctx.api('put', '/shipping/weight-tiers').send({ tiers: [{ upToGrams: null }] });
    const zone = await ctx.api('post', '/shipping/zones').send({ name: 'Egypt', countries: ['EG'] });
    await ctx
      .api('put', `/shipping/zones/${zone.body.zone.id}/tier-prices`)
      .send({ prices: [{ tierId: tiers.body.tiers[0].id, amount: 7000 }] });
    await ctx.api('post', '/shipping/pricing-mode').send({ mode: 'weight_tiers', defaultItemWeightGrams: 500, prefill: false });
    await saveSettings(ctx, { governorateRates: { cairo: 1000 } });

    expect((await quote(ctx, { governorate: CAIRO, items: [{ variantId: ctx.variant.id }] })).body.quote).toMatchObject({
      amount: 7000,
      rule: 'zone_tier_price',
    });
  });
});

describe('free-shipping threshold', () => {
  it('reports progress below it and ships free at it, whatever the governorate', async () => {
    const ctx = await setup();
    await saveSettings(ctx, { defaultRateAmount: 6000, freeShippingThresholdAmount: 30000 });

    const below = (await quote(ctx, { governorate: CAIRO, items: [{ variantId: ctx.variant.id, quantity: 2 }] })).body.quote;
    expect(below).toMatchObject({
      amount: 6000,
      freeShipping: { thresholdAmount: 30000, remainingAmount: 10000, qualified: false },
    });

    // No governorate yet: already free, and the storefront may say so.
    const at = (await quote(ctx, { items: [{ variantId: ctx.variant.id, quantity: 3 }] })).body.quote;
    expect(at).toMatchObject({
      amount: 0,
      rule: 'free_threshold',
      destinationRequired: false,
      freeShipping: { remainingAmount: 0, qualified: true },
    });

    const order = await checkout(ctx, [{ variantId: ctx.variant.id, quantity: 3 }], ASWAN);
    expect(Number(order.body.order.shippingAmount)).toBe(0);
    expect(Number(order.body.order.totalAmount)).toBe(30000);
  });
});

describe('product shipping modes in a mixed cart', () => {
  it('adds each extra fee per unit on top of the destination rate; free products change nothing', async () => {
    const ctx = await setup();
    await saveSettings(ctx, { defaultRateAmount: 5000, governorateRates: { cairo: 4000 } });
    const heavy = await productWithMode(ctx, { mode: 'extra_fee', extra: 1500 });
    const light = await productWithMode(ctx, { mode: 'free' });

    const items = [
      { variantId: ctx.variant.id, quantity: 1 },
      { variantId: heavy.variant.id, quantity: 2 },
      { variantId: light.variant.id, quantity: 1 },
    ];
    const q = (await quote(ctx, { governorate: CAIRO, items })).body.quote;
    expect(q).toMatchObject({ amount: 4000 + 2 * 1500, baseAmount: 4000, extraFeesAmount: 3000, rule: 'governorate_rate' });

    const order = await cartCheckout(ctx, items, CAIRO);
    expect(Number(order.shippingAmount)).toBe(q.amount);
    expect(order.shippingSnapshot).toMatchObject({ baseAmount: 4000, extraFeesAmount: 3000 });
  });

  it('ships a cart of only free-shipping products free, before a governorate is known', async () => {
    const ctx = await setup();
    await saveSettings(ctx, { defaultRateAmount: 5000 });
    const a = await productWithMode(ctx, { mode: 'free' });
    const b = await productWithMode(ctx, { mode: 'free' });
    const items = [
      { variantId: a.variant.id, quantity: 1 },
      { variantId: b.variant.id, quantity: 3 },
    ];
    expect((await quote(ctx, { items })).body.quote).toMatchObject({ amount: 0, rule: 'all_items_free', destinationRequired: false });
    const order = await cartCheckout(ctx, items, ASWAN);
    expect(Number(order.shippingAmount)).toBe(0);
  });

  it('lets the threshold waive the extra fees too', async () => {
    const ctx = await setup();
    await saveSettings(ctx, { defaultRateAmount: 5000, freeShippingThresholdAmount: 20000 });
    const heavy = await productWithMode(ctx, { mode: 'extra_fee', extra: 2500 });
    const items = [{ variantId: heavy.variant.id, quantity: 2 }];
    expect((await quote(ctx, { governorate: CAIRO, items })).body.quote).toMatchObject({ amount: 0, rule: 'free_threshold' });
  });

  it('charges extra fees in a store with no rates, and calls that configured', async () => {
    const ctx = await setup();
    const heavy = await productWithMode(ctx, { mode: 'extra_fee', extra: 2000 });
    const q = (await quote(ctx, { governorate: CAIRO, items: [{ variantId: heavy.variant.id, quantity: 1 }] })).body.quote;
    expect(q).toMatchObject({ amount: 2000, configured: true, rule: 'no_rate', extraFeesAmount: 2000 });
  });
});

describe('product shipping fields', () => {
  it('stores a mode with its fee, clears the fee with the mode, and refuses a mismatch', async () => {
    const ctx = await setup();
    const created = await ctx.api('post', '/catalog/products').send({
      name: 'Sofa',
      status: 'active',
      shippingMode: 'extra_fee',
      shippingExtraAmount: 25000,
    });
    expect(created.status).toBe(201);
    expect(created.body.product).toMatchObject({ shippingMode: 'extra_fee' });
    expect(Number(created.body.product.shippingExtraAmount)).toBe(25000);
    const id = created.body.product.id;

    const missing = await ctx.api('post', '/catalog/products').send({ name: 'Bed', shippingMode: 'extra_fee' });
    expect(missing.status).toBe(422);

    const strayAmount = await ctx.api('patch', `/catalog/products/${id}`).send({ shippingMode: 'free', shippingExtraAmount: 100 });
    expect(strayAmount.status).toBe(422);

    const toFree = await ctx.api('patch', `/catalog/products/${id}`).send({ shippingMode: 'free' });
    expect(toFree.status).toBe(200);
    expect(toFree.body.product).toMatchObject({ shippingMode: 'free', shippingExtraAmount: null });

    const plain = await ctx.api('post', '/catalog/products').send({ name: 'Mug' });
    expect(plain.body.product).toMatchObject({ shippingMode: 'standard', shippingExtraAmount: null });
  });
});

describe('GET/PATCH /shipping/settings', () => {
  it('reads and writes the four settings, audited, and clears with null', async () => {
    const ctx = await setup();
    const empty = await ctx.api('get', '/shipping/settings');
    expect(empty.status).toBe(200);
    expect(empty.body.settings).toEqual({
      pricingMode: 'rates',
      defaultRateAmount: null,
      freeShippingThresholdAmount: null,
      governorateRates: {},
      defaultCarrierCode: null,
      // Self delivery's served governorates (deliveryAreas.js): none = everywhere.
      servedGovernorates: [],
      // Store pickup (storePickup.js): off.
      storePickup: { enabled: false, address: '', phone: '', note: '' },
      // Delivery zones inside a city (deliveryZones.js): off.
      deliveryZonesEnabled: false,
      // Opening hours (storeHours.js): off, every day 09:00-23:00 as the form's starting point.
      storeHours: {
        enabled: false,
        override: 'auto',
        days: Array.from({ length: 7 }, () => ({ closed: false, open: '09:00', close: '23:00', periods: [{ open: '09:00', close: '23:00' }] })),
        message: '',
      },
      deliveryEtaMinutes: null,
    });
    expect(empty.body.governorates).toHaveLength(27);

    const saved = await saveSettings(ctx, {
      defaultRateAmount: 6000,
      freeShippingThresholdAmount: 50000,
      governorateRates: { cairo: 4500, giza: 4500 },
      defaultCarrierCode: 'manual',
    });
    expect(saved).toMatchObject({ defaultRateAmount: 6000, governorateRates: { cairo: 4500, giza: 4500 }, defaultCarrierCode: 'manual' });

    // The same keys the older PATCH /workspaces wrote.
    const ws = await db.Workspace.findByPk(ctx.ws);
    expect(ws.settings).toMatchObject({
      default_shipping_rate_amount: 6000,
      free_shipping_threshold_amount: 50000,
      shipping_governorate_rates: { cairo: 4500, giza: 4500 },
      default_carrier_code: 'manual',
    });
    expect(ws.themeSettings || {}).not.toHaveProperty('shipping_governorate_rates');

    const audit = await db.AuditLog.findOne({ where: { workspaceId: ctx.ws, action: 'shipping.settings_update' } });
    expect(audit.afterState.governorateRates).toEqual({ cairo: 4500, giza: 4500 });

    const cleared = await saveSettings(ctx, { freeShippingThresholdAmount: null, governorateRates: {} });
    expect(cleared).toMatchObject({ defaultRateAmount: 6000, freeShippingThresholdAmount: null, governorateRates: {} });
    const after = await db.Workspace.findByPk(ctx.ws);
    expect(after.settings).not.toHaveProperty('shipping_governorate_rates');
    expect(after.settings).not.toHaveProperty('free_shipping_threshold_amount');
  });

  it('refuses an unknown governorate, a negative price and a courier the store cannot use', async () => {
    const ctx = await setup();
    const typo = await ctx.api('patch', '/shipping/settings').send({ governorateRates: { kairo: 4500 } });
    expect(typo.status).toBe(422);
    const negative = await ctx.api('patch', '/shipping/settings').send({ defaultRateAmount: -1 });
    expect(negative.status).toBe(422);
    const courier = await ctx.api('patch', '/shipping/settings').send({ defaultCarrierCode: 'dhl' });
    expect(courier.status).toBe(422);
    expect(courier.body.error.details[0].field).toBe('defaultCarrierCode');
  });

  it('needs shipping.manage', async () => {
    const ctx = await setup();
    const editor = await addMemberWithRole(ctx.token, ctx.ws, 'editor');
    const denied = await request(app)
      .patch(`/api/v1/workspaces/${ctx.ws}/shipping/settings`)
      .set(bearer(editor.accessToken))
      .send({ defaultRateAmount: 1 });
    expect(denied.status).toBe(403);

    const operator = await addMemberWithRole(ctx.token, ctx.ws, 'order_operator', 'Operator');
    const allowed = await request(app)
      .patch(`/api/v1/workspaces/${ctx.ws}/shipping/settings`)
      .set(bearer(operator.accessToken))
      .send({ defaultRateAmount: 1 });
    expect(allowed.status).toBe(200);
  });

  it('the store settings PATCH needs shipping.manage for the same keys', async () => {
    const ctx = await setup();
    await saveSettings(ctx, { defaultRateAmount: 6000 });
    const editor = await addMemberWithRole(ctx.token, ctx.ws, 'editor');
    const asEditor = (body) => request(app).patch(`/api/v1/workspaces/${ctx.ws}`).set(bearer(editor.accessToken)).send(body);

    // Each of the three keys, a null included, and whatever else the request carries.
    for (const body of [
      { settings: { free_shipping_threshold_amount: 0 } },
      { settings: { default_shipping_rate_amount: 0 } },
      { settings: { default_item_weight_grams: 1 } },
      { settings: { free_shipping_threshold_amount: null } },
      { tagline: 'Slipped in', settings: { default_shipping_rate_amount: 1 } },
    ]) {
      const denied = await asEditor(body);
      expect(denied.status).toBe(403);
    }
    const row = await db.Workspace.findByPk(ctx.ws);
    expect(row.settings.default_shipping_rate_amount).toBe(6000);
    expect(row.settings).not.toHaveProperty('free_shipping_threshold_amount');
    // The whole request is refused, not only its shipping part.
    expect(row.tagline).not.toBe('Slipped in');
    // The next order is still charged the configured rate.
    const placed = await checkout(ctx, [{ variantId: ctx.variant.id }], CAIRO);
    expect(Number(placed.body.order.shippingAmount)).toBe(6000);

    // The rest of that PATCH is still an Editor's.
    expect((await asEditor({ tagline: 'New tagline' })).status).toBe(200);

    // A role that holds shipping.manage reaches these keys through the endpoint that asks for it.
    const operator = await addMemberWithRole(ctx.token, ctx.ws, 'order_operator', 'Operator');
    const viaShipping = await request(app)
      .patch(`/api/v1/workspaces/${ctx.ws}/shipping/settings`)
      .set(bearer(operator.accessToken))
      .send({ defaultRateAmount: 7000 });
    expect(viaShipping.status).toBe(200);
    // And the owner through either.
    expect((await ctx.api('patch', '').send({ settings: { default_shipping_rate_amount: 5000 } })).status).toBe(200);
  });
});

describe('carrier at fulfilment', () => {
  it('books with any courier without touching what the customer was charged', async () => {
    const ctx = await setup();
    await saveSettings(ctx, { defaultRateAmount: 6000, defaultCarrierCode: 'manual' });
    const placed = await checkout(ctx, [{ variantId: ctx.variant.id }], CAIRO);
    const order = placed.body.order;
    await confirmCodOrder(ctx.token, ctx.ws, order.id);

    const shipped = await ctx.api('post', `/orders/${order.id}/shipments`).send({ carrierCode: 'Aramex local', waybillNumber: 'AR-1' });
    expect(shipped.status).toBe(201);
    const reloaded = await db.Order.findByPk(order.id);
    expect(Number(reloaded.shippingAmount)).toBe(6000);
    expect(Number(reloaded.totalAmount)).toBe(16000);
  });
});
