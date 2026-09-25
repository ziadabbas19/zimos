'use strict';

// Variant weights, workspace weight tiers, zone × tier prices, the pricing
// mode switch, order weight snapshots, the public shipping quote and the
// Bosta tier → package mapping. Bosta is a fake behind carrierHttp.request.

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct, confirmCodOrder } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const carrierHttp = require('../../src/modules/shipping/carriers/carrierHttp');
const accounts = require('../../src/modules/shipping/carrierAccountService');
const { calculateShippingAmount } = require('../../src/modules/shipping/shippingPricing');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
let seq = 0;
const nextKey = () => `tiers-${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2)}`;

const ADDRESS = { country: 'EG', province: 'Cairo', city: 'Nasr City', addressLine: '12 Abbas El Akkad Street' };

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

const setWeight = (ctx, variantId, weightGrams) => ctx.api('patch', `/catalog/variants/${variantId}`).send({ weightGrams });

async function putTiers(ctx, tiers) {
  const res = await ctx.api('put', '/shipping/weight-tiers').send({ tiers });
  if (res.status !== 200) throw new Error(`putTiers: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.tiers;
}

async function makeZone(ctx, over = {}) {
  const res = await ctx.api('post', '/shipping/zones').send({ name: 'Egypt', countries: ['EG'], ...over });
  return res.body.zone;
}

async function placeOrder(ctx, items, { address = ADDRESS } = {}) {
  const res = await ctx
    .api('post', '/orders')
    .set('Idempotency-Key', nextKey())
    .send({
      items,
      contact: { fullName: 'Mona Adel Hassan', phone: '+201012345678' },
      shippingAddress: address,
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`placeOrder: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

/** Tiers 0–1 kg, 1–3 kg, 3–5 kg; one zone priced 3000/5000/8000; tier mode on. */
async function tierStore(opts = {}) {
  const ctx = await setup(opts);
  const tiers = await putTiers(ctx, [{ upToGrams: 1000 }, { upToGrams: 3000 }, { upToGrams: 5000 }]);
  const zone = await makeZone(ctx);
  await ctx
    .api('put', `/shipping/zones/${zone.id}/tier-prices`)
    .send({ prices: tiers.map((t, i) => ({ tierId: t.id, amount: [3000, 5000, 8000][i] })) });
  const mode = await ctx.api('post', '/shipping/pricing-mode').send({ mode: 'weight_tiers', defaultItemWeightGrams: 500, prefill: false });
  if (mode.status !== 200) throw new Error(`mode: ${mode.status} ${JSON.stringify(mode.body)}`);
  return { ...ctx, tiers, zone };
}

// --- catalog ------------------------------------------------------------------

describe('catalog: variant weight and dimensions', () => {
  it('accepts weight and dimensions on product create and on variant update, and clears weight with null', async () => {
    const ctx = await setup();
    const created = await ctx.api('post', '/catalog/products').send({
      name: 'Kettle',
      status: 'active',
      variant: { priceAmount: 50000, weightGrams: 1800, dimensions: { lengthCm: 30, widthCm: 20, heightCm: 25 } },
    });
    expect(created.status).toBe(201);
    expect(created.body.variant.weightGrams).toBe(1800);
    expect(created.body.variant.dimensions).toEqual({ lengthCm: 30, widthCm: 20, heightCm: 25 });

    const updated = await setWeight(ctx, ctx.variant.id, 750);
    expect(updated.status).toBe(200);
    expect(updated.body.variant.weightGrams).toBe(750);

    const cleared = await setWeight(ctx, ctx.variant.id, null);
    expect(cleared.body.variant.weightGrams).toBeNull();
  });

  it('refuses negative or absurd weights and partial dimensions', async () => {
    const ctx = await setup();
    expect((await setWeight(ctx, ctx.variant.id, -1)).status).toBe(422);
    expect((await setWeight(ctx, ctx.variant.id, 1000001)).status).toBe(422);
    const partial = await ctx.api('patch', `/catalog/variants/${ctx.variant.id}`).send({ dimensions: { lengthCm: 10 } });
    expect(partial.status).toBe(422);
  });
});

// --- tiers and prices --------------------------------------------------------

describe('weight tiers endpoints', () => {
  it('replaces the set, keeps submitted ids, and deletes the prices of removed tiers', async () => {
    const ctx = await setup();
    const first = await putTiers(ctx, [{ upToGrams: 1000 }, { upToGrams: 3000 }, { upToGrams: null }]);
    expect(first.map((t) => [t.fromGrams, t.upToGrams])).toEqual([[0, 1000], [1000, 3000], [3000, null]]);

    const zone = await makeZone(ctx);
    await ctx.api('put', `/shipping/zones/${zone.id}/tier-prices`).send({
      prices: first.map((t) => ({ tierId: t.id, amount: 1000 })),
    });

    // keep tier 0 (re-bounded), drop tier 1, keep the open tier, add nothing new
    const second = await putTiers(ctx, [{ id: first[0].id, upToGrams: 2000 }, { id: first[2].id, upToGrams: null }]);
    expect(second.map((t) => t.id)).toEqual([first[0].id, first[2].id]);
    expect(second[0].upToGrams).toBe(2000);

    const prices = await ctx.api('get', `/shipping/zones/${zone.id}/tier-prices`);
    expect(prices.body.prices.map((p) => p.tierId).sort()).toEqual([first[0].id, first[2].id].sort());

    const all = await ctx.api('get', '/shipping/weight-tiers');
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ pricingMode: 'rates', defaultItemWeightGrams: null, variantsWithoutWeight: 1 });
    expect(all.body.tiers).toHaveLength(2);
    expect(all.body.prices).toHaveLength(2);
  });

  it('refuses invalid tier sets', async () => {
    const ctx = await setup();
    const put = (tiers) => ctx.api('put', '/shipping/weight-tiers').send({ tiers });
    expect((await put([])).status).toBe(422);
    expect((await put([{ upToGrams: 1000 }, { upToGrams: 1000 }])).status).toBe(422);
    expect((await put([{ upToGrams: null }, { upToGrams: 1000 }])).status).toBe(422);
    expect((await put(Array.from({ length: 21 }, (_, i) => ({ upToGrams: (i + 1) * 10 })))).status).toBe(422);

    const other = await setup();
    const [foreign] = await putTiers(other, [{ upToGrams: 500 }]);
    const res = await put([{ id: foreign.id, upToGrams: 500 }]);
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].field).toBe('tiers.0.id');
  });

  it('refuses tier prices for another store\'s tier, a tier priced twice, and another store\'s zone', async () => {
    const ctx = await setup();
    const [tier] = await putTiers(ctx, [{ upToGrams: 1000 }]);
    const zone = await makeZone(ctx);
    const other = await setup();
    const [foreignTier] = await putTiers(other, [{ upToGrams: 1000 }]);
    const foreignZone = await makeZone(other);

    const put = (zoneId, prices) => ctx.api('put', `/shipping/zones/${zoneId}/tier-prices`).send({ prices });
    expect((await put(zone.id, [{ tierId: foreignTier.id, amount: 100 }])).status).toBe(422);
    expect((await put(zone.id, [{ tierId: tier.id, amount: 100 }, { tierId: tier.id, amount: 200 }])).status).toBe(422);
    expect((await put(foreignZone.id, [{ tierId: tier.id, amount: 100 }])).status).toBe(404);
    expect((await put(zone.id, [{ tierId: tier.id, amount: -1 }])).status).toBe(422);
  });
});

// --- pricing mode ---------------------------------------------------------------

describe('pricing mode switch', () => {
  it('needs tiers, then a default item weight', async () => {
    const ctx = await setup();
    const noTiers = await ctx.api('post', '/shipping/pricing-mode').send({ mode: 'weight_tiers' });
    expect(noTiers.status).toBe(422);
    expect(noTiers.body.error.code).toBe('SHIPPING_TIERS_REQUIRED');

    await putTiers(ctx, [{ upToGrams: 1000 }]);
    const noDefault = await ctx.api('post', '/shipping/pricing-mode').send({ mode: 'weight_tiers' });
    expect(noDefault.status).toBe(422);
    expect(noDefault.body.error.code).toBe('DEFAULT_ITEM_WEIGHT_REQUIRED');

    const ok = await ctx.api('post', '/shipping/pricing-mode').send({ mode: 'weight_tiers', defaultItemWeightGrams: 400 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ pricingMode: 'weight_tiers', defaultItemWeightGrams: 400 });

    const ws = await db.Workspace.findByPk(ctx.ws);
    expect(ws.settings).toMatchObject({ shipping_pricing_mode: 'weight_tiers', default_item_weight_grams: 400 });
  });

  it('pre-fills empty cells from the current rates, never overwriting a price, and dry-runs without writing', async () => {
    const ctx = await setup();
    const tiers = await putTiers(ctx, [{ upToGrams: 1000 }, { upToGrams: 3000 }, { upToGrams: null }]);
    const weightZone = await makeZone(ctx, { name: 'Weight zone' });
    await ctx.api('post', `/shipping/zones/${weightZone.id}/rates`).send({
      name: 'By weight',
      rateType: 'weight_based',
      config: { tiers: [{ upToGrams: 1000, amount: 2500 }, { upToGrams: 3000, amount: 4000 }], overflowAmount: 9000 },
    });
    const flatZone = await makeZone(ctx, { name: 'Flat zone', countries: ['SA'] });
    await ctx.api('post', `/shipping/zones/${flatZone.id}/rates`).send({ name: 'Flat', rateType: 'flat', config: { amount: 6000 } });
    const bareZone = await makeZone(ctx, { name: 'No rates', countries: ['AE'] });

    // a price the merchant already set must survive the pre-fill
    await ctx.api('put', `/shipping/zones/${flatZone.id}/tier-prices`).send({ prices: [{ tierId: tiers[0].id, amount: 111 }] });

    const dry = await ctx.api('post', '/shipping/pricing-mode').send({ mode: 'weight_tiers', dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.pricingMode).toBe('rates');
    const cell = (list, zoneId, tierId) => list.find((p) => p.zoneId === zoneId && p.tierId === tierId);
    expect(cell(dry.body.proposals, weightZone.id, tiers[0].id)).toMatchObject({ amount: 2500, basis: 'rates' });
    expect(cell(dry.body.proposals, weightZone.id, tiers[1].id).amount).toBe(4000);
    // open tier priced just above 3 kg -> the weight rate's overflow
    expect(cell(dry.body.proposals, weightZone.id, tiers[2].id).amount).toBe(9000);
    expect(cell(dry.body.proposals, flatZone.id, tiers[0].id)).toBeUndefined();
    expect(cell(dry.body.proposals, flatZone.id, tiers[1].id).amount).toBe(6000);
    // no rates and no default rate -> nothing to propose
    expect(dry.body.proposals.filter((p) => p.zoneId === bareZone.id)).toEqual([]);
    expect(await db.ShippingZoneTierPrice.count({ where: { workspaceId: ctx.ws } })).toBe(1);

    const real = await ctx.api('post', '/shipping/pricing-mode').send({ mode: 'weight_tiers', defaultItemWeightGrams: 500 });
    expect(real.status).toBe(200);
    expect(real.body.prefilled).toHaveLength(5);
    const flatPrices = await ctx.api('get', `/shipping/zones/${flatZone.id}/tier-prices`);
    expect(flatPrices.body.prices.find((p) => p.tierId === tiers[0].id).amount).toBe(111);

    const back = await ctx.api('post', '/shipping/pricing-mode').send({ mode: 'rates' });
    expect(back.status).toBe(200);
    expect(back.body.pricingMode).toBe('rates');
    expect(await db.ShippingZoneTierPrice.count({ where: { workspaceId: ctx.ws } })).toBe(6);
  });

  it('refuses clearing the default item weight while tier pricing is on, allows it in rates mode', async () => {
    const ctx = await tierStore();
    const clear = () => ctx.api('patch', '').send({ settings: { default_item_weight_grams: null } });
    const refused = await clear();
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('DEFAULT_ITEM_WEIGHT_REQUIRED');

    await ctx.api('post', '/shipping/pricing-mode').send({ mode: 'rates' });
    expect((await clear()).status).toBe(200);
  });
});

// --- pricing and orders ----------------------------------------------------------

describe('calculateShippingAmount — rates mode regression', () => {
  it('prices weight-based rates on known weights only, exactly as before, even with a default weight set', async () => {
    const ctx = await setup();
    const zone = await makeZone(ctx);
    await ctx.api('post', `/shipping/zones/${zone.id}/rates`).send({
      name: 'By weight',
      rateType: 'weight_based',
      config: { tiers: [{ upToGrams: 1000, amount: 2500 }], overflowAmount: 9000 },
    });
    await ctx.api('patch', '').send({ settings: { default_item_weight_grams: 5000 } });

    // variant has no weight: rates see 0 g -> 2500, the default weight is not used
    const order = await placeOrder(ctx, [{ variantId: ctx.variant.id, quantity: 2 }]);
    expect(Number(order.shippingAmount)).toBe(2500);
    // the stored weight is still estimated from the default, for couriers
    expect(order.totalWeightGrams).toBe(10000);
    expect(order.weightEstimated).toBe(true);

    await setWeight(ctx, ctx.variant.id, 600);
    const heavier = await placeOrder(ctx, [{ variantId: ctx.variant.id, quantity: 2 }]);
    expect(Number(heavier.shippingAmount)).toBe(9000);
    expect(heavier.weightEstimated).toBe(false);

    // the number-only call keeps working
    const legacy = await calculateShippingAmount(ctx.ws, { country: 'EG', region: 'Cairo', subtotal: 1, totalWeightGrams: 800, totalQuantity: 1 });
    expect(legacy.amount).toBe(2500);
  });
});

describe('tier pricing at checkout', () => {
  it('charges the zone price of the order weight\'s tier and snapshots weight, tier and unit weights', async () => {
    const ctx = await tierStore();
    await setWeight(ctx, ctx.variant.id, 800);

    const light = await placeOrder(ctx, [{ variantId: ctx.variant.id, quantity: 1 }]);
    expect(Number(light.shippingAmount)).toBe(3000);
    expect(light.totalWeightGrams).toBe(800);
    expect(light.weightEstimated).toBe(false);
    expect(light.weightTierSnapshot).toMatchObject({ id: ctx.tiers[0].id, fromGrams: 0, upToGrams: 1000, flags: [] });

    const mid = await placeOrder(ctx, [{ variantId: ctx.variant.id, quantity: 3 }]);
    expect(Number(mid.shippingAmount)).toBe(5000);
    expect(mid.weightTierSnapshot.id).toBe(ctx.tiers[1].id);

    const items = await db.OrderItem.findAll({ where: { orderId: mid.id } });
    expect(items[0].unitWeightGrams).toBe(800);
    expect(Number(mid.totalAmount)).toBe(3 * 10000 + 5000);
  });

  it('charges the last tier above a closed last tier and flags it — never refuses', async () => {
    const ctx = await tierStore();
    await setWeight(ctx, ctx.variant.id, 2000);
    const order = await placeOrder(ctx, [{ variantId: ctx.variant.id, quantity: 4 }]);
    expect(Number(order.shippingAmount)).toBe(8000);
    expect(order.weightTierSnapshot).toMatchObject({ id: ctx.tiers[2].id, flags: ['weight_over_last_tier'] });
    expect(order.riskFlags).toEqual([]);
  });

  it('weighs a missing variant weight at the default and marks the order estimated', async () => {
    const ctx = await tierStore();
    const order = await placeOrder(ctx, [{ variantId: ctx.variant.id, quantity: 3 }]);
    expect(order.totalWeightGrams).toBe(1500);
    expect(order.weightEstimated).toBe(true);
    expect(Number(order.shippingAmount)).toBe(5000);
  });

  it('weighs an offer by its lines × line quantity × offer quantity, not by the anchor variant', async () => {
    const ctx = await tierStore();
    await setWeight(ctx, ctx.variant.id, 100);
    const heavy = await ctx.api('post', `/catalog/products/${ctx.product.id}/variants`).send({
      priceAmount: 5000,
      stockOnHand: 50,
      optionValues: { Size: 'XL' },
      weightGrams: 400,
    });
    const offer = await ctx.api('post', `/catalog/products/${ctx.product.id}/offers`).send({
      name: 'Bundle',
      priceAmount: 20000,
      lines: [
        { variantId: ctx.variant.id, quantity: 1 },
        { variantId: heavy.body.variant.id, quantity: 2 },
      ],
    });
    expect(offer.status).toBe(201);

    const order = await placeOrder(ctx, [{ variantId: ctx.variant.id, offerId: offer.body.offer.id, quantity: 2 }]);
    // (100 + 2 × 400) × 2 = 1800 g -> tier 2; the anchor alone would be 200 g
    expect(order.totalWeightGrams).toBe(1800);
    expect(order.weightTierSnapshot.id).toBe(ctx.tiers[1].id);
    expect(Number(order.shippingAmount)).toBe(5000);
    const [item] = await db.OrderItem.findAll({ where: { orderId: order.id } });
    expect(item.unitWeightGrams).toBe(900);
  });

  it('counts non-physical products as weightless and falls back to the default rate when the zone has no price', async () => {
    const ctx = await tierStore();
    await db.Product.update({ productType: 'digital' }, { where: { id: ctx.product.id } });
    const digital = await placeOrder(ctx, [{ variantId: ctx.variant.id, quantity: 5 }]);
    expect(digital.totalWeightGrams).toBe(0);
    expect(digital.weightEstimated).toBe(false);

    await ctx.api('put', `/shipping/zones/${ctx.zone.id}/tier-prices`).send({ prices: [] });
    await ctx.api('patch', '').send({ settings: { default_shipping_rate_amount: 4200 } });
    const fallback = await placeOrder(ctx, [{ variantId: ctx.variant.id, quantity: 1 }]);
    expect(Number(fallback.shippingAmount)).toBe(4200);
  });

  it('prices the tier in the zone rate pricing would pick, never another matching zone', async () => {
    const ctx = await tierStore();
    await setWeight(ctx, ctx.variant.id, 800); // tier 1 (0–1 kg)
    // Two active zones both match Cairo. Each has a flat rate and a tier-1 price.
    const cairo = await makeZone(ctx, { name: 'Cairo', regions: ['Cairo'] });
    await ctx.api('post', `/shipping/zones/${ctx.zone.id}/rates`).send({ name: 'EG', rateType: 'flat', config: { amount: 7000 } });
    await ctx.api('post', `/shipping/zones/${cairo.id}/rates`).send({ name: 'Cairo', rateType: 'flat', config: { amount: 6000 } });
    await ctx.api('put', `/shipping/zones/${cairo.id}/tier-prices`).send({ prices: [{ tierId: ctx.tiers[0].id, amount: 1000 }] });

    const quote = async () =>
      (await request(app)
        .post(`/api/v1/store/${ctx.ws}/shipping-quote`)
        .send({ governorate: 'Cairo', items: [{ variantId: ctx.variant.id }] })).body.quote;

    // Ask rate pricing which zone it lands in.
    await ctx.api('post', '/shipping/pricing-mode').send({ mode: 'rates' });
    const rates = await quote();
    expect([7000, 6000]).toContain(rates.amount);
    const picked = rates.amount === 7000 ? ctx.zone : cairo;
    const other = picked === cairo ? ctx.zone : cairo;

    await ctx.api('post', '/shipping/pricing-mode').send({ mode: 'weight_tiers', prefill: false });
    expect((await quote()).amount).toBe(picked === cairo ? 1000 : 3000);

    // The picked zone has no price for the tier: default rate, even though the
    // other matching zone prices it.
    await ctx.api('put', `/shipping/zones/${picked.id}/tier-prices`).send({ prices: [] });
    await ctx.api('patch', '').send({ settings: { default_shipping_rate_amount: 4200 } });
    const otherPrices = await ctx.api('get', `/shipping/zones/${other.id}/tier-prices`);
    expect(otherPrices.body.prices.some((p) => p.tierId === ctx.tiers[0].id)).toBe(true);
    expect((await quote()).amount).toBe(4200);

    const order = await placeOrder(ctx, [{ variantId: ctx.variant.id, quantity: 1 }]);
    expect(Number(order.shippingAmount)).toBe(4200);
  });

  it('still lets the free-shipping threshold win in tier mode', async () => {
    const ctx = await tierStore();
    await ctx.api('patch', '').send({ settings: { free_shipping_threshold_amount: 20000 } });
    const order = await placeOrder(ctx, [{ variantId: ctx.variant.id, quantity: 2 }]);
    expect(Number(order.shippingAmount)).toBe(0);
    expect(order.weightTierSnapshot.id).toBe(ctx.tiers[0].id);
  });
});

// --- public quote --------------------------------------------------------------------

describe('POST /store/:ws/shipping-quote', () => {
  const quote = (ws, body, headers = {}) => request(app).post(`/api/v1/store/${ws}/shipping-quote`).set(headers).send(body);

  it('quotes the same amount and tier the order then gets', async () => {
    const ctx = await tierStore();
    await setWeight(ctx, ctx.variant.id, 800);
    const res = await quote(ctx.ws, { governorate: 'Cairo', items: [{ variantId: ctx.variant.id, quantity: 2 }] });
    expect(res.status).toBe(200);
    expect(res.body.quote).toMatchObject({
      pricingMode: 'weight_tiers',
      amount: 5000,
      currency: 'EGP',
      subtotal: 20000,
      weightGrams: 1600,
      weightEstimated: false,
    });
    expect(res.body.quote.tier.id).toBe(ctx.tiers[1].id);

    const order = await placeOrder(ctx, [{ variantId: ctx.variant.id, quantity: 2 }]);
    expect(Number(order.shippingAmount)).toBe(res.body.quote.amount);
  });

  it('quotes a cart by X-Cart-Token and needs items or a cart', async () => {
    const ctx = await tierStore();
    const created = await request(app).post(`/api/v1/store/${ctx.ws}/cart`).send({});
    const token = created.body.guestToken;
    const cart = await request(app)
      .post(`/api/v1/store/${ctx.ws}/cart/items`)
      .set('X-Cart-Token', token)
      .send({ variantId: ctx.variant.id, quantity: 3 });
    expect(cart.status).toBe(201);

    const res = await quote(ctx.ws, { governorate: 'Cairo' }, { 'X-Cart-Token': token });
    expect(res.status).toBe(200);
    expect(res.body.quote.weightGrams).toBe(1500);

    expect((await quote(ctx.ws, { governorate: 'Cairo' })).status).toBe(400);
  });

  it('quotes the rate amount in rates mode, and 404s an unknown variant', async () => {
    const ctx = await setup();
    const zone = await makeZone(ctx);
    await ctx.api('post', `/shipping/zones/${zone.id}/rates`).send({ name: 'Flat', rateType: 'flat', config: { amount: 3500 } });
    const res = await quote(ctx.ws, { governorate: 'Cairo', items: [{ variantId: ctx.variant.id }] });
    expect(res.body.quote).toMatchObject({ pricingMode: 'rates', amount: 3500, tier: null });

    const missing = await quote(ctx.ws, { items: [{ variantId: crypto.randomUUID() }] });
    expect(missing.status).toBe(404);
  });
});

// --- Bosta tier mapping -----------------------------------------------------------------

describe('Bosta package per weight tier', () => {
  const VALID_KEY = 'bosta-valid-api-key-0001';
  let deliveries;

  const reply = (status, json) => ({ status, ok: status >= 200 && status < 300, json, text: JSON.stringify(json), headers: new Map() });
  async function fakeBosta({ method = 'GET', url, body }) {
    const path = new URL(url).pathname.replace(/^\/api\/v2/, '');
    if (method === 'GET' && path === '/pickup-locations') {
      return reply(200, { success: true, data: { list: [{ _id: 'LOC-1', locationName: 'Main', isDefault: true }] } });
    }
    if (method === 'GET' && path === '/cities/getAllDistricts') {
      return reply(200, {
        success: true,
        data: [
          {
            cityId: 'CAI',
            cityName: 'Cairo',
            cityOtherName: 'القاهرة',
            districts: [{ districtId: 'D-NASR', districtName: 'Nasr City', districtOtherName: 'مدينة نصر', zoneId: 'Z-NASR', zoneName: 'Nasr City' }],
          },
        ],
      });
    }
    if (method === 'POST' && path === '/deliveries') {
      deliveries.push(body);
      const trackingNumber = String(81000000 + deliveries.length);
      return reply(200, { success: true, data: { _id: `DLV-${trackingNumber}`, trackingNumber, state: { code: 10 } } });
    }
    return reply(404, { success: false, message: `no route ${method} ${path}` });
  }

  const originalKey = env.carriers.credentialsKey;
  beforeAll(() => {
    env.carriers.credentialsKey = crypto.randomBytes(32).toString('base64');
  });
  afterAll(() => {
    env.carriers.credentialsKey = originalKey;
  });
  beforeEach(() => {
    deliveries = [];
    accounts.clearCitiesCache();
    jest.spyOn(carrierHttp, 'request').mockImplementation(fakeBosta);
  });
  afterEach(() => jest.restoreAllMocks());

  const connect = (ctx, settings) =>
    ctx.api('put', '/carriers/bosta').send({ credentials: { apiKey: VALID_KEY }, ...(settings ? { settings } : {}) });

  async function confirmedOrder(ctx, quantity) {
    const order = await placeOrder(ctx, [{ variantId: ctx.variant.id, quantity }]);
    await confirmCodOrder(ctx.token, ctx.ws, order.id);
    return order;
  }
  const book = (ctx, orderId, extra = {}) => ctx.api('post', `/orders/${orderId}/shipments`).send({ carrierCode: 'bosta', ...extra });

  it('books the package the order\'s tier maps to, and stores it on the shipment', async () => {
    const ctx = await tierStore();
    await setWeight(ctx, ctx.variant.id, 800);
    const connected = await connect(ctx, {
      tierMap: {
        [ctx.tiers[0].id]: { packageType: 'Parcel', size: 'SMALL' },
        [ctx.tiers[1].id]: { packageType: 'Parcel', size: 'LARGE' },
        [ctx.tiers[2].id]: { packageType: 'Heavy Bulky' },
      },
    });
    expect(connected.status).toBe(200);

    const order = await confirmedOrder(ctx, 2); // 1600 g -> tier 2
    const res = await book(ctx, order.id);
    expect(res.status).toBe(201);
    expect(deliveries[0].specs).toMatchObject({ packageType: 'Parcel', size: 'LARGE' });
    expect(res.body.shipment.carrierResponse.package).toMatchObject({
      tierId: ctx.tiers[1].id,
      packageType: 'Parcel',
      size: 'LARGE',
      source: 'tier_map',
      tierOverridden: false,
    });
  });

  it('lets the merchant override the tier at booking; a bulky type is sent as its own size', async () => {
    const ctx = await tierStore();
    await setWeight(ctx, ctx.variant.id, 800);
    await connect(ctx, {
      tierMap: { [ctx.tiers[0].id]: { packageType: 'Parcel', size: 'SMALL' }, [ctx.tiers[2].id]: { packageType: 'Light Bulky' } },
    });
    const order = await confirmedOrder(ctx, 1);
    const res = await book(ctx, order.id, { tierId: ctx.tiers[2].id });
    expect(res.status).toBe(201);
    expect(deliveries[0].specs).toMatchObject({ packageType: 'Light Bulky', size: 'Light Bulky' });
    expect(res.body.shipment.carrierResponse.package.tierOverridden).toBe(true);

    const foreign = await setup();
    const [foreignTier] = await putTiers(foreign, [{ upToGrams: 100 }]);
    const order2 = await confirmedOrder(ctx, 1);
    expect((await book(ctx, order2.id, { tierId: foreignTier.id })).status).toBe(422);
  });

  it('refuses an unmapped tier with 422 CARRIER_TIER_UNMAPPED before calling Bosta', async () => {
    const ctx = await tierStore();
    await setWeight(ctx, ctx.variant.id, 800);
    await connect(ctx, { tierMap: { [ctx.tiers[0].id]: { packageType: 'Parcel', size: 'SMALL' } } });
    const order = await confirmedOrder(ctx, 3); // tier 2, unmapped
    const res = await book(ctx, order.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CARRIER_TIER_UNMAPPED');
    expect(deliveries).toHaveLength(0);
    expect(await db.Shipment.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('keeps using the single packageType setting when there is no tierMap', async () => {
    const ctx = await tierStore();
    await connect(ctx, { packageType: 'Document' });
    const order = await confirmedOrder(ctx, 1);
    const res = await book(ctx, order.id);
    expect(res.status).toBe(201);
    expect(deliveries[0].specs.packageType).toBe('Document');
    expect(deliveries[0].specs.size).toBeUndefined();
    expect(res.body.shipment.carrierResponse.package.source).toBe('default');
  });

  it("keeps only the store's current tiers in the tierMap, and a Parcel needs a size", async () => {
    const ctx = await tierStore();
    const other = await setup();
    const [foreignTier] = await putTiers(other, [{ upToGrams: 100 }]);
    const mixed = await connect(ctx, {
      tierMap: {
        [foreignTier.id]: { packageType: 'Parcel', size: 'SMALL' },
        [ctx.tiers[0].id]: { packageType: 'Document' },
      },
    });
    expect(mixed.status).toBe(200);
    expect(mixed.body.carrier.connection.settings.tierMap).toEqual({ [ctx.tiers[0].id]: { packageType: 'Document' } });

    // a deleted tier's mapping is dropped on the next save instead of failing it
    await putTiers(ctx, [{ id: ctx.tiers[1].id, upToGrams: 3000 }]);
    const resaved = await ctx.api('put', '/carriers/bosta').send({ settings: mixed.body.carrier.connection.settings });
    expect(resaved.status).toBe(200);
    expect(resaved.body.carrier.connection.settings.tierMap).toEqual({});

    const noSize = await connect(ctx, { tierMap: { [ctx.tiers[0].id]: { packageType: 'Parcel' } } });
    expect(noSize.status).toBe(422);
    const docWithSize = await connect(ctx, { tierMap: { [ctx.tiers[0].id]: { packageType: 'Document', size: 'SMALL' } } });
    expect(docWithSize.status).toBe(422);
  });
});
