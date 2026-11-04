'use strict';

// PUBLIC_WORKSPACE_CACHE_TTL_SECONDS: core/middleware/publicWorkspace reuses the
// workspace row and its access picture. Off is the old reads; on, a suspension
// still closes the store on the very next request, and goes out to the edge.

const { app, request, registerAndActivate, createWorkspace, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const billingService = require('../../src/modules/billing/billingService');
const cloudflarePurge = require('../../src/modules/storefront/cloudflarePurge');
const workspaceCache = require('../../src/modules/storefront/publicWorkspaceCache');

async function store() {
  const owner = await registerAndActivate();
  const workspace = await createWorkspace(owner.accessToken, 'Kept Store');
  return { owner, id: workspace.id, slug: workspace.slug, H: { Authorization: `Bearer ${owner.accessToken}` } };
}

const get = (ref) => request(app).get(`/api/v1/store/${ref}`);

/** Every SQL statement a call sends. */
async function statements(fn) {
  const seen = [];
  const original = db.sequelize.options.logging;
  db.sequelize.options.logging = (sql) => seen.push(String(sql));
  try {
    const result = await fn();
    return { seen, result };
  } finally {
    db.sequelize.options.logging = original;
  }
}
const readsWholeRow = (seen) => seen.filter((sql) => /FROM "workspaces" AS "Workspace"/.test(sql) && /"theme_settings"/.test(sql)).length;
const readsSubscription = (seen) => seen.filter((sql) => /FROM "subscriptions"/.test(sql)).length;

beforeEach(async () => {
  await billingService.seedDefaultPlans();
  workspaceCache._reset();
});

afterEach(() => {
  env.storefrontPerf.workspaceCacheTtlSeconds = 0;
  workspaceCache._reset();
  jest.restoreAllMocks();
});

describe('with the cache off (the default)', () => {
  it('reads the whole row and the subscription on every request and keeps nothing', async () => {
    expect(env.storefrontPerf.workspaceCacheTtlSeconds).toBe(0);
    const s = await store();
    for (let i = 0; i < 2; i++) {
      const { seen, result } = await statements(() => get(s.id));
      expect(result.status).toBe(200);
      expect(readsWholeRow(seen)).toBeGreaterThanOrEqual(1);
      expect(readsSubscription(seen)).toBeGreaterThanOrEqual(1);
    }
    expect(workspaceCache.read(s.id, { id: s.id, status: 'active', updatedAt: new Date() })).toBeNull();
  });
});

describe('with the cache on', () => {
  beforeEach(() => {
    env.storefrontPerf.workspaceCacheTtlSeconds = 30;
  });

  it('answers the same, reading the row and the subscription once', async () => {
    const s = await store();
    env.storefrontPerf.workspaceCacheTtlSeconds = 0;
    const plain = await get(s.id);
    env.storefrontPerf.workspaceCacheTtlSeconds = 30;

    const first = await statements(() => get(s.id));
    expect(first.result.status).toBe(200);
    expect(first.result.body).toEqual(plain.body);
    const middlewareReads = readsSubscription(first.seen);
    expect(middlewareReads).toBeGreaterThanOrEqual(1);

    const second = await statements(() => get(s.id));
    expect(second.result.body).toEqual(plain.body);
    expect(readsSubscription(second.seen)).toBe(middlewareReads - 1);
  });

  it('closes a suspended store on its next request, by id and by slug, and purges it at the edge', async () => {
    const s = await store();
    const admin = await makePlatformUser('admin');
    const purged = jest.spyOn(cloudflarePurge, 'purgeStore');
    expect((await get(s.id)).status).toBe(200);
    expect((await get(s.slug)).status).toBe(200);

    const res = await request(app).post(`/api/v1/admin/workspaces/${s.id}/suspend`).set(admin.H).send({ reason: 'Fraud' });
    expect(res.status).toBe(200);
    expect(purged).toHaveBeenCalledWith(s.id, expect.anything());
    purged.mockClear();

    const closed = await get(s.id);
    expect(closed.status).toBe(423);
    expect(closed.body.error.code).toBe('STORE_UNAVAILABLE');
    expect((await get(s.slug)).status).toBe(423);

    const lifted = await request(app).post(`/api/v1/admin/workspaces/${s.id}/reactivate`).set(admin.H).send({ reason: 'Cleared' });
    expect(lifted.status).toBe(200);
    expect(purged).toHaveBeenCalledWith(s.id, expect.anything());
    expect((await get(s.id)).status).toBe(200);
  });

  it('sees a suspension made by another instance, with nothing dropped here', async () => {
    const s = await store();
    expect((await get(s.id)).status).toBe(200);
    // Written behind this process's back: only the row says so.
    await db.Workspace.update(
      { status: 'suspended', suspendedAt: new Date(), suspensionReason: 'Elsewhere' },
      { where: { id: s.id } }
    );
    expect((await get(s.id)).status).toBe(423);
  });

  it('owner account deleted: its stores close at once and go from the edge', async () => {
    const s = await store();
    const admin = await makePlatformUser('admin');
    const purged = jest.spyOn(cloudflarePurge, 'purgeStore');
    expect((await get(s.id)).status).toBe(200);
    const res = await request(app).post(`/api/v1/admin/users/${s.owner.userId}/delete`).set(admin.H).send({ reason: 'Asked to', stores: 'suspend', confirm: true });
    expect(res.status).toBe(200);
    expect(purged).toHaveBeenCalledWith(s.id, expect.anything());
    expect((await get(s.id)).status).toBe(423);
  });

  it('shows a settings change at once: the row\'s updated_at moved', async () => {
    const s = await store();
    expect((await get(s.id)).body.store.name).toBe('Kept Store');
    const row = await db.Workspace.findByPk(s.id);
    await row.update({ name: 'Renamed Store' });
    expect((await get(s.id)).body.store.name).toBe('Renamed Store');
  });

  it('expires by the clock even when nothing changed', async () => {
    const s = await store();
    expect((await get(s.id)).status).toBe(200);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 31000);
    const { seen } = await statements(() => get(s.id));
    expect(readsWholeRow(seen)).toBeGreaterThanOrEqual(1);
  });

  it('a store it never had, or a draft or closed one, answers as without it', async () => {
    expect((await get('no-such-store')).status).toBe(404);
    const s = await store();
    expect((await get(s.id)).status).toBe(200);
    await db.Workspace.update({ status: 'closed' }, { where: { id: s.id } });
    expect((await get(s.id)).status).toBe(404);
  });

  it('gives each request its own copy of what it keeps', async () => {
    const s = await store();
    const row = await db.Workspace.findByPk(s.id);
    workspaceCache.write(s.id, row, { restricted: false, reasons: [], draft: false });
    const a = workspaceCache.read(s.id, row);
    a.row.settings = { changed: true };
    a.access.reasons.push('suspended');
    const b = workspaceCache.read(s.id, row);
    expect(b.row.settings).not.toEqual({ changed: true });
    expect(b.access.reasons).toEqual([]);
  });

  it('keeps no more than its limit', async () => {
    const s = await store();
    const row = await db.Workspace.findByPk(s.id);
    for (let i = 0; i < workspaceCache.MAX_ENTRIES + 5; i++) workspaceCache.write(`ref-${i}`, row, { reasons: [] });
    expect(workspaceCache.read('ref-0', row)).toBeNull();
    expect(workspaceCache.read(`ref-${workspaceCache.MAX_ENTRIES + 4}`, row)).not.toBeNull();
  });
});
