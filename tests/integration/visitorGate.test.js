'use strict';

// A store's visitor blocks (risk/visitorGate, called by resolvePublicWorkspace
// with VISITOR_GATE_ENABLED): an IP blocked with scope "visit" sees the store
// as unavailable on every public route; the store's blocked countries only
// once an IP lookup answers.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const env = require('../../src/config/env');
const ipIntel = require('../../src/modules/risk/ipIntel');
const visitorGate = require('../../src/modules/risk/visitorGate');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

afterEach(() => {
  env.visitorGate.enabled = false;
  env.ipRules.ipv6Prefix = false;
  delete process.env.IP_INTEL_PROVIDER;
  jest.restoreAllMocks();
});

const page = (ctx, ip, headers = {}) =>
  request(app).get(`/api/v1/store/${ctx.workspace.id}/checkout/guard`).set('X-Forwarded-For', ip).set(headers);

async function blockVisit(ctx, value) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${ctx.workspace.id}/fraud/blocklist`)
    .set(bearer(ctx.auth.accessToken))
    .send({ type: 'ip', value, scopes: ['visit'] });
  if (res.status !== 201) throw new Error(`block failed: ${res.status} ${JSON.stringify(res.body)}`);
}

describe('VISITOR_GATE_ENABLED', () => {
  it('off: a visit-blocked IP still sees the store, as before', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 1 });
    await blockVisit(ctx, '203.0.113.80');
    expect((await page(ctx, '203.0.113.80')).status).toBe(200);
  });

  it('on: the blocked IP gets 423 STORE_UNAVAILABLE with the store card; anyone else is served', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 1 });
    await blockVisit(ctx, '203.0.113.81');
    env.visitorGate.enabled = true;

    const refused = await page(ctx, '203.0.113.81');
    expect(refused.status).toBe(423);
    expect(refused.body.error.code).toBe('STORE_UNAVAILABLE');
    expect(refused.body.error.details.store).toMatchObject({ name: expect.any(String) });
    // Every public route, the checkout too.
    const checkout = await request(app)
      .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
      .set('X-Forwarded-For', '203.0.113.81')
      .set('Idempotency-Key', `vg-${Date.now()}`)
      .send({ item: { variantId: ctx.variant.id, quantity: 1 }, contact: { fullName: 'Blocked Visitor', phone: '01055550000' }, paymentMethod: 'cod' });
    expect(checkout.status).toBe(423);

    expect((await page(ctx, '203.0.113.82')).status).toBe(200);
  });

  it('a block added from the dashboard acts at once (the cache is cleared); removing it lets the visitor back', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 1 });
    env.visitorGate.enabled = true;
    expect((await page(ctx, '203.0.113.83')).status).toBe(200);
    await blockVisit(ctx, '203.0.113.83');
    expect((await page(ctx, '203.0.113.83')).status).toBe(423);

    const list = await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/fraud/blocklist`).set(bearer(ctx.auth.accessToken));
    const entry = list.body.entries.find((e) => e.value === '203.0.113.83');
    await request(app).delete(`/api/v1/workspaces/${ctx.workspace.id}/fraud/blocklist/${entry.id}`).set(bearer(ctx.auth.accessToken));
    expect((await page(ctx, '203.0.113.83')).status).toBe(200);
  });

  it("a staff preview of a draft store is never refused", async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 1 });
    await blockVisit(ctx, '203.0.113.84');
    env.visitorGate.enabled = true;
    const blocked = { headers: { 'x-forwarded-for': '203.0.113.84' }, ip: '203.0.113.84' };
    await expect(visitorGate.refuseBlockedVisitor(blocked, ctx.workspace)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    await expect(visitorGate.refuseBlockedVisitor({ ...blocked, draftPreview: true }, ctx.workspace)).resolves.toBeUndefined();
  });

  it("blocked countries act only once an IP lookup answers", async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 1 });
    await request(app)
      .patch(`/api/v1/workspaces/${ctx.workspace.id}`)
      .set(bearer(ctx.auth.accessToken))
      .send({ settings: { fraud_rules: { blocked_countries: ['DE'] } } })
      .expect(200);
    env.visitorGate.enabled = true;
    expect((await page(ctx, '198.51.100.110')).status).toBe(200);

    ipIntel.registerAdapter({ name: 'test-countries', lookup: async () => ({ country: 'DE' }) });
    process.env.IP_INTEL_PROVIDER = 'test-countries';
    visitorGate.forgetWorkspace(ctx.workspace.id);
    expect((await page(ctx, '198.51.100.111')).status).toBe(423);
  });

  it('with IPV6_PREFIX_RULES_ENABLED a blocked IPv6 address blocks its /64', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 1 });
    await blockVisit(ctx, '2001:db8:aa:bb::1');
    env.visitorGate.enabled = true;
    expect((await page(ctx, '2001:db8:aa:bb::2')).status).toBe(200);

    env.ipRules.ipv6Prefix = true;
    visitorGate.forgetWorkspace(ctx.workspace.id);
    expect((await page(ctx, '2001:db8:aa:bb:1234::9')).status).toBe(423);
    expect((await page(ctx, '2001:db8:aa:bc::1')).status).toBe(200);
  });
});
