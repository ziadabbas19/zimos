'use strict';

// GET /analytics/overview — the dashboard home: a window against the one
// before it. Numbers from real orders and events only; who may read them;
// one store never sees another's; the 366-day ceiling; the short cache.

const {
  app,
  request,
  registerAndActivate,
  createWorkspace,
  createProductWithVariant,
  addMemberWithRole,
} = require('../helpers/factories');
const db = require('../../src/db/models');
const { clearOverviewCache } = require('../../src/modules/analytics/overviewService');

const DAY_MS = 24 * 60 * 60 * 1000;
let phoneSeq = 5100000000;
const nextPhone = () => `01${String(++phoneSeq).slice(-9)}`;

async function setup(name = 'Home Store') {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, name);
  // UTC so the day buckets in the assertions are plain dates.
  await db.Workspace.update({ timezone: 'UTC' }, { where: { id: workspace.id } });
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const { variant } = await createProductWithVariant(auth.accessToken, workspace.id, { price: 10000, stock: 500 });
  const placeOrder = async ({ quantity = 1, paymentMethod = 'cod', phone = nextPhone() } = {}) => {
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders`)
      .set(H)
      .set('Idempotency-Key', `home-${Math.random().toString(36).slice(2)}`)
      .send({
        items: [{ variantId: variant.id, quantity }],
        contact: { fullName: 'Buyer', phone },
        shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Home St' },
        paymentMethod,
      });
    if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.order;
  };
  const overview = (query = {}, token = auth.accessToken, wid = workspace.id) =>
    request(app).get(`/api/v1/workspaces/${wid}/analytics/overview`).set({ Authorization: `Bearer ${token}` }).query(query);
  return { auth, workspace, H, placeOrder, overview };
}

/** Moves an order (and its customer) back in time, as if placed `daysAgo` days ago. */
async function backdate(order, daysAgo) {
  const at = new Date(Date.now() - daysAgo * DAY_MS);
  await db.sequelize.query('UPDATE orders SET created_at = :at WHERE id = :id', { replacements: { at, id: order.id } });
  await db.sequelize.query('UPDATE customers SET created_at = :at WHERE id = :id', { replacements: { at, id: order.customerId } });
}

const window7 = () => {
  const to = new Date();
  return { from: new Date(to.getTime() - 7 * DAY_MS).toISOString(), to: to.toISOString() };
};

beforeEach(() => clearOverviewCache());

describe('GET /analytics/overview — numbers', () => {
  it('reports the window against the one before it, from real orders only', async () => {
    const ctx = await setup();
    // Current window: two orders of 2 units (20000 each), one cancelled.
    const a = await ctx.placeOrder({ quantity: 2 });
    const b = await ctx.placeOrder({ quantity: 2 });
    const cancelled = await ctx.placeOrder({ quantity: 1 });
    const cancel = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${cancelled.id}/cancel`)
      .set(ctx.H)
      .send({ reason: 'Customer changed their mind' });
    expect(cancel.status).toBe(200);
    // Previous window: one order of 1 unit, 10 days ago.
    const old = await ctx.placeOrder({ quantity: 1 });
    await backdate(old, 10);

    const res = await ctx.overview(window7());
    expect(res.status).toBe(200);
    const { overview } = res.body;
    expect(overview.currency).toBe('EGP');
    expect(overview.range.timeZone).toBe('UTC');
    expect(overview.previousRange).not.toBeNull();

    expect(overview.metrics.orders).toEqual({ value: 3, previous: 1 });
    expect(overview.metrics.cancelledOrders).toEqual({ value: 1, previous: 0 });
    expect(overview.metrics.sales.value).toBe(Number(a.totalAmount) + Number(b.totalAmount));
    expect(overview.metrics.sales.previous).toBe(Number(old.totalAmount));
    expect(overview.metrics.averageOrderValue.value).toBe(Math.round((Number(a.totalAmount) + Number(b.totalAmount)) / 2));
    // Nobody visited the storefront: no sessions, so no conversion rate (not 0%).
    expect(overview.metrics.sessions).toEqual({ value: 0, previous: 0 });
    expect(overview.metrics.conversionRate).toEqual({ value: null, previous: null });
    // No COD call ended yet: no confirmation rate.
    expect(overview.metrics.confirmationRate.value).toBeNull();

    // A continuous axis: every day of the window, today included, zeros where nothing happened.
    expect(overview.series.length).toBeGreaterThanOrEqual(7);
    const today = new Date().toISOString().slice(0, 10);
    const todayRow = overview.series.find((d) => d.date === today);
    expect(todayRow).toMatchObject({ orders: 3, sales: overview.metrics.sales.value });
    expect(overview.series.reduce((n, d) => n + d.orders, 0)).toBe(3);
    expect(overview.previousSeries.reduce((n, d) => n + d.orders, 0)).toBe(1);

    // Line totals of the orders not cancelled: 4 units at 10000.
    expect(overview.topProducts).toEqual([expect.objectContaining({ name: 'Test Product', quantity: 4, sales: 40000 })]);
  });

  it('leaves a prepaid order that was never paid out of orders and sales', async () => {
    const ctx = await setup();
    await ctx.placeOrder({ paymentMethod: 'cod' });
    await ctx.placeOrder({ paymentMethod: 'card' });
    const res = await ctx.overview(window7());
    expect(res.status).toBe(200);
    expect(res.body.overview.metrics.orders.value).toBe(1);
  });

  it('counts confirmations, deliveries, sessions, conversion and new against returning buyers', async () => {
    const ctx = await setup();
    const phone = nextPhone();
    const first = await ctx.placeOrder({ phone });
    await backdate(first, 20); // the customer's first order, long before the window
    const again = await ctx.placeOrder({ phone }); // returning buyer
    const fresh = await ctx.placeOrder(); // new buyer
    const confirm = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${again.id}/confirmation`)
      .set(ctx.H)
      .send({});
    expect(confirm.status).toBe(200);

    // Two storefront sessions, one of which bought `fresh`.
    const post = (body) =>
      request(app)
        .post(`/api/v1/store/${ctx.workspace.id}/events`)
        .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36')
        .send(body);
    expect((await post({ visitorId: 'v-home-1', sessionId: 's-home-1', events: [{ name: 'page_view', path: '/' }] })).status).toBe(202);
    expect(
      (
        await post({
          visitorId: 'v-home-2',
          sessionId: 's-home-2',
          events: [
            { name: 'page_view', path: '/' },
            { name: 'purchase', path: '/thank-you', orderId: fresh.id },
          ],
        })
      ).status
    ).toBe(202);

    const res = await ctx.overview(window7());
    const m = res.body.overview.metrics;
    expect(m.orders.value).toBe(2);
    expect(m.newCustomers.value).toBe(1);
    expect(m.returningCustomers.value).toBe(1);
    expect(m.confirmationRate.value).toBe(100);
    expect(m.sessions.value).toBe(2);
    expect(m.conversionRate.value).toBe(50);
    expect(m.deliveryRate.value).toBeNull();
  });

  it('answers compare=none without a previous window', async () => {
    const ctx = await setup();
    const res = await ctx.overview({ ...window7(), compare: 'none' });
    expect(res.status).toBe(200);
    expect(res.body.overview.previousRange).toBeNull();
    expect(res.body.overview.previousSeries).toBeNull();
    expect(res.body.overview.metrics.orders).toEqual({ value: 0, previous: null });
  });

  it('shows an empty store as zeros and nulls, never invented numbers', async () => {
    const ctx = await setup();
    const res = await ctx.overview();
    expect(res.status).toBe(200);
    const m = res.body.overview.metrics;
    expect(m.orders).toEqual({ value: 0, previous: 0 });
    expect(m.sales).toEqual({ value: 0, previous: 0 });
    expect(m.averageOrderValue).toEqual({ value: 0, previous: 0 });
    expect(m.conversionRate).toEqual({ value: null, previous: null });
    expect(res.body.overview.topProducts).toEqual([]);
    // Without dates: the last 30 days.
    const span = new Date(res.body.overview.range.to) - new Date(res.body.overview.range.from);
    expect(span).toBe(30 * DAY_MS);
  });
});

describe('GET /analytics/overview — range', () => {
  it('refuses a window longer than 366 days', async () => {
    const ctx = await setup();
    const to = new Date();
    const res = await ctx.overview({ from: new Date(to.getTime() - 367 * DAY_MS).toISOString(), to: to.toISOString() });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts exactly 366 days', async () => {
    const ctx = await setup();
    const to = new Date(Math.floor(Date.now() / 60000) * 60000);
    const res = await ctx.overview({ from: new Date(to.getTime() - 366 * DAY_MS).toISOString(), to: to.toISOString() });
    expect(res.status).toBe(200);
  });

  it('refuses from after to', async () => {
    const ctx = await setup();
    const to = new Date();
    const res = await ctx.overview({ from: to.toISOString(), to: new Date(to.getTime() - DAY_MS).toISOString() });
    expect(res.status).toBe(422);
  });
});

describe('GET /analytics/overview — access', () => {
  it("never counts another store's orders, and refuses a non-member", async () => {
    const a = await setup('Store A');
    const b = await setup('Store B');
    await b.placeOrder();
    await b.placeOrder();
    await a.placeOrder();

    const res = await a.overview(window7());
    expect(res.body.overview.metrics.orders.value).toBe(1);

    // A's owner asking for B's numbers: not a member of B.
    const cross = await a.overview(window7(), a.auth.accessToken, b.workspace.id);
    expect(cross.status).toBe(404);
  });

  it('refuses roles without analytics.view and serves the ones that have it', async () => {
    const ctx = await setup();
    for (const roleKey of ['editor', 'order_operator', 'confirmation_agent']) {
      const member = await addMemberWithRole(ctx.auth.accessToken, ctx.workspace.id, roleKey, roleKey);
      const res = await ctx.overview({}, member.accessToken);
      expect([roleKey, res.status]).toEqual([roleKey, 403]);
    }
    const accountant = await addMemberWithRole(ctx.auth.accessToken, ctx.workspace.id, 'accountant', 'Acc');
    expect((await ctx.overview({}, accountant.accessToken)).status).toBe(200);
  });

  it('needs a signed-in user', async () => {
    const ctx = await setup();
    const res = await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/analytics/overview`);
    expect(res.status).toBe(401);
  });
});

describe('GET /analytics/overview — short cache', () => {
  it('serves the same answer for the same window within the minute, per store', async () => {
    const ctx = await setup();
    const range = window7();
    const first = await ctx.overview(range);
    await ctx.placeOrder();
    const second = await ctx.overview(range);
    expect(second.body.overview.generatedAt).toBe(first.body.overview.generatedAt);
    expect(second.body.overview.metrics.orders.value).toBe(0);

    // Another store asking for the very same window gets its own numbers.
    const other = await setup('Other Store');
    await other.placeOrder();
    await other.placeOrder();
    const theirs = await other.overview(range);
    expect(theirs.body.overview.metrics.orders.value).toBe(2);

    clearOverviewCache();
    const fresh = await ctx.overview(range);
    expect(fresh.body.overview.metrics.orders.value).toBe(1);
  });
});
