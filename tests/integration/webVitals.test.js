'use strict';

// POST /store/:workspaceId/vitals (WEB_VITALS_ENABLED): a store page's Core Web Vitals, nothing about the visitor.

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { run: retention, schedules } = require('../../src/modules/webVitals/jobs');
const routes = require('../../src/modules/webVitals/webVitalsRoutes');

const ORIGINAL = { ...env.webVitals };
const BODY = { route: 'home', device: 'mobile', metrics: [{ name: 'LCP', value: 2100.5 }, { name: 'CLS', value: 0.04 }] };

async function store() {
  const owner = await registerAndActivate();
  return (await createWorkspace(owner.accessToken, 'Measured Store')).id;
}
const rows = (workspaceId) =>
  db.sequelize.query('SELECT * FROM store_web_vitals WHERE workspace_id = :workspaceId ORDER BY metric', {
    replacements: { workspaceId },
    type: db.Sequelize.QueryTypes.SELECT,
  });
const post = (id, body = BODY) => request(app).post(`/api/v1/store/${id}/vitals`).send(body);
const settled = () => new Promise((resolve) => setTimeout(resolve, 150));

beforeEach(async () => {
  await db.sequelize.query('TRUNCATE store_web_vitals');
});

afterEach(() => {
  Object.assign(env.webVitals, ORIGINAL);
});

describe('with the switch off (the default)', () => {
  it('answers 404, reads and writes nothing, and schedules nothing', async () => {
    expect(env.webVitals.enabled).toBe(false);
    const id = await store();
    const res = await post(id);
    expect(res.status).toBe(404);
    await settled();
    expect(await rows(id)).toEqual([]);
    expect(schedules).toEqual([]);
  });
});

describe('with the switch on', () => {
  beforeEach(() => {
    env.webVitals.enabled = true;
  });

  it('keeps the metrics under the store, with nothing about the visitor', async () => {
    const id = await store();
    const res = await post(id);
    expect(res.status).toBe(204);
    await settled();
    const saved = await rows(id);
    expect(saved.map((r) => [r.metric, r.value, r.route_kind, r.device_class])).toEqual([
      ['CLS', 0.04, 'home', 'mobile'],
      ['LCP', 2100.5, 'home', 'mobile'],
    ]);
    expect(Object.keys(saved[0]).sort()).toEqual(['created_at', 'device_class', 'id', 'metric', 'route_kind', 'value', 'workspace_id']);
  });

  it('takes a beacon sent as plain text, which needs no preflight', async () => {
    const id = await store();
    const res = await request(app).post(`/api/v1/store/${id}/vitals`).set('Content-Type', 'text/plain').send(JSON.stringify(BODY));
    expect(res.status).toBe(204);
    await settled();
    expect(await rows(id)).toHaveLength(2);
  });

  it.each([
    ['an unknown metric', { ...BODY, metrics: [{ name: 'FID', value: 1 }] }],
    ['a negative value', { ...BODY, metrics: [{ name: 'LCP', value: -1 }] }],
    ['no metrics', { ...BODY, metrics: [] }],
    ['too many metrics', { ...BODY, metrics: Array.from({ length: 5 }, () => ({ name: 'LCP', value: 1 })) }],
    ['an unknown route', { ...BODY, route: '/products/secret' }],
    ['an unknown device', { ...BODY, device: 'fridge' }],
  ])('refuses %s', async (_name, body) => {
    const id = await store();
    const res = await post(id, body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    await settled();
    expect(await rows(id)).toEqual([]);
  });

  it('leaves out anything else sent with it', async () => {
    const id = await store();
    const res = await post(id, { ...BODY, url: 'https://shop/secret', visitorId: 'v1', metrics: [{ name: 'LCP', value: 10, id: 'x' }] });
    expect(res.status).toBe(204);
    await settled();
    expect(await rows(id)).toHaveLength(1);
    expect(JSON.stringify(await rows(id))).not.toContain('secret');
  });

  it('drops a value past what a metric can be, keeping the rest', async () => {
    const id = await store();
    await post(id, { ...BODY, metrics: [{ name: 'LCP', value: 999999999 }, { name: 'TTFB', value: 120 }] });
    await settled();
    expect((await rows(id)).map((r) => r.metric)).toEqual(['TTFB']);
  });

  it('an unknown store is the beacon\'s loss: still 204, nothing kept, nothing thrown', async () => {
    const res = await post('00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(204);
    await settled();
    const [{ n }] = await db.sequelize.query('SELECT count(*)::int AS n FROM store_web_vitals', { type: db.Sequelize.QueryTypes.SELECT });
    expect(n).toBe(0);
  });

  it('a store address that is not an id is refused without a query', async () => {
    const res = await post('not-a-uuid');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('refuses a body past its small limit', async () => {
    const id = await store();
    const res = await post(id, { ...BODY, padding: 'x'.repeat(4000) });
    expect(res.status).toBe(400);
  });

  it('old rows go after the retention days, new ones stay', async () => {
    const id = await store();
    await routes.save(id, BODY);
    await db.sequelize.query("UPDATE store_web_vitals SET created_at = now() - interval '40 days' WHERE metric = 'LCP'");
    const { removed } = await retention({ days: 30 });
    expect(removed).toBe(1);
    expect((await rows(id)).map((r) => r.metric)).toEqual(['CLS']);
  });
});
