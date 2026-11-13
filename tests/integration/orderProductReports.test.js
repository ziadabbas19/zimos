'use strict';

// The orders report and the products report (analytics/orderProductReports.js,
// STORE_FEATURES order_product_reports): the numbers of a date range, the
// orders behind them, the per-product figures, stock, the trend and the CSVs —
// and that the counts per status are the Orders page's own tab counts.

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct, createProductWithVariant, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const FEATURE = 'order_product_reports';
const ORIGINAL_FEATURES = [...env.storeFeatures];
beforeEach(() => {
  env.storeFeatures.splice(0, env.storeFeatures.length, ...ORIGINAL_FEATURES, FEATURE);
});
afterAll(() => {
  env.storeFeatures.splice(0, env.storeFeatures.length, ...ORIGINAL_FEATURES);
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const CAIRO = 'القاهرة (Cairo)';
const GIZA = 'الجيزة (Giza)';

async function place(ctx, { variant = ctx.variant, quantity = 1, province = CAIRO, name = 'Report Buyer', phone = '01012345678' } = {}) {
  const res = await request(app)
    .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
    .set('Idempotency-Key', `rep-${crypto.randomUUID()}`)
    .send({
      item: { variantId: variant.id, quantity },
      contact: { fullName: name, phone },
      shippingAddress: { country: 'EG', province, city: 'City', addressLine: '1 Report Street' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`checkout: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order.id;
}

async function ship(orderId, workspaceId, carrier, status) {
  await db.sequelize.query(
    `INSERT INTO shipments (id, workspace_id, order_id, carrier_code, status, tracking_code, created_at, updated_at)
     VALUES (gen_random_uuid(), :workspaceId, :orderId, :carrier, :status, :tracking, NOW(), NOW())`,
    { replacements: { workspaceId, orderId, carrier, status, tracking: crypto.randomBytes(8).toString('hex').slice(0, 16) } }
  );
}

const range = () => {
  const from = new Date(Date.now() - 2 * 86400000).toISOString();
  const to = new Date(Date.now() + 86400000).toISOString();
  return { from, to };
};

/**
 * One store, nine orders placed through the checkout:
 *   a  Cairo, 2 units, delivered by bosta
 *   b  Cairo, 1 unit, returned by bosta
 *   c  Giza, 1 unit, delivered by aramex
 *   d  Giza, 1 unit, cancelled
 *   e  Cairo, 3 units of the second product, pending confirmation
 *   f  Cairo, 1 unit, failed delivery by aramex
 *   g  a test order, h  an archived order — left out of every number
 *   i  placed three days ago — outside the range
 */
async function seeded() {
  const ctx = await setupWorkspaceWithProduct({ price: 10000, stock: 100 });
  const ws = ctx.workspace.id;
  const second = await createProductWithVariant(ctx.auth.accessToken, ws, { price: 25000, stock: 3 });
  const ids = {};
  ids.a = await place(ctx, { quantity: 2 });
  ids.b = await place(ctx);
  ids.c = await place(ctx, { province: GIZA });
  ids.d = await place(ctx, { province: GIZA });
  ids.e = await place(ctx, { variant: second.variant, quantity: 3 });
  ids.f = await place(ctx);
  ids.g = await place(ctx);
  ids.h = await place(ctx);
  ids.i = await place(ctx);
  await ship(ids.a, ws, 'bosta', 'delivered');
  await ship(ids.b, ws, 'bosta', 'returned');
  await ship(ids.c, ws, 'aramex', 'delivered');
  await ship(ids.f, ws, 'aramex', 'failed');
  await db.Order.update({ cancelledAt: new Date() }, { where: { id: ids.d } });
  await db.Order.update({ isTest: true }, { where: { id: ids.g } });
  await db.Order.update({ archivedAt: new Date() }, { where: { id: ids.h } });
  await db.sequelize.query("UPDATE orders SET created_at = NOW() - INTERVAL '3 days' WHERE id = :id", { replacements: { id: ids.i } });
  const api = (path, token = ctx.auth.accessToken) => request(app).get(`/api/v1/workspaces/${ws}/analytics/reports${path}`).set(bearer(token));
  return { ...ctx, ws, second, ids, api };
}

describe('the switch', () => {
  it('answers 404 while STORE_FEATURES does not name order_product_reports', async () => {
    env.storeFeatures.splice(0, env.storeFeatures.length, ...ORIGINAL_FEATURES.filter((f) => f !== FEATURE));
    const ctx = await setupWorkspaceWithProduct();
    for (const path of ['/orders-overview', '/orders-overview/orders', '/orders-overview/export', '/products-overview', '/products-overview/export']) {
      const res = await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/analytics/reports${path}`).set(bearer(ctx.auth.accessToken));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('FEATURE_UNAVAILABLE');
    }
  });
});

describe('the orders report', () => {
  it('counts the orders of the range, its revenue and rates, and leaves test, archived and older orders out', async () => {
    const s = await seeded();
    const res = await s.api('/orders-overview').query({ ...range(), compare: 'none' });
    expect(res.status).toBe(200);
    const k = res.body.report.kpis;
    // a b c d e f: six orders; d is cancelled.
    expect(k.orders.value).toBe(6);
    // Revenue: every order but the cancelled one — a 20000 + b 10000 + c 10000 + e 75000 + f 10000.
    const shipping = await db.Order.findAll({ where: { id: [s.ids.a, s.ids.b, s.ids.c, s.ids.e, s.ids.f] }, attributes: ['totalAmount'] });
    const revenue = shipping.reduce((sum, o) => sum + Number(o.totalAmount), 0);
    expect(k.revenue.value).toBe(revenue);
    expect(k.averageOrderValue.value).toBe(Math.round(revenue / 5));
    expect(k.cancellationRate.value).toBe(16.7);
    // Left with a courier: a b c f; delivered a c; returned or failed b f.
    expect(k.deliveryRate.value).toBe(50);
    expect(k.returnRate.value).toBe(50);
    expect(k.orders.previous).toBeNull();
  });

  it('has the Orders page tab counts for the same days, status by status', async () => {
    const s = await seeded();
    const { from, to } = range();
    const report = await s.api('/orders-overview').query({ from, to, compare: 'none' });
    const tabs = await request(app)
      .get(`/api/v1/workspaces/${s.ws}/orders/pipeline`)
      .set(bearer(s.auth.accessToken))
      .query({ from: from.slice(0, 10), to: to.slice(0, 10), test: false });
    expect(tabs.status).toBe(200);
    for (const row of report.body.report.byStatus) expect([row.status, row.orders]).toEqual([row.status, tabs.body.stages[row.status]]);
    expect(report.body.report.byStatus.reduce((n, r) => n + r.orders, 0)).toBe(tabs.body.total);
  });

  it('breaks the orders down by governorate, payment method and courier, and draws a daily trend', async () => {
    const s = await seeded();
    const { report } = (await s.api('/orders-overview').query({ ...range(), unit: 'day' })).body;
    const gov = Object.fromEntries(report.byGovernorate.map((g) => [g.name, g.orders]));
    expect(gov[CAIRO]).toBe(4);
    expect(gov[GIZA]).toBe(2);
    expect(report.byPaymentMethod).toEqual([expect.objectContaining({ name: 'cod', orders: 6 })]);
    const carriers = Object.fromEntries(report.byCarrier.map((c) => [c.name, c]));
    expect(carriers.bosta.orders).toBe(2);
    expect(carriers.bosta.deliveryRate).toBe(50);
    expect(carriers.aramex.orders).toBe(2);
    // Not shipped yet (d, e): no courier.
    expect(carriers.null || report.byCarrier.find((c) => c.name === null)).toEqual(expect.objectContaining({ orders: 2 }));
    expect(report.unit).toBe('day');
    expect(report.series.reduce((n, b) => n + b.orders, 0)).toBe(6);
    // The comparison window holds the older order.
    expect(report.previousSeries.reduce((n, b) => n + b.orders, 0)).toBe(1);
    expect(report.kpis.orders.previous).toBe(1);
  });

  it('lists the orders behind the numbers, filtered by a breakdown row and paged', async () => {
    const s = await seeded();
    const all = await s.api('/orders-overview/orders').query({ ...range(), limit: 4 });
    expect(all.status).toBe(200);
    expect(all.body.orders).toHaveLength(4);
    expect(all.body.nextCursor).toBeTruthy();
    const rest = await s.api('/orders-overview/orders').query({ ...range(), limit: 4, cursor: all.body.nextCursor });
    expect(rest.body.orders).toHaveLength(2);
    expect(rest.body.nextCursor).toBeNull();
    const ids = [...all.body.orders, ...rest.body.orders].map((o) => o.id);
    expect(new Set(ids).size).toBe(6);
    expect(ids).not.toContain(s.ids.g);

    const giza = await s.api('/orders-overview/orders').query({ ...range(), governorate: GIZA });
    expect(giza.body.orders.map((o) => o.id).sort()).toEqual([s.ids.c, s.ids.d].sort());
    const cancelled = await s.api('/orders-overview/orders').query({ ...range(), status: 'cancelled' });
    expect(cancelled.body.orders.map((o) => o.id)).toEqual([s.ids.d]);
    expect(cancelled.body.orders[0].countsAsRevenue).toBe(false);
    const unshipped = await s.api('/orders-overview/orders').query({ ...range(), carrier: '' });
    expect(unshipped.body.orders.map((o) => o.id).sort()).toEqual([s.ids.d, s.ids.e].sort());
    const row = all.body.orders.find((o) => o.id === s.ids.a) || rest.body.orders.find((o) => o.id === s.ids.a);
    expect(row).toEqual(expect.objectContaining({ status: 'delivered', carrier: 'bosta', items: 2, customerName: 'Report Buyer', contactLocked: false }));
  });

  it("names customers only to a teammate who may see orders", async () => {
    const s = await seeded();
    const member = await addMemberWithRole(s.auth.accessToken, s.ws, 'editor');
    await db.Role.update({ permissions: ['analytics.view'] }, { where: { workspaceId: s.ws, key: 'editor' } });
    const res = await s.api('/orders-overview/orders', member.accessToken).query(range());
    expect(res.status).toBe(200);
    expect(res.body.orders.length).toBe(6);
    for (const o of res.body.orders) expect(o.customerName).toBeUndefined();
    const file = await s.api('/orders-overview/export', member.accessToken).query(range());
    expect(file.text.split('\r\n')[0]).not.toContain('Customer');
    expect(file.text).not.toContain('Report Buyer');
  });

  it('exports the orders as a CSV with the filters applied', async () => {
    const s = await seeded();
    const res = await s.api('/orders-overview/export').query({ ...range(), status: 'delivered' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="zimos-orders-/);
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Order,Placed,Status,Customer,Payment method,Governorate,Courier,Items,Total,Counts as revenue');
    expect(lines).toHaveLength(3);
    expect(lines.slice(1).every((l) => l.includes(',delivered,'))).toBe(true);
  });

  it("never shows another store's orders, and refuses a teammate without analytics", async () => {
    const s = await seeded();
    const other = await setupWorkspaceWithProduct();
    const foreign = await place(other);
    const res = await s.api('/orders-overview/orders').query(range());
    expect(res.body.orders.map((o) => o.id)).not.toContain(foreign);
    const theirs = await request(app).get(`/api/v1/workspaces/${s.ws}/analytics/reports/orders-overview`).set(bearer(other.auth.accessToken));
    // Not a member of that store: it is not found, as every store route answers.
    expect(theirs.status).toBe(404);
    const editor = await addMemberWithRole(s.auth.accessToken, s.ws, 'editor');
    expect((await s.api('/orders-overview', editor.accessToken)).status).toBe(403);
  });
});

describe('the products report', () => {
  it('ranks products by revenue and units, with each one’s share and returned units', async () => {
    const s = await seeded();
    const res = await s.api('/products-overview').query(range());
    expect(res.status).toBe(200);
    const r = res.body.report;
    const first = r.rows.find((p) => p.productId === s.product.id);
    const second = r.rows.find((p) => p.productId === s.second.product.id);
    // First product: a 2 + b 1 + c 1 + f 1 = 5 units (d cancelled); second: e 3 units.
    expect(first.units).toBe(5);
    expect(first.revenue).toBe(50000);
    expect(first.returnedUnits).toBe(2);
    expect(first.orders).toBe(4);
    expect(second.units).toBe(3);
    expect(second.revenue).toBe(75000);
    expect(r.totals).toEqual(expect.objectContaining({ revenue: 125000, units: 8, productsSold: 2 }));
    expect(first.share).toBe(40);
    expect(second.share).toBe(60);
    expect(r.topByRevenue[0].productId).toBe(s.second.product.id);
    expect(r.topByUnits[0].productId).toBe(s.product.id);
    expect(r.lowestSellers[0].productId).toBe(s.second.product.id);
  });

  it('rolls variants up to their product, lists products with no sales, and shows low and out of stock', async () => {
    const s = await seeded();
    // A second variant of the first product, sold once: it counts for the product.
    const v2 = await request(app)
      .post(`/api/v1/workspaces/${s.ws}/catalog/products/${s.product.id}/variants`)
      .set(bearer(s.auth.accessToken))
      .send({ sku: `V2-${Date.now()}`, priceAmount: 12000, stockOnHand: 2 });
    expect(v2.status).toBe(201);
    await place(s, { variant: v2.body.variant });
    const quiet = await createProductWithVariant(s.auth.accessToken, s.ws, { price: 5000, stock: 0 });
    const r = (await s.api('/products-overview').query(range())).body.report;
    expect(r.rows.filter((p) => p.productId === s.product.id)).toHaveLength(1);
    expect(r.rows.find((p) => p.productId === s.product.id).units).toBe(6);
    expect(r.noSales.map((p) => p.productId)).toContain(quiet.product.id);
    expect(r.totals.productsUnsold).toBeGreaterThanOrEqual(1);
    const stock = Object.fromEntries(r.stock.map((p) => [p.productId, p]));
    expect(stock[quiet.product.id]).toEqual(expect.objectContaining({ state: 'out', available: 0 }));
    // The second product had 3 and sold 3 with the order pending: none left to sell.
    expect(stock[s.second.product.id]).toEqual(expect.objectContaining({ state: 'out' }));
    // Its second variant has 1 left (2 − 1): at or below the alert level of 5 when none is set.
    expect(stock[s.product.id]).toEqual(expect.objectContaining({ state: 'low' }));
  });

  it('draws one product’s trend, and refuses another store’s product', async () => {
    const s = await seeded();
    const res = await s.api(`/products-overview/${s.product.id}/trend`).query(range());
    expect(res.status).toBe(200);
    expect(res.body.trend.series.reduce((n, b) => n + b.units, 0)).toBe(5);
    const other = await setupWorkspaceWithProduct();
    expect((await s.api(`/products-overview/${other.product.id}/trend`).query(range())).status).toBe(404);
  });

  it('exports every product of the range as a CSV, sold or not', async () => {
    const s = await seeded();
    const res = await s.api('/products-overview/export').query(range());
    expect(res.status).toBe(200);
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Product,Units sold,Revenue,Share of revenue %,Orders,Returned units,In stock');
    expect(lines.some((l) => l.includes(',750.00,60.0,'))).toBe(true);
  });
});
