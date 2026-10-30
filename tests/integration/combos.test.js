'use strict';

// Combos (modules/combos, migration 733, PRODUCT_COMBOS_ENABLED): different
// products at one price. Priced by the server only; one cart line; in the
// order one ordinary line per component sharing the combo's key, with the
// saving spread over them; stock taken from each; refused when a component
// is gone, a pick is missing or the price is above the components'.

const { app, request, setupWorkspaceWithProduct, createProductWithVariant } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

beforeEach(() => {
  env.combos.enabled = true;
});
afterEach(() => {
  env.combos.enabled = false;
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const key = () => `cb-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function store() {
  const ctx = await setupWorkspaceWithProduct({ price: 1000, stock: 10 });
  const b = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id, { price: 2000, stock: 10 });
  return { ...ctx, a: { product: ctx.product, variant: ctx.variant }, b };
}

const staff = (ctx, method, url, body) => request(app)[method](`/api/v1/workspaces/${ctx.workspace.id}/combos${url}`).set(bearer(ctx.auth.accessToken)).send(body);

async function combo(ctx, body) {
  const res = await staff(ctx, 'post', '', {
    name: 'طقم السماعة والشاحن',
    status: 'active',
    items: [
      { productId: ctx.a.product.id, variantId: ctx.a.variant.id, quantity: 1 },
      { productId: ctx.b.product.id, variantId: ctx.b.variant.id, quantity: 1 },
    ],
    pricingMode: 'fixed_price',
    priceValue: 2500,
    ...body,
  });
  if (res.status !== 201) throw new Error(`combo: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.combo;
}

function buyNow(ctx, item, extra = {}) {
  return request(app)
    .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
    .set('Idempotency-Key', key())
    .send({
      item,
      contact: { fullName: 'Combo Buyer', phone: '01012121234' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Combo St' },
      paymentMethod: 'cod',
      ...extra,
    });
}

const linesOf = (orderId) => db.OrderItem.findAll({ where: { orderId }, order: [['createdAt', 'ASC']] });

describe('combos', () => {
  it('are off unless PRODUCT_COMBOS_ENABLED: routes 404 and a checkout naming one is refused', async () => {
    const ctx = await store();
    const made = await combo(ctx);
    env.combos.enabled = false;
    expect((await staff(ctx, 'get', '')).status).toBe(404);
    expect((await buyNow(ctx, { comboId: made.id, quantity: 1 })).status).toBe(404);
    const page = await request(app).get(`/api/v1/store/${ctx.workspace.id}/products/${ctx.a.product.id}`);
    expect(page.body.product.combos).toEqual([]);
  });

  it('a fixed price: one line per product in the order, the saving spread over them, stock from each', async () => {
    const ctx = await store();
    const made = await combo(ctx);
    expect(made.price).toEqual({ full: 3000, total: 2500 });

    const res = await buyNow(ctx, { comboId: made.id, quantity: 1 });
    expect(res.status).toBe(201);
    const order = res.body.order;
    expect(Number(order.subtotalAmount)).toBe(2500);
    const lines = await linesOf(order.id);
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => l.comboKey)).size).toBe(1);
    expect(lines.map((l) => l.productId).sort()).toEqual([ctx.a.product.id, ctx.b.product.id].sort());
    expect(lines.reduce((sum, l) => sum + Number(l.lineDiscountAmount), 0)).toBe(500);
    expect(lines.reduce((sum, l) => sum + Number(l.lineTotalAmount), 0)).toBe(2500);
    expect(lines.every((l) => l.comboNameSnapshot === 'طقم السماعة والشاحن')).toBe(true);
    const stored = await db.Order.findByPk(order.id);
    expect(stored.discountsSnapshot).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'combo', comboId: made.id, amount: 500 })]));
    expect((await db.ProductVariant.findByPk(ctx.a.variant.id)).reservedStock).toBe(1);
    expect((await db.ProductVariant.findByPk(ctx.b.variant.id)).reservedStock).toBe(1);
  });

  it('a percentage and an amount off, bought twice', async () => {
    const ctx = await store();
    const pct = await combo(ctx, { pricingMode: 'percent_off', priceValue: 1000 });
    const res = await buyNow(ctx, { comboId: pct.id, quantity: 2 });
    expect(Number(res.body.order.subtotalAmount)).toBe(5400); // 2 × (3000 − 10%)

    const off = await combo(ctx, { pricingMode: 'amount_off', priceValue: 700 });
    const again = await buyNow(ctx, { comboId: off.id, quantity: 2 }, { contact: { fullName: 'Second', phone: '01012120000' } });
    expect(Number(again.body.order.subtotalAmount)).toBe(4600); // 2 × (3000 − 700)
  });

  it('refuses a price above the components, one product only, and a product that needs the shopper\'s input', async () => {
    const ctx = await store();
    const above = await staff(ctx, 'post', '', {
      name: 'x', items: [{ productId: ctx.a.product.id, variantId: ctx.a.variant.id }, { productId: ctx.b.product.id, variantId: ctx.b.variant.id }], pricingMode: 'fixed_price', priceValue: 3500,
    });
    expect(above.status).toBe(422);
    expect(above.body.error.code).toBe('COMBO_PRICE_ABOVE_TOTAL');

    const single = await staff(ctx, 'post', '', { name: 'x', items: [{ productId: ctx.a.product.id, variantId: ctx.a.variant.id }, { productId: ctx.a.product.id, variantId: ctx.a.variant.id, quantity: 2 }], pricingMode: 'percent_off', priceValue: 500 });
    expect(single.body.error.code).toBe('COMBO_NEEDS_TWO_PRODUCTS');

    await db.Product.update({ customFields: [{ id: 'f1', type: 'text', label: 'Name', required: true }] }, { where: { id: ctx.b.product.id } });
    const input = await staff(ctx, 'post', '', { name: 'x', items: [{ productId: ctx.a.product.id, variantId: ctx.a.variant.id }, { productId: ctx.b.product.id, variantId: ctx.b.variant.id }], pricingMode: 'percent_off', priceValue: 500 });
    expect(input.body.error.code).toBe('COMBO_PRODUCT_NEEDS_INPUT');

    const foreign = await staff(ctx, 'post', '', { name: 'x', items: [{ productId: ctx.a.product.id, variantId: ctx.b.variant.id }, { productId: ctx.b.product.id, pickVariant: true }], pricingMode: 'percent_off', priceValue: 500 });
    expect(foreign.status).toBe(422);
  });

  it('a component the shopper picks: missing or foreign picks are refused', async () => {
    const ctx = await store();
    const made = await combo(ctx, { items: [{ productId: ctx.a.product.id, variantId: ctx.a.variant.id }, { productId: ctx.b.product.id, pickVariant: true }] });
    const pickItem = made.items.find((i) => i.pickVariant);

    const missing = await buyNow(ctx, { comboId: made.id });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('COMBO_VARIANT_REQUIRED');

    const foreign = await buyNow(ctx, { comboId: made.id, comboSelection: [{ itemId: pickItem.id, variantId: ctx.a.variant.id }] });
    expect(foreign.body.error.code).toBe('COMBO_VARIANT_REQUIRED');

    const ok = await buyNow(ctx, { comboId: made.id, comboSelection: [{ itemId: pickItem.id, variantId: ctx.b.variant.id }] });
    expect(ok.status).toBe(201);
  });

  it('runs out when any component runs out, and an archived product stops it', async () => {
    const ctx = await store();
    const made = await combo(ctx);
    await db.ProductVariant.update({ stockOnHand: 0 }, { where: { id: ctx.b.variant.id } });
    const page = await request(app).get(`/api/v1/store/${ctx.workspace.id}/products/${ctx.a.product.id}`);
    expect(page.body.product.combos[0]).toMatchObject({ id: made.id, available: false });
    const refused = await buyNow(ctx, { comboId: made.id });
    expect(refused.status).not.toBe(201);
    expect((await db.ProductVariant.findByPk(ctx.a.variant.id)).reservedStock).toBe(0);

    await db.ProductVariant.update({ stockOnHand: 10 }, { where: { id: ctx.b.variant.id } });
    await db.Product.update({ status: 'archived' }, { where: { id: ctx.b.product.id } });
    const gone = await buyNow(ctx, { comboId: made.id });
    expect(gone.body.error.code).toBe('COMBO_UNAVAILABLE');
  });

  it('is one line in the cart, priced by the server, and the checkout turns it into its products', async () => {
    const ctx = await store();
    const made = await combo(ctx);
    const cart = await request(app).post(`/api/v1/store/${ctx.workspace.id}/cart`).send({});
    const token = cart.body.guestToken;
    const add = () => request(app).post(`/api/v1/store/${ctx.workspace.id}/cart/items`).set('X-Cart-Token', token).send({ comboId: made.id, quantity: 1 });
    expect((await add()).status).toBe(201);
    const twice = await add();
    expect(twice.body.items).toHaveLength(1);
    expect(twice.body.items[0]).toMatchObject({ comboId: made.id, quantity: 2, currentUnitPrice: 2500, lineTotal: 5000 });
    expect(twice.body.items[0].combo.items).toHaveLength(2);
    expect(twice.body.subtotal).toBe(5000);

    const res = await request(app)
      .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
      .set('X-Cart-Token', token)
      .set('Idempotency-Key', key())
      .send({ contact: { fullName: 'Cart Buyer', phone: '01012125555' }, shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '2 St' }, paymentMethod: 'cod' });
    expect(res.status).toBe(201);
    expect(Number(res.body.order.subtotalAmount)).toBe(5000);
    expect(await linesOf(res.body.order.id)).toHaveLength(2);
  });

  it('the shipping quote prices a combo as its products at the combo price, from the cart or from the items', async () => {
    const ctx = await store();
    const made = await combo(ctx);
    const cart = await request(app).post(`/api/v1/store/${ctx.workspace.id}/cart`).send({});
    await request(app).post(`/api/v1/store/${ctx.workspace.id}/cart/items`).set('X-Cart-Token', cart.body.guestToken).send({ comboId: made.id, quantity: 2 }).expect(201);
    const fromCart = await request(app).post(`/api/v1/store/${ctx.workspace.id}/shipping-quote`).set('X-Cart-Token', cart.body.guestToken).send({ country: 'EG' });
    expect(fromCart.status).toBe(200);
    expect(fromCart.body.quote.subtotal).toBe(5000);
    const fromItems = await request(app).post(`/api/v1/store/${ctx.workspace.id}/shipping-quote`).send({ country: 'EG', items: [{ comboId: made.id, quantity: 1 }] });
    expect(fromItems.status).toBe(200);
    expect(fromItems.body.quote.subtotal).toBe(2500);
  });

  it('a coupon comes off a combo by default, and never when it leaves offers out', async () => {
    const ctx = await store();
    const made = await combo(ctx);
    const H = bearer(ctx.auth.accessToken);
    await request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/discounts`).set(H).send({ code: 'TENOFF', type: 'percentage', value: 1000 }).expect(201);
    await request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/discounts`).set(H).send({ code: 'NOCOMBO', type: 'percentage', value: 1000, combinesWithOffers: false }).expect(201);
    const withCode = await buyNow(ctx, { comboId: made.id }, { discountCode: 'TENOFF' });
    expect(Number(withCode.body.order.discountAmount)).toBe(250);
    const refused = await buyNow(ctx, { comboId: made.id }, { discountCode: 'NOCOMBO', contact: { fullName: 'B', phone: '01012126666' } });
    expect(refused.body.error.code).toBe('DISCOUNT_NOT_COMBINABLE');
  });

  it('an order with a combo cannot have its items edited one by one', async () => {
    const ctx = await store();
    const made = await combo(ctx);
    const res = await buyNow(ctx, { comboId: made.id });
    const lines = await linesOf(res.body.order.id);
    const edit = await request(app)
      .put(`/api/v1/workspaces/${ctx.workspace.id}/orders/${res.body.order.id}/items`)
      .set(bearer(ctx.auth.accessToken))
      .send({ items: lines.map((l) => ({ variantId: l.variantId, quantity: l.variantId === ctx.a.variant.id ? 2 : 1 })) });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('ORDER_HAS_COMBO');
  });

  it('shows on its products\' pages with the price at the first choice', async () => {
    const ctx = await store();
    const made = await combo(ctx);
    const page = await request(app).get(`/api/v1/store/${ctx.workspace.id}/products/${ctx.b.product.id}`);
    expect(page.body.product.combos).toEqual([
      expect.objectContaining({ id: made.id, available: true, price: { full: 3000, total: 2500, saving: 500 } }),
    ]);
    expect(page.body.product.combos[0].items.map((i) => i.product.id)).toEqual([ctx.a.product.id, ctx.b.product.id]);
    // Archived: off every page.
    await staff(ctx, 'delete', `/${made.id}`).expect(200);
    expect((await request(app).get(`/api/v1/store/${ctx.workspace.id}/products/${ctx.b.product.id}`)).body.product.combos).toEqual([]);
  });
});
