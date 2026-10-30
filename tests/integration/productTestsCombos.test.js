'use strict';

// A product page's A/B test (catalog/productTests.js) pins a visitor's price on
// plain lines only: a combo's lines (modules/combos) keep the combo's price,
// and a plain line of the same product still gets the tested price.

const { app, request, setupWorkspaceWithProduct, createProductWithVariant } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const productTests = require('../../src/modules/catalog/productTests');

const COMBO = Symbol.for('zimos.combo');
const TEST_PRICE = Symbol.for('zimos.productTestPrice');
const VISITOR = 'visitor-ab-combo-1';
const key = () => `ptc-${Date.now()}-${Math.random().toString(36).slice(2)}`;

beforeEach(() => {
  env.combos.enabled = true;
});
afterEach(() => {
  env.combos.enabled = false;
});

async function setup() {
  const ctx = await setupWorkspaceWithProduct({ price: 1000, stock: 20 });
  const b = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id, { price: 2000, stock: 20 });
  // A running test on product A whose variant B sells A's variant at 500, this visitor pinned to B.
  const experiment = await db.Experiment.create({
    workspaceId: ctx.workspace.id,
    subjectType: 'product_page',
    subjectId: ctx.product.id,
    name: 'Price test',
    status: 'running',
    variants: [
      { key: 'A', name: 'Control', weight: 50, data: {} },
      { key: 'B', name: 'Cheaper', weight: 50, data: { prices: { [ctx.variant.id]: 500 } } },
    ],
  });
  await db.ExperimentAssignment.create({ experimentId: experiment.id, visitorId: VISITOR, variantKey: 'B' });
  return { ...ctx, b };
}

function buyNow(ctx, item) {
  return request(app)
    .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
    .set('Idempotency-Key', key())
    .set('X-Visitor-Id', VISITOR)
    .send({ item, contact: { fullName: 'AB Buyer', phone: `0101${Math.floor(1000000 + Math.random() * 8999999)}` }, shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 St' }, paymentMethod: 'cod' });
}

describe('product A/B prices and combos', () => {
  it('pinPrices pins a plain line and leaves a combo line alone', async () => {
    const ctx = await setup();
    const pinned = await productTests.pinPrices(ctx.workspace.id, [{ variantId: ctx.variant.id, quantity: 1 }, { variantId: ctx.variant.id, quantity: 1, [COMBO]: { key: 'k' } }], VISITOR);
    expect(pinned[0][TEST_PRICE]).toBe(500);
    expect(pinned[1][TEST_PRICE]).toBeUndefined();
  });

  it('the visitor pays the tested price alone, and the combo\'s price inside a combo', async () => {
    const ctx = await setup();
    const plain = await buyNow(ctx, { variantId: ctx.variant.id, quantity: 1 });
    expect(plain.status).toBe(201);
    expect(Number(plain.body.order.subtotalAmount)).toBe(500);

    const H = { Authorization: `Bearer ${ctx.auth.accessToken}` };
    const made = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/combos`)
      .set(H)
      .send({ name: 'Pair', status: 'active', pricingMode: 'percent_off', priceValue: 1000, items: [{ productId: ctx.product.id, variantId: ctx.variant.id }, { productId: ctx.b.product.id, variantId: ctx.b.variant.id }] });
    expect(made.status).toBe(201);
    const combo = await buyNow(ctx, { comboId: made.body.combo.id, quantity: 1 });
    expect(combo.status).toBe(201);
    // 10% off 1000 + 2000, never off the tested 500.
    expect(Number(combo.body.order.subtotalAmount)).toBe(2700);
  });
});
