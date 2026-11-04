'use strict';

// REQUEST_TIMING_ENABLED: the request's duration in the log, and Server-Timing
// only to someone entitled to it.

const { app, request, registerAndActivate, createWorkspace, makePlatformUser } = require('../helpers/factories');
const env = require('../../src/config/env');
const logger = require('../../src/core/utils/logger');

const ORIGINAL = { ...env.requestTiming };

afterEach(() => {
  Object.assign(env.requestTiming, ORIGINAL);
  jest.restoreAllMocks();
});

async function store() {
  const owner = await registerAndActivate();
  const workspace = await createWorkspace(owner.accessToken, 'Timed Store');
  return { owner, workspace, H: { Authorization: `Bearer ${owner.accessToken}` } };
}

const timingLines = (spy) => spy.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[timing]'));

describe('with the switch off (the default)', () => {
  it('adds no header and logs nothing', async () => {
    expect(env.requestTiming.enabled).toBe(false);
    const s = await store();
    const spy = jest.spyOn(logger, 'info');
    const res = await request(app).get(`/api/v1/store/${s.workspace.id}`).set('X-Timing-Key', 'anything');
    expect(res.status).toBe(200);
    expect(res.headers['server-timing']).toBeUndefined();
    expect(timingLines(spy)).toEqual([]);
  });
});

describe('with the switch on', () => {
  beforeEach(() => {
    env.requestTiming.enabled = true;
    env.requestTiming.key = 'a-long-enough-timing-key';
  });

  it('logs the route as written, never an id, a slug or a query string', async () => {
    const s = await store();
    const spy = jest.spyOn(logger, 'info');
    await request(app).get(`/api/v1/store/${s.workspace.id}/products?search=secret-word&limit=3`);
    await request(app).get(`/api/v1/store/${s.workspace.slug}/collections`);
    await request(app).get(`/api/v1/workspaces/${s.workspace.id}/access`).set(s.H);
    await request(app).get('/api/v1/no-such-path/abc');
    const lines = timingLines(spy);
    expect(lines).toEqual([
      expect.stringMatching(/^\[timing\] GET \/api\/v1\/store\/:workspaceId\/products 200 \d+ms$/),
      expect.stringMatching(/^\[timing\] GET \/api\/v1\/store\/:workspaceId\/collections 200 \d+ms$/),
      expect.stringMatching(/^\[timing\] GET \/api\/v1\/workspaces\/:workspaceId\/access 200 \d+ms$/),
      expect.stringMatching(/^\[timing\] GET unmatched 404 \d+ms$/),
    ]);
    const all = lines.join(' ');
    for (const secret of [s.workspace.id, s.workspace.slug, 'secret-word', 'no-such-path']) expect(all).not.toContain(secret);
  });

  it('logs only from the least it was told to, when told', async () => {
    env.requestTiming.logMinMs = 600000;
    const s = await store();
    const spy = jest.spyOn(logger, 'info');
    await request(app).get(`/api/v1/store/${s.workspace.id}`);
    expect(timingLines(spy)).toEqual([]);
  });

  it('shows the header to the key and to a platform user, not to a shopper or a merchant', async () => {
    const s = await store();
    const admin = await makePlatformUser('admin');
    const shopper = await request(app).get(`/api/v1/store/${s.workspace.id}`);
    expect(shopper.headers['server-timing']).toBeUndefined();
    const merchant = await request(app).get(`/api/v1/workspaces/${s.workspace.id}/access`).set(s.H);
    expect(merchant.status).toBe(200);
    expect(merchant.headers['server-timing']).toBeUndefined();
    const wrong = await request(app).get(`/api/v1/store/${s.workspace.id}`).set('X-Timing-Key', 'a-long-enough-timing-kex');
    expect(wrong.headers['server-timing']).toBeUndefined();

    const withKey = await request(app).get(`/api/v1/store/${s.workspace.id}`).set('X-Timing-Key', 'a-long-enough-timing-key');
    expect(withKey.headers['server-timing']).toMatch(/^app;dur=\d+\.\d$/);
    const platform = await request(app).get('/api/v1/admin/plans').set(admin.H);
    expect(platform.status).toBe(200);
    expect(platform.headers['server-timing']).toMatch(/^app;dur=\d+\.\d$/);
  });

  it('with no key set, no key opens it', async () => {
    env.requestTiming.key = '';
    const s = await store();
    const res = await request(app).get(`/api/v1/store/${s.workspace.id}`).set('X-Timing-Key', '');
    expect(res.headers['server-timing']).toBeUndefined();
  });
});
