'use strict';

// Control the single DNS lookup. Hoisted above the app require by Jest.
jest.mock('../../src/modules/domains/dnsVerifier', () => ({ lookupTxt: jest.fn() }));
const { lookupTxt } = require('../../src/modules/domains/dnsVerifier');

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');

beforeEach(() => lookupTxt.mockReset());

async function setupStore(name = 'Domain Co') {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, name);
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  // A store must exist (a Website) before a domain can be attached.
  await request(app)
    .post(`/api/v1/workspaces/${workspace.id}/quickstart`)
    .set(H)
    .type('form')
    .send({ productName: 'Domain Widget', price: '30.00' });
  return { auth, workspace, wid: workspace.id, H };
}

const addDomain = (wid, H, hostname = 'ahmedstore.com') =>
  request(app).post(`/api/v1/workspaces/${wid}/domains`).set(H).send({ hostname });

describe('custom domains', () => {
  it('adding a domain starts as pending_verification with a TXT record to add', async () => {
    const { wid, H } = await setupStore();
    const res = await addDomain(wid, H);
    expect(res.status).toBe(201);
    expect(res.body.domain.hostname).toBe('ahmedstore.com');
    expect(res.body.domain.status).toBe('pending_verification');
    expect(res.body.record.type).toBe('TXT');
    expect(res.body.record.value).toMatch(/^storebuilder-verify=[0-9a-f]{32}$/);

    const row = await db.Domain.findOne({ where: { workspaceId: wid, hostname: 'ahmedstore.com' } });
    expect(row.status).toBe('pending_verification');
    expect(row.verificationToken.length).toBe(32);
  });

  it('rejects a second store claiming the same hostname', async () => {
    const a = await setupStore('Store A');
    expect((await addDomain(a.wid, a.H, 'clash.com')).status).toBe(201);
    const b = await setupStore('Store B');
    const res = await addDomain(b.wid, b.H, 'clash.com');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DOMAIN_TAKEN');
  });

  it('verification succeeds only when the TXT record is actually present', async () => {
    const { wid, H } = await setupStore();
    const add = await addDomain(wid, H);
    const domainId = add.body.domain.id;
    const token = add.body.record.value; // "storebuilder-verify=<token>"

    // No record yet -> stays pending, 400.
    lookupTxt.mockResolvedValueOnce([['v=spf1 include:_spf.example.com ~all']]);
    const fail = await request(app).post(`/api/v1/workspaces/${wid}/domains/${domainId}/verify`).set(H);
    expect(fail.status).toBe(400);
    expect(fail.body.error.code).toBe('DOMAIN_NOT_VERIFIED');
    expect((await db.Domain.findByPk(domainId)).status).toBe('pending_verification');

    // DNS not resolvable at all -> also just "not yet".
    lookupTxt.mockRejectedValueOnce(Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' }));
    expect((await request(app).post(`/api/v1/workspaces/${wid}/domains/${domainId}/verify`).set(H)).status).toBe(400);

    // Record present -> verified.
    lookupTxt.mockResolvedValueOnce([['unrelated'], [token]]);
    const ok = await request(app).post(`/api/v1/workspaces/${wid}/domains/${domainId}/verify`).set(H);
    expect(ok.status).toBe(200);
    expect(ok.body.domain.status).toBe('verified');
    const row = await db.Domain.findByPk(domainId);
    expect(row.status).toBe('verified');
    expect(row.verifiedAt).not.toBeNull();
  });

  it('a verified custom domain Host header resolves to that workspace store', async () => {
    const { wid, H, workspace } = await setupStore('Verified Store');
    const add = await addDomain(wid, H, 'myverifiedshop.com');
    const domainId = add.body.domain.id;
    lookupTxt.mockResolvedValueOnce([[add.body.record.value]]);
    await request(app).post(`/api/v1/workspaces/${wid}/domains/${domainId}/verify`).set(H);

    const res = await request(app).get('/').set('Host', 'myverifiedshop.com');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Verified Store');
    expect(res.text).toContain('Domain Widget');
  });

  it('an unverified custom domain Host header shows a "not verified" message, not the store', async () => {
    const { wid, H } = await setupStore('Pending Store');
    await addDomain(wid, H, 'notyet.com');

    const res = await request(app).get('/').set('Host', 'notyet.com');
    expect(res.status).toBe(409);
    expect(res.text).toMatch(/not verified/i);
    expect(res.text).not.toContain('Domain Widget');
  });

  it('an unknown Host header (no Domain row) still falls through untouched', async () => {
    const { wid, H } = await setupStore('Fallthrough Co');
    const health = await request(app).get('/health').set('Host', 'never-added.com');
    expect(health.status).toBe(200);
    const shop = await request(app).get(`/shop/${wid}`).set('Host', 'never-added.com');
    expect(shop.status).toBe(200);
  });
});
