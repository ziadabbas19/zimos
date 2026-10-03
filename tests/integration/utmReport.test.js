'use strict';

// GET /analytics/utm — sales by UTM value. Every order of the window lands in
// exactly one row (a value, direct, or not tracked); drill-down filters;
// content/term from the landing page; access and store isolation; the
// 366-day ceiling.

const {
  app,
  request,
  registerAndActivate,
  createWorkspace,
  createProductWithVariant,
  addMemberWithRole,
} = require('../helpers/factories');
const db = require('../../src/db/models');

const DAY_MS = 24 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
let phoneSeq = 5200000000;
const nextPhone = () => `01${String(++phoneSeq).slice(-9)}`;

async function setup(name = 'UTM Store') {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, name);
  await db.Workspace.update({ timezone: 'UTC' }, { where: { id: workspace.id } });
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const { variant } = await createProductWithVariant(auth.accessToken, workspace.id, { price: 10000, stock: 500 });
  const placeOrder = async (quantity = 1) => {
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders`)
      .set(H)
      .set('Idempotency-Key', `utm-${Math.random().toString(36).slice(2)}`)
      .send({
        items: [{ variantId: variant.id, quantity }],
        contact: { fullName: 'Buyer', phone: nextPhone() },
        shippingAddress: { country: 'EG', city: 'Giza', addressLine: '2 Utm St' },
        paymentMethod: 'cod',
      });
    if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.order;
  };
  // One storefront visit: a landing page (with its own utm tags, if any) and,
  // when `order` is given, its purchase. `attribution` is what the storefront
  // keeps for the session (lib/visitor.ts) and sends with every batch.
  let visit = 0;
  const visitAndBuy = async ({ attribution = {}, landing = '/', order = null, visitorId } = {}) => {
    visit += 1;
    const events = [{ name: 'page_view', url: landing }];
    if (order) events.push({ name: 'purchase', url: '/thank-you', orderId: order.id });
    const res = await request(app)
      .post(`/api/v1/store/${workspace.id}/events`)
      .set('User-Agent', UA)
      .send({ visitorId: visitorId || `vis-${name}-${visit}`, sessionId: `ses-${name}-${visit}`, attribution, events });
    if (res.status !== 202) throw new Error(`events failed: ${res.status} ${JSON.stringify(res.body)}`);
  };
  const report = (query = {}, token = auth.accessToken, wid = workspace.id) =>
    request(app).get(`/api/v1/workspaces/${wid}/analytics/utm`).set({ Authorization: `Bearer ${token}` }).query(query);
  return { auth, workspace, H, placeOrder, visitAndBuy, report };
}

const rowOf = (report, key, tracked = true) => report.rows.find((r) => r.key === key && r.tracked === tracked);

describe('GET /analytics/utm — attribution', () => {
  it('puts every order in one row: by source, direct, or not tracked', async () => {
    const ctx = await setup();
    const fb1 = await ctx.placeOrder(2);
    const fb2 = await ctx.placeOrder(1);
    const google = await ctx.placeOrder(1);
    const direct = await ctx.placeOrder(1);
    const byHand = await ctx.placeOrder(3);

    await ctx.visitAndBuy({ attribution: { source: 'facebook', medium: 'cpc', campaign: 'launch' }, order: fb1 });
    // Same value, different case and spacing: the same row.
    await ctx.visitAndBuy({ attribution: { source: 'Facebook ', medium: 'cpc', campaign: 'retarget' }, order: fb2 });
    await ctx.visitAndBuy({ attribution: { source: 'facebook', medium: 'cpc', campaign: 'launch' } }); // visited, did not buy
    await ctx.visitAndBuy({ attribution: { source: 'google', medium: 'organic' }, order: google });
    await ctx.visitAndBuy({ order: direct });

    const res = await ctx.report();
    expect(res.status).toBe(200);
    const r = res.body.report;
    expect(r.groupBy).toBe('source');
    expect(r.currency).toBe('EGP');

    expect(rowOf(r, 'facebook')).toMatchObject({
      visitors: 3,
      orders: 2,
      sales: Number(fb1.totalAmount) + Number(fb2.totalAmount),
      conversionRate: 66.7,
    });
    expect(rowOf(r, 'google')).toMatchObject({ visitors: 1, orders: 1, sales: Number(google.totalAmount), conversionRate: 100 });
    expect(rowOf(r, null, true)).toMatchObject({ visitors: 1, orders: 1, sales: Number(direct.totalAmount) });
    // Taken by hand: no purchase event, no visitors, no conversion rate.
    expect(rowOf(r, null, false)).toMatchObject({ visitors: 0, orders: 1, sales: Number(byHand.totalAmount), conversionRate: null });

    // The rows add up to the store's orders and sales.
    const sum = (field) => r.rows.reduce((n, row) => n + row[field], 0);
    expect(sum('orders')).toBe(5);
    expect(r.totals.orders).toBe(5);
    expect(sum('sales')).toBe(r.totals.sales);
    expect(r.totals.visitors).toBe(5);
    expect(r.totals.trackedOrders).toBe(4);
    expect(r.totals.conversionRate).toBe(80);
    // Highest sales first.
    expect(r.rows[0].key).toBe('facebook');
    expect(r.truncated).toBe(false);
    expect(r.series.reduce((n, d) => n + d.orders, 0)).toBe(5);
  });

  it('groups by campaign and drills into one source', async () => {
    const ctx = await setup();
    const a = await ctx.placeOrder();
    const b = await ctx.placeOrder();
    const c = await ctx.placeOrder();
    await ctx.visitAndBuy({ attribution: { source: 'facebook', campaign: 'launch' }, order: a });
    await ctx.visitAndBuy({ attribution: { source: 'facebook', campaign: 'retarget' }, order: b });
    await ctx.visitAndBuy({ attribution: { source: 'tiktok', campaign: 'launch' }, order: c });

    const all = (await ctx.report({ groupBy: 'campaign' })).body.report;
    expect(rowOf(all, 'launch').orders).toBe(2);
    expect(rowOf(all, 'retarget').orders).toBe(1);

    const fb = await ctx.report({ groupBy: 'campaign', source: 'FaceBook' });
    expect(fb.status).toBe(200);
    expect(fb.body.report.filters).toEqual({ source: 'facebook' });
    expect(rowOf(fb.body.report, 'launch')).toMatchObject({ orders: 1, visitors: 1 });
    expect(rowOf(fb.body.report, 'retarget')).toMatchObject({ orders: 1, visitors: 1 });
    expect(fb.body.report.totals.orders).toBe(2);
    // A filtered report has no "not tracked" row: those orders have no source.
    expect(rowOf(fb.body.report, null, false)).toBeUndefined();
  });

  it('takes utm_content from the landing page of the buying session', async () => {
    const ctx = await setup();
    const order = await ctx.placeOrder();
    await ctx.visitAndBuy({
      attribution: { source: 'facebook', campaign: 'launch' },
      landing: '/?utm_source=facebook&utm_campaign=launch&utm_content=video_a',
      order,
    });
    const res = await ctx.report({ groupBy: 'content' });
    expect(res.status).toBe(200);
    expect(rowOf(res.body.report, 'video_a')).toMatchObject({ orders: 1, visitors: 1 });
  });

  it('counts confirmed and delivered orders per row', async () => {
    const ctx = await setup();
    const order = await ctx.placeOrder();
    await ctx.visitAndBuy({ attribution: { source: 'facebook' }, order });
    const confirm = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${order.id}/confirmation`)
      .set(ctx.H)
      .send({});
    expect(confirm.status).toBe(200);
    const shipment = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${order.id}/shipments`)
      .set(ctx.H)
      .send({ carrierCode: 'manual', waybillNumber: 'WB-UTM-1' });
    expect(shipment.status).toBe(201);
    const delivered = await request(app)
      .patch(`/api/v1/workspaces/${ctx.workspace.id}/orders/${order.id}/shipments/${shipment.body.shipment.id}`)
      .set(ctx.H)
      .send({ status: 'delivered' });
    expect(delivered.status).toBe(200);

    const row = rowOf((await ctx.report()).body.report, 'facebook');
    expect(row).toMatchObject({ orders: 1, confirmedOrders: 1, deliveredOrders: 1, deliveredSales: Number(order.totalAmount) });
  });

  it('shows a store with no orders and no visits as an empty report', async () => {
    const ctx = await setup();
    const res = await ctx.report();
    expect(res.status).toBe(200);
    expect(res.body.report.rows).toEqual([]);
    expect(res.body.report.totals).toMatchObject({ visitors: 0, orders: 0, sales: 0, conversionRate: null });
  });
});

describe('GET /analytics/utm — validation and access', () => {
  it('refuses a window longer than 366 days and an unknown grouping', async () => {
    const ctx = await setup();
    const to = new Date();
    const long = await ctx.report({ from: new Date(to.getTime() - 400 * DAY_MS).toISOString(), to: to.toISOString() });
    expect(long.status).toBe(422);
    expect((await ctx.report({ groupBy: 'referrer' })).status).toBe(422);
  });

  it("never mixes in another store's orders or visits", async () => {
    const a = await setup('Store A');
    const b = await setup('Store B');
    const theirs = await b.placeOrder();
    await b.visitAndBuy({ attribution: { source: 'facebook' }, order: theirs });
    const mine = await a.placeOrder();
    await a.visitAndBuy({ attribution: { source: 'google' }, order: mine });

    const r = (await a.report()).body.report;
    expect(r.totals.orders).toBe(1);
    expect(r.totals.visitors).toBe(1);
    expect(rowOf(r, 'facebook')).toBeUndefined();

    expect((await a.report({}, a.auth.accessToken, b.workspace.id)).status).toBe(404);
  });

  it('refuses roles without analytics.view', async () => {
    const ctx = await setup();
    const operator = await addMemberWithRole(ctx.auth.accessToken, ctx.workspace.id, 'order_operator', 'Op');
    expect((await ctx.report({}, operator.accessToken)).status).toBe(403);
    const manager = await addMemberWithRole(ctx.auth.accessToken, ctx.workspace.id, 'workspace_manager', 'Mgr');
    expect((await ctx.report({}, manager.accessToken)).status).toBe(200);
  });
});
