'use strict';

// The platform admin's read-only courier and payment gateway registry:
// GET /admin/carriers, GET /admin/payment-gateways and their health checks.
// Every probe here runs against a stubbed fetch — nothing leaves the process.

const crypto = require('crypto');
const Joi = require('joi');
const { app, request, registerAndActivate, createWorkspace, setPlatformRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const carriers = require('../../src/modules/shipping/carriers');
const bosta = require('../../src/modules/shipping/carriers/bosta');

const saved = {
  carriers: { ...env.carriers },
  onlineEnabled: env.payments.onlineEnabled,
  gatewayKey: env.payments.credentialsKey,
  paymobBaseUrl: env.payments.paymobBaseUrl,
  fawaterak: { ...env.payments.fawaterak },
};

afterEach(() => {
  Object.assign(env.carriers, saved.carriers);
  env.payments.onlineEnabled = saved.onlineEnabled;
  env.payments.credentialsKey = saved.gatewayKey;
  env.payments.paymobBaseUrl = saved.paymobBaseUrl;
  Object.assign(env.payments.fawaterak, saved.fawaterak);
  jest.restoreAllMocks();
});

const newKey = () => crypto.randomBytes(32).toString('base64');

async function setupAdmin() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Admin Co');
  await setPlatformRole(auth.userId, 'admin');
  return { wid: workspace.id, H: { Authorization: `Bearer ${auth.accessToken}` } };
}

async function anotherWorkspace() {
  const auth = await registerAndActivate();
  return (await createWorkspace(auth.accessToken, 'Other Co')).id;
}

const token = () => crypto.randomBytes(16).toString('hex');

function carrierAccount(workspaceId, carrierCode, status = 'active') {
  return db.CarrierAccount.create({ workspaceId, carrierCode, status, credentialsEncrypted: 'x', webhookToken: token() });
}

function gatewayAccount(workspaceId, providerCode, { status = 'active', mode = 'test' } = {}) {
  return db.PaymentGatewayAccount.create({
    workspaceId,
    providerCode,
    status,
    mode,
    credentialsEncrypted: 'x',
    webhookToken: token(),
  });
}

function stubFetch(impl) {
  return jest.spyOn(global, 'fetch').mockImplementation(impl);
}

describe('provider registry — access', () => {
  it('refuses a non-admin on every route', async () => {
    const auth = await registerAndActivate();
    const H = { Authorization: `Bearer ${auth.accessToken}` };
    const fetchSpy = stubFetch(async () => new Response(null, { status: 200 }));
    expect((await request(app).get('/api/v1/admin/carriers').set(H)).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/payment-gateways').set(H)).status).toBe(403);
    expect((await request(app).post('/api/v1/admin/carriers/bosta/health-check').set(H)).status).toBe(403);
    expect((await request(app).post('/api/v1/admin/payment-gateways/paymob/health-check').set(H)).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('provider registry — carriers', () => {
  it('lists every registered carrier with its rollout as the environment decides it', async () => {
    const admin = await setupAdmin();
    Object.assign(env.carriers, { enabled: ['bosta'], beta: ['mylerz'], betaWorkspaces: ['mj'] });

    const res = await request(app).get('/api/v1/admin/carriers').set(admin.H);
    expect(res.status).toBe(200);
    const byCode = Object.fromEntries(res.body.carriers.map((c) => [c.code, c]));

    expect(byCode.bosta).toMatchObject({ name: 'Bosta', registered: true, rollout: 'enabled' });
    expect(byCode.mylerz.rollout).toBe('beta');
    expect(byCode.mylerz.rolloutDetail).toMatch(/mj/);
    expect(byCode.jtexpress.rollout).toBe('off');
    expect(byCode.jtexpress.capabilities.sandbox).toBe(true);
    expect(byCode.bosta.capabilities).toMatchObject({ cancel: expect.any(String), addressLevels: expect.any(Array) });
    expect(byCode.bosta.healthCheck).toEqual({ checkable: true, target: new URL(bosta.BASE_URL).host });
    expect(res.body.environment).toMatchObject({ enabled: ['bosta'], beta: ['mylerz'], betaWorkspaces: ['mj'] });
  });

  it('reports the rollout without changing it', async () => {
    const admin = await setupAdmin();
    Object.assign(env.carriers, { enabled: [], beta: [], betaWorkspaces: [] });
    const res = await request(app).get('/api/v1/admin/carriers').set(admin.H);
    expect(res.body.carriers.filter((c) => c.registered).every((c) => c.rollout === 'off')).toBe(true);
    expect(carriers.listAdapters()).toEqual([]);
  });

  it('counts connected workspaces and active/invalid accounts, including accounts whose adapter is gone', async () => {
    const admin = await setupAdmin();
    const other = await anotherWorkspace();
    await carrierAccount(admin.wid, 'bosta', 'active');
    await carrierAccount(other, 'bosta', 'invalid');
    await carrierAccount(other, 'retiredcarrier', 'active');

    const res = await request(app).get('/api/v1/admin/carriers').set(admin.H);
    const byCode = Object.fromEntries(res.body.carriers.map((c) => [c.code, c]));
    expect(byCode.bosta.connections).toEqual({ workspaces: 2, active: 1, invalid: 1 });
    expect(byCode.mylerz.connections).toEqual({ workspaces: 0, active: 0, invalid: 0 });
    expect(byCode.retiredcarrier).toMatchObject({
      registered: false,
      rollout: 'off',
      capabilities: null,
      connections: { workspaces: 1, active: 1, invalid: 0 },
      healthCheck: { checkable: false, target: null },
    });
  });

  it('states whether the carrier credentials key is present, never the key', async () => {
    const admin = await setupAdmin();
    env.carriers.credentialsKey = '';
    expect((await request(app).get('/api/v1/admin/carriers').set(admin.H)).body.environment.credentialsKey).toBe('missing');
    env.carriers.credentialsKey = 'too-short';
    expect((await request(app).get('/api/v1/admin/carriers').set(admin.H)).body.environment.credentialsKey).toBe('invalid');
    const key = newKey();
    env.carriers.credentialsKey = key;
    const res = await request(app).get('/api/v1/admin/carriers').set(admin.H);
    expect(res.body.environment.credentialsKey).toBe('present');
    expect(JSON.stringify(res.body)).not.toContain(key);
  });

  it('health-checks reachability with one unauthenticated GET — any HTTP answer is up', async () => {
    const admin = await setupAdmin();
    await carrierAccount(admin.wid, 'bosta');
    const auditBefore = await db.AuditLog.count();
    const fetchSpy = stubFetch(async () => new Response('{"message":"Unauthorized"}', { status: 401 }));

    const res = await request(app).post('/api/v1/admin/carriers/bosta/health-check').set(admin.H);
    expect(res.status).toBe(200);
    expect(res.body.check).toMatchObject({
      code: 'bosta',
      status: 'operational',
      httpStatus: 401,
      target: new URL(bosta.BASE_URL).host,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(bosta.BASE_URL);
    expect(init.method).toBe('GET');
    // No merchant's credentials, nor anything else of ours but a user agent.
    expect(Object.keys(init.headers).map((h) => h.toLowerCase()).sort()).toEqual(['accept', 'user-agent']);
    // A check is not a write.
    expect(await db.AuditLog.count()).toBe(auditBefore);
  });

  it('reads a 5xx as degraded and no answer as down', async () => {
    const admin = await setupAdmin();
    stubFetch(async () => new Response(null, { status: 503 }));
    const degraded = await request(app).post('/api/v1/admin/carriers/mylerz/health-check').set(admin.H);
    expect(degraded.body.check).toMatchObject({ status: 'degraded', httpStatus: 503 });

    jest.restoreAllMocks();
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const down = await request(app).post('/api/v1/admin/carriers/jtexpress/health-check').set(admin.H);
    expect(down.body.check).toMatchObject({ status: 'down', httpStatus: null, target: 'openapi.jtjms-eg.com' });
  });

  it('marks a carrier with no known API host not_checkable instead of guessing', async () => {
    const admin = await setupAdmin();
    const remove = carriers.registerTestAdapter({
      code: 'nohost',
      name: 'No Host',
      credentialsSchema: Joi.object(),
      settingsSchema: Joi.object(),
      credentialFields: [],
      settingFields: [],
      verifyCredentials: async () => ({}),
      createShipment: async () => ({}),
      getShipment: async () => ({}),
      cancelShipment: async () => {},
      listCities: async () => [],
    });
    try {
      const fetchSpy = stubFetch(async () => new Response(null, { status: 200 }));
      const res = await request(app).post('/api/v1/admin/carriers/nohost/health-check').set(admin.H);
      expect(res.body.check).toMatchObject({ code: 'nohost', status: 'not_checkable', target: null });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      remove();
    }
  });

  it('404s an unknown carrier and 422s a malformed code', async () => {
    const admin = await setupAdmin();
    expect((await request(app).post('/api/v1/admin/carriers/nosuch/health-check').set(admin.H)).status).toBe(404);
    expect((await request(app).post('/api/v1/admin/carriers/NO%20SUCH/health-check').set(admin.H)).status).toBe(422);
  });
});

describe('provider registry — payment gateways', () => {
  it('lists each gateway with its capabilities and the server-wide availability', async () => {
    const admin = await setupAdmin();
    env.payments.credentialsKey = newKey();
    env.payments.onlineEnabled = true;

    const res = await request(app).get('/api/v1/admin/payment-gateways').set(admin.H);
    expect(res.status).toBe(200);
    const byCode = Object.fromEntries(res.body.gateways.map((g) => [g.code, g]));
    expect(Object.keys(byCode).sort()).toEqual(['fawaterak', 'kashier', 'paymob']);
    expect(byCode.paymob).toMatchObject({
      name: expect.any(String),
      registered: true,
      availability: 'enabled',
      capabilities: { refunds: true, statusInquiry: true, methods: expect.arrayContaining(['card']) },
    });
    expect(res.body.environment).toEqual({ onlineEnabled: true, credentialsKey: 'present' });
  });

  it('shows Fawaterak\'s own switch: off, for the beta stores only, then for every store', async () => {
    const admin = await setupAdmin();
    env.payments.credentialsKey = newKey();
    env.payments.onlineEnabled = true;
    const fawaterak = async () =>
      (await request(app).get('/api/v1/admin/payment-gateways').set(admin.H)).body.gateways.find((g) => g.code === 'fawaterak');

    env.payments.fawaterak.enabled = false;
    let row = await fawaterak();
    expect(row).toMatchObject({ availability: 'off', capabilities: { methods: ['card'], currencies: ['EGP'] } });
    expect(row.availabilityDetail).toMatch(/PAYMENTS_FAWATERAK_ENABLED is off/);
    expect(row.healthCheck).toEqual({ checkable: true, target: 'app.fawaterk.com' });

    Object.assign(env.payments.fawaterak, { enabled: true, betaWorkspaces: ['shop-a', 'shop-b'] });
    row = await fawaterak();
    expect(row.availability).toBe('enabled');
    expect(row.availabilityDetail).toMatch(/PAYMENTS_FAWATERAK_BETA_WORKSPACES see Fawaterak: shop-a, shop-b/);

    env.payments.fawaterak.betaWorkspaces = [];
    row = await fawaterak();
    expect(row.availabilityDetail).not.toMatch(/FAWATERAK/);
  });

  it('distinguishes connect-only (online payments off) from off (no key)', async () => {
    const admin = await setupAdmin();
    env.payments.credentialsKey = newKey();
    env.payments.onlineEnabled = false;
    const connectOnly = await request(app).get('/api/v1/admin/payment-gateways').set(admin.H);
    expect(connectOnly.body.gateways[0].availability).toBe('connect_only');

    env.payments.credentialsKey = '';
    env.payments.onlineEnabled = true;
    const off = await request(app).get('/api/v1/admin/payment-gateways').set(admin.H);
    expect(off.body.gateways.every((g) => g.availability === 'off')).toBe(true);
    expect(off.body.gateways[0].availabilityDetail).toMatch(/GATEWAY_CREDENTIALS_KEY/);
    expect(off.body.environment.credentialsKey).toBe('missing');
  });

  it('counts connections by status and mode', async () => {
    const admin = await setupAdmin();
    const other = await anotherWorkspace();
    await gatewayAccount(admin.wid, 'paymob', { mode: 'live' });
    await gatewayAccount(other, 'paymob', { mode: 'test', status: 'invalid' });
    await gatewayAccount(other, 'kashier', { mode: 'test' });

    const res = await request(app).get('/api/v1/admin/payment-gateways').set(admin.H);
    const byCode = Object.fromEntries(res.body.gateways.map((g) => [g.code, g]));
    expect(byCode.paymob.connections).toEqual({ workspaces: 2, active: 1, invalid: 1, live: 1, test: 1 });
    expect(byCode.kashier.connections).toEqual({ workspaces: 1, active: 1, invalid: 0, live: 0, test: 1 });
  });

  it('probes the configured API host without any account', async () => {
    const admin = await setupAdmin();
    env.payments.paymobBaseUrl = 'https://accept.paymob.example';
    const auditBefore = await db.AuditLog.count();
    const fetchSpy = stubFetch(async () => new Response(null, { status: 404 }));

    const res = await request(app).post('/api/v1/admin/payment-gateways/paymob/health-check').set(admin.H);
    expect(res.body.check).toMatchObject({ code: 'paymob', status: 'operational', httpStatus: 404, target: 'accept.paymob.example' });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://accept.paymob.example');

    const kashier = await request(app).post('/api/v1/admin/payment-gateways/kashier/health-check').set(admin.H);
    expect(kashier.body.check.target).toBe(new URL(env.payments.kashier.liveApiUrl).host);
    expect(await db.AuditLog.count()).toBe(auditBefore);
  });

  it('404s an unknown gateway', async () => {
    const admin = await setupAdmin();
    expect((await request(app).post('/api/v1/admin/payment-gateways/mock/health-check').set(admin.H)).status).toBe(404);
  });
});
