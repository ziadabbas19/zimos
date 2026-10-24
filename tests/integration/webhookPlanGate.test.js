'use strict';

// WEBHOOKS_REQUIRE_API_ACCESS (webhooks/webhookPlanGate.js): a new webhook
// endpoint needs the plan's api_access — from the dashboard and the public
// API — while PLAN_FEATURE_ENFORCEMENT is on too. Endpoints a store already
// has are never touched.

const crypto = require('crypto');
const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const saved = { gate: env.webhooks.requireApiAccess, enforcement: env.planFeatures.enforcement };
afterEach(() => {
  env.webhooks.requireApiAccess = saved.gate;
  env.planFeatures.enforcement = saved.enforcement;
});

async function storeOn(features) {
  const plan = await db.Plan.create({
    key: `wh${crypto.randomBytes(4).toString('hex')}`,
    name: 'Plan',
    currency: 'EGP',
    monthlyPriceAmount: 10000,
    yearlyPriceAmount: 100000,
    trialDays: 14,
    isActive: true,
    isPublic: true,
    features,
  });
  const owner = await registerAndActivate();
  const workspace = await createWorkspace(owner.accessToken, 'Hooks Store');
  await db.Subscription.update({ planId: plan.id }, { where: { workspaceId: workspace.id } });
  return { wid: workspace.id, H: bearer(owner.accessToken) };
}

const add = (ctx) => request(app).post(`/api/v1/workspaces/${ctx.wid}/webhooks`).set(ctx.H).send({ url: 'https://hooks.example.com/zimos', events: ['order.created'] });

describe('adding a webhook endpoint and the plan', () => {
  it('off: added on a plan without api_access, as before, even with enforcement on', async () => {
    env.planFeatures.enforcement = true;
    const ctx = await storeOn([]);
    expect((await add(ctx)).status).toBe(201);
  });

  it('on: refused without api_access while enforcement is on; existing endpoints still edit, test-free, and delete', async () => {
    const ctx = await storeOn([]);
    const existing = (await add(ctx)).body.endpoint;

    env.webhooks.requireApiAccess = true;
    env.planFeatures.enforcement = true;
    const refused = await add(ctx);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: 'PLAN_FEATURE_REQUIRED', details: { feature: 'api_access' } });
    expect(await db.WebhookEndpoint.count({ where: { workspaceId: ctx.wid } })).toBe(1);

    const base = `/api/v1/workspaces/${ctx.wid}/webhooks/${existing.id}`;
    expect((await request(app).patch(base).set(ctx.H).send({ isActive: false })).status).toBe(200);
    expect((await request(app).get(`/api/v1/workspaces/${ctx.wid}/webhooks`).set(ctx.H)).status).toBe(200);
    expect((await request(app).delete(base).set(ctx.H)).status).toBe(200);
  });

  it('on: added with api_access, and added by anyone while enforcement is off', async () => {
    env.webhooks.requireApiAccess = true;
    env.planFeatures.enforcement = true;
    expect((await add(await storeOn(['api_access']))).status).toBe(201);
    env.planFeatures.enforcement = false;
    expect((await add(await storeOn([]))).status).toBe(201);
  });

  it('on: the public API asks the same of a key whose store lacks api_access', async () => {
    const ctx = await storeOn([]);
    const minted = await request(app).post(`/api/v1/workspaces/${ctx.wid}/api-keys`).set(ctx.H).send({ name: 'Hooks', scopes: ['webhooks:write'] });
    expect(minted.status).toBe(201);
    const key = { Authorization: `Bearer ${minted.body.secret}` };

    env.webhooks.requireApiAccess = true;
    env.planFeatures.enforcement = true;
    const refused = await request(app).post('/api/v1/public/webhooks').set(key).send({ url: 'https://hooks.example.com/zimos', events: ['order.created'] });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('PLAN_FEATURE_REQUIRED');

    env.webhooks.requireApiAccess = false;
    const added = await request(app).post('/api/v1/public/webhooks').set(key).send({ url: 'https://hooks.example.com/zimos', events: ['order.created'] });
    expect(added.status).toBe(201);
  });
});
