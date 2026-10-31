'use strict';

// Purge-on-publish wired to the changes the storefront shows
// (storefront/storefrontCache.js → storefront/cloudflarePurge.js). Cloudflare
// is a mock of fetch: nothing leaves the machine.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const logger = require('../../src/core/utils/logger');
const { recordAudit } = require('../../src/modules/audit/auditService');
const purge = require('../../src/modules/storefront/cloudflarePurge');

const TOKEN = 'test-only-cloudflare-purge-token-never-real';
const ZONE = 'fedcba9876543210fedcba9876543210';
const CLOUDFLARE = 'https://api.cloudflare.com/';
const purged = () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ success: true, errors: [], result: { id: 'p' } }) });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check, ms = 6000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await sleep(50);
  }
  return check();
}

let purgeStore;
// The workspaces purgeStore was asked for, with their options.
const asked = () => purgeStore.mock.calls.map(([id, opts]) => ({ id, previousSlug: (opts && opts.previousSlug) || null }));

beforeEach(() => {
  purge._reset();
  purgeStore = jest.spyOn(purge, 'purgeStore');
});

afterEach(() => {
  purge._reset();
  jest.restoreAllMocks();
  env.cloudflarePurge.enabled = false;
  env.cloudflarePurge.apiToken = '';
  env.cloudflarePurge.zoneId = '';
});

function turnOn() {
  env.cloudflarePurge.enabled = true;
  env.cloudflarePurge.apiToken = TOKEN;
  env.cloudflarePurge.zoneId = ZONE;
}

/** fetch answering Cloudflare with `answer` and refusing anything else. */
function mockCloudflare(answer = async () => purged()) {
  return jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    if (!String(url).startsWith(CLOUDFLARE)) throw new Error(`unexpected fetch: ${url}`);
    return answer(url, init);
  });
}
const cloudflareCalls = (fetchMock) => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(CLOUDFLARE));
const hostsOf = (fetchMock) => cloudflareCalls(fetchMock).map(([, init]) => JSON.parse(init.body).hosts);

describe('which changes purge the store', () => {
  it('a product, a collection and the store settings, once committed', async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const H = { Authorization: `Bearer ${auth.accessToken}` };
    const base = `/api/v1/workspaces/${workspace.id}`;

    purgeStore.mockClear();
    expect((await request(app).patch(`${base}/catalog/products/${product.id}`).set(H).send({ name: 'Renamed' })).status).toBe(200);
    expect(await eventually(() => purgeStore.mock.calls.length > 0)).toBe(true);
    expect(asked()).toContainEqual({ id: workspace.id, previousSlug: null });

    purgeStore.mockClear();
    expect((await request(app).post(`${base}/catalog/collections`).set(H).send({ name: 'Summer' })).status).toBe(201);
    expect(await eventually(() => purgeStore.mock.calls.length > 0)).toBe(true);

    purgeStore.mockClear();
    expect((await request(app).patch(base).set(H).send({ name: 'New store name', tagline: 'Fresh' })).status).toBe(200);
    expect(await eventually(() => purgeStore.mock.calls.length > 0)).toBe(true);
    expect(asked()).toEqual([{ id: workspace.id, previousSlug: null }]);
  });

  it('a new address: the old one is purged with it', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const oldSlug = (await db.Workspace.findByPk(workspace.id)).slug;
    purgeStore.mockClear();
    const res = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({ slug: `moved-${Date.now()}` });
    expect(res.status).toBe(200);
    expect(asked()).toEqual([{ id: workspace.id, previousSlug: oldSlug }]);
  });

  it('nothing for what shoppers do not see, nor for a change that rolled back', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    // No entity id: the outbox and the console notifications pass these by.
    const base = { workspaceId: workspace.id, actorUserId: auth.userId, entityId: null };
    purgeStore.mockClear();

    await recordAudit({ ...base, action: 'order.update', entityType: 'Order' });
    await recordAudit({ ...base, action: 'customer.update', entityType: 'Customer' });
    await recordAudit({ ...base, action: 'product.export', entityType: 'Product' });
    await recordAudit({ ...base, action: 'review.submit', entityType: 'Review' });
    await recordAudit({ ...base, action: 'media.upload', entityType: 'Media' });
    await recordAudit({ ...base, workspaceId: null, action: 'theme.update', entityType: 'Theme' });
    await db.sequelize
      .transaction(async (transaction) => {
        await recordAudit({ ...base, action: 'product.update', entityType: 'Product', transaction });
        throw new Error('rolled back');
      })
      .catch(() => {});
    expect(purgeStore).not.toHaveBeenCalled();

    // The review published, the blog, a combo, the subscription: yes.
    for (const [action, entityType] of [
      ['review.approve', 'Review'],
      ['blog.post_update', 'BlogPost'],
      ['combo.update', 'ProductCombo'],
      ['subscription.draft_released', 'Subscription'],
      ['theme.activate', 'Workspace'],
      ['website.publish', 'Website'],
    ]) {
      purgeStore.mockClear();
      await recordAudit({ ...base, action, entityType });
      expect(asked()).toEqual([{ id: workspace.id, previousSlug: null }]);
    }
  });
});

describe('end to end, Cloudflare mocked', () => {
  it("a product edit purges the store's host once, after the merchant's answer", async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const slug = (await db.Workspace.findByPk(workspace.id)).slug;
    turnOn();
    const fetchMock = mockCloudflare();

    const H = { Authorization: `Bearer ${auth.accessToken}` };
    for (const price of [1000, 1100, 1200]) {
      const res = await request(app).patch(`/api/v1/workspaces/${workspace.id}/catalog/products/${product.id}`).set(H).send({ name: `Price ${price}` });
      expect(res.status).toBe(200);
    }
    expect(cloudflareCalls(fetchMock)).toHaveLength(0);

    expect(await eventually(() => cloudflareCalls(fetchMock).length > 0)).toBe(true);
    await sleep(300);
    expect(hostsOf(fetchMock)).toEqual([[`${slug}.${env.platformRootDomain}`]]);
    const [url, init] = cloudflareCalls(fetchMock)[0];
    expect(url).toBe(`${CLOUDFLARE}client/v4/zones/${ZONE}/purge_cache`);
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('a new address purges the old host and the new one', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const oldSlug = (await db.Workspace.findByPk(workspace.id)).slug;
    const newSlug = `moved-${Date.now()}`;
    turnOn();
    const fetchMock = mockCloudflare();

    const res = await request(app).patch(`/api/v1/workspaces/${workspace.id}`).set('Authorization', `Bearer ${auth.accessToken}`).send({ slug: newSlug });
    expect(res.status).toBe(200);
    expect(await eventually(() => cloudflareCalls(fetchMock).length > 0)).toBe(true);
    expect(hostsOf(fetchMock).flat().sort()).toEqual([`${newSlug}.${env.platformRootDomain}`, `${oldSlug}.${env.platformRootDomain}`].sort());
  });

  it('Cloudflare down: the merchant still gets their answer at once; a warning follows', async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    turnOn();
    const fetchMock = mockCloudflare(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    const warn = jest.spyOn(logger, 'warn');

    const started = Date.now();
    const res = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/catalog/products/${product.id}`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({ name: 'Still saved' });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(purge.DEBOUNCE_MS);
    expect((await db.Product.findByPk(product.id)).name).toBe('Still saved');

    const failed = () => warn.mock.calls.some(([message]) => String(message).includes('purge failed'));
    expect(await eventually(failed, 8000)).toBe(true);
    expect(cloudflareCalls(fetchMock)).toHaveLength(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(ZONE);
  });

  it('switch off: no request to Cloudflare, whatever the merchant changes', async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    env.cloudflarePurge.apiToken = TOKEN;
    env.cloudflarePurge.zoneId = ZONE;
    const fetchMock = mockCloudflare();
    const H = { Authorization: `Bearer ${auth.accessToken}` };

    expect((await request(app).patch(`/api/v1/workspaces/${workspace.id}/catalog/products/${product.id}`).set(H).send({ name: 'Off' })).status).toBe(200);
    expect((await request(app).patch(`/api/v1/workspaces/${workspace.id}`).set(H).send({ slug: `off-${Date.now()}` })).status).toBe(200);
    expect(purgeStore).toHaveBeenCalled();
    await sleep(purge.DEBOUNCE_MS + 500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
