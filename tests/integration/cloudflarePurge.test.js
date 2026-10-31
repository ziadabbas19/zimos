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

describe('writes outside the audit log', () => {
  afterEach(() => {
    env.storeFeatures.length = 0;
    env.customDomains.enabled = false;
    delete process.env.CERTIFICATE_PROVIDER;
    env.customDomains.cloudflare.apiToken = '';
    env.customDomains.cloudflare.zoneId = '';
  });

  it('an order that sells the last unit or gives one back purges; any other order does not', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 2 });
    const inventory = require('../../src/modules/inventory/inventoryService');
    const move = (quantity) => ({ workspaceId: workspace.id, variantId: variant.id, quantity, referenceType: 'order_pending', referenceId: null, actorUserId: auth.userId });
    purgeStore.mockClear();

    await inventory.reserve(move(1)); // 2 → 1 left: still in stock
    expect(purgeStore).not.toHaveBeenCalled();
    await inventory.reserve(move(1)); // 1 → 0: sold out
    expect(asked()).toEqual([{ id: workspace.id, previousSlug: null }]);

    purgeStore.mockClear();
    await inventory.commit(move(1)); // the sale goes through: still 0 left
    expect(purgeStore).not.toHaveBeenCalled();
    await inventory.release(move(1)); // a cancelled order gives its unit back
    expect(asked()).toEqual([{ id: workspace.id, previousSlug: null }]);

    // Stock the merchant adds: always.
    purgeStore.mockClear();
    await inventory.restock({ workspaceId: workspace.id, variantId: variant.id, quantity: 5, reason: 'delivery', actorUserId: auth.userId });
    expect(asked()).toEqual([{ id: workspace.id, previousSlug: null }]);
  });

  it('a size chart, an answered question and a redirect edited or deleted', async () => {
    env.storeFeatures.push('size_charts', 'product_questions', 'url_redirects');
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const H = { Authorization: `Bearer ${auth.accessToken}` };
    const base = `/api/v1/workspaces/${workspace.id}`;
    const chart = { name: 'Shirts', unit: 'cm', columns: [{ ar: 'المقاس', en: 'Size' }], rows: [['S'], ['M']], productIds: [product.id], collectionIds: [] };
    const purgedOnce = async (res, status) => {
      expect(res.status).toBe(status);
      expect(asked()).toEqual([{ id: workspace.id, previousSlug: null }]);
      purgeStore.mockClear();
    };

    const created = await request(app).post(`${base}/size-charts`).set(H).send(chart);
    expect(created.status).toBe(201);
    purgeStore.mockClear();
    await purgedOnce(await request(app).put(`${base}/size-charts/${created.body.id}`).set(H).send({ ...chart, unit: 'inch' }), 200);
    await purgedOnce(await request(app).delete(`${base}/size-charts/${created.body.id}`).set(H), 204);

    const question = await db.ProductQuestion.create({ workspaceId: workspace.id, productId: product.id, question: 'Cotton?', answer: 'Yes', status: 'published' });
    purgeStore.mockClear();
    await purgedOnce(await request(app).delete(`${base}/product-questions/${question.id}`).set(H), 204);

    const redirect = await request(app).post(`${base}/redirects`).set(H).send({ fromPath: '/old', toPath: '/new' });
    expect(redirect.status).toBe(201);
    purgeStore.mockClear();
    await purgedOnce(await request(app).put(`${base}/redirects/${redirect.body.redirect.id}`).set(H).send({ fromPath: '/old', toPath: '/newer', statusCode: 302 }), 200);
    await purgedOnce(await request(app).delete(`${base}/redirects/${redirect.body.redirect.id}`).set(H), 204);
  });

  it("the domains job purges a store whose domain changed state, not one still waiting for its certificate", async () => {
    env.customDomains.enabled = true;
    process.env.CERTIFICATE_PROVIDER = 'cloudflare';
    env.customDomains.cloudflare.apiToken = 'test-only-cloudflare-token';
    env.customDomains.cloudflare.zoneId = '0123456789abcdef0123456789abcdef';
    const site = async () => {
      const { workspace } = await setupWorkspaceWithProduct();
      const website = await db.Website.create({ workspaceId: workspace.id, name: 'Site', subdomain: `site-${workspace.id.slice(0, 8)}` });
      return { workspaceId: workspace.id, websiteId: website.id };
    };
    const waiting = await site();
    const issued = await site();
    const fields = { verificationToken: 'tok', status: 'verified', verifiedAt: new Date(), sslStatus: 'pending', sslProvider: 'cloudflare', sslRequestedAt: new Date() };
    await db.Domain.create({ ...waiting, hostname: 'www.waiting.com', sslProviderRef: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', ...fields });
    await db.Domain.create({ ...issued, hostname: 'www.issued.com', sslProviderRef: 'bbbbbbbbccccddddeeeeffffffffffff', ...fields });
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      status: 200,
      json: async () => ({
        success: true,
        result: String(url).includes('bbbbbbbb')
          ? { id: 'bbbbbbbbccccddddeeeeffffffffffff', status: 'active', ssl: { status: 'active' } }
          : { id: 'aaaaaaaabbbbccccddddeeeeeeeeeeee', status: 'pending', ssl: { status: 'pending_validation' } },
      }),
    }));
    purgeStore.mockClear();

    const jobs = require('../../src/modules/domains/domainJobs');
    expect(await jobs.pollPendingCertificates()).toEqual({ checked: 2, failed: 0 });
    expect(asked()).toEqual([{ id: issued.workspaceId, previousSlug: null }]);
  });
});
