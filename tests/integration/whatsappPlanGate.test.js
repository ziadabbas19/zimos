'use strict';

/**
 * WHATSAPP_REQUIRE_PLAN_FEATURE (whatsapp/whatsappPlanGate.js): connecting a
 * WhatsApp number and switching on the ready-made order confirmation need the
 * plan's whatsapp_confirmation, while PLAN_FEATURE_ENFORCEMENT is on too. What
 * a store already has keeps working on any plan. The Graph API is mocked with
 * global.fetch.
 */

const crypto = require('crypto');
const { app, request, registerAndActivate, createWorkspace, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const TOKEN = 'EAAG-plan-gate-token-1234567890';
const APP_SECRET = 'meta-app-secret-for-tests';
const PHONE_ID = '1122334455';
const FEATURE = 'whatsapp_confirmation';

const realFetch = global.fetch;
const ORIGINAL = { gate: env.whatsapp.requirePlanFeature, enforcement: env.planFeatures.enforcement };

beforeAll(() => {
  process.env.WHATSAPP_GRAPH_BASE = 'https://graph.test/v21.0';
});
afterAll(() => {
  global.fetch = realFetch;
  delete process.env.WHATSAPP_GRAPH_BASE;
});
beforeEach(() => {
  global.fetch = jest.fn(async (url) => {
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (String(url).includes('/messages')) return json(200, { messages: [{ id: `wamid.out.${crypto.randomUUID()}` }] });
    return json(200, { display_phone_number: '+20 10 0000 1111', verified_name: 'Nile Store' });
  });
});
afterEach(() => {
  env.whatsapp.requirePlanFeature = ORIGINAL.gate;
  env.planFeatures.enforcement = ORIGINAL.enforcement;
});

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const key = () => `wa${crypto.randomBytes(4).toString('hex')}`;
const gateOn = () => {
  env.whatsapp.requirePlanFeature = true;
  env.planFeatures.enforcement = true;
};

async function makePlan(features) {
  return db.Plan.create({ key: key(), name: 'Plan', currency: 'EGP', monthlyPriceAmount: 10000, yearlyPriceAmount: 100000, trialDays: 14, isActive: true, isPublic: true, features });
}

/** A store of its own owner, moved onto a plan with `features`. */
async function storeWith(features) {
  const owner = await registerAndActivate();
  const workspace = await createWorkspace(owner.accessToken, 'WhatsApp Store');
  await db.Subscription.update({ planId: (await makePlan(features)).id }, { where: { workspaceId: workspace.id } });
  return { wid: workspace.id, H: bearer(owner.accessToken) };
}

const base = (ctx) => `/api/v1/workspaces/${ctx.wid}`;
const connect = (ctx, body = {}) => request(app).put(`${base(ctx)}/whatsapp/integration`).set(ctx.H).send({ phoneNumberId: PHONE_ID, accessToken: TOKEN, appSecret: APP_SECRET, ...body });
const integration = async (ctx) => (await request(app).get(`${base(ctx)}/whatsapp/integration`).set(ctx.H)).body.integration;
const enable = (ctx, templateKey) => request(app).post(`${base(ctx)}/automations/templates/${templateKey}/enable`).set(ctx.H).send({});
const templates = async (ctx) => {
  const res = await request(app).get(`${base(ctx)}/automations/templates`).set(ctx.H);
  return Object.fromEntries(res.body.templates.map((t) => [t.key, t]));
};

function signed(workspaceId, id) {
  const raw = JSON.stringify({
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_ID }, messages: [{ from: '201055551234', id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hi' } }] } }] }],
  });
  const sig = crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  return request(app).post(`/api/v1/webhooks/whatsapp/${workspaceId}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', `sha256=${sig}`).send(raw);
}

describe('WHATSAPP_REQUIRE_PLAN_FEATURE off (the default)', () => {
  it('starts off under the suite, and refuses nothing for a missing feature even with PLAN_FEATURE_ENFORCEMENT on', async () => {
    expect(env.whatsapp.requirePlanFeature).toBe(false);
    env.planFeatures.enforcement = true;
    const ctx = await storeWith([]);
    expect((await integration(ctx)).planLocked).toBe(false);
    expect((await templates(ctx)).order_confirmation.planLocked).toBe(false);
    expect((await connect(ctx)).status).toBe(200);
    expect((await enable(ctx, 'order_confirmation')).status).toBe(201);
  });

  it('on its own (PLAN_FEATURE_ENFORCEMENT off) refuses nothing either', async () => {
    env.whatsapp.requirePlanFeature = true;
    const ctx = await storeWith([]);
    expect((await integration(ctx)).planLocked).toBe(false);
    expect((await connect(ctx)).status).toBe(200);
    expect((await enable(ctx, 'order_confirmation')).status).toBe(201);
  });
});

describe('WHATSAPP_REQUIRE_PLAN_FEATURE on, with PLAN_FEATURE_ENFORCEMENT', () => {
  it('refuses a first connection on a plan without the feature, before asking Meta, and says so up front', async () => {
    gateOn();
    const ctx = await storeWith(['funnels']);
    expect(await integration(ctx)).toEqual({ connected: false, planLocked: true });

    const res = await connect(ctx);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLAN_FEATURE_REQUIRED');
    expect(res.body.error.details).toEqual({ feature: FEATURE, label: { en: 'WhatsApp order confirmation', ar: 'تأكيد الطلبات عبر واتساب' } });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await db.WorkspaceIntegration.count({ where: { workspaceId: ctx.wid } })).toBe(0);
  });

  it('refuses switching on the WhatsApp confirmation automation only; the other ready-made ones stay open', async () => {
    gateOn();
    const ctx = await storeWith([]);
    const list = await templates(ctx);
    expect(list.order_confirmation.planLocked).toBe(true);
    expect(Object.values(list).filter((t) => t.planLocked).map((t) => t.key)).toEqual(['order_confirmation']);

    const refused = await enable(ctx, 'order_confirmation');
    expect(refused.status).toBe(403);
    expect(refused.body.error.details.feature).toBe(FEATURE);
    expect(await db.AutomationRule.count({ where: { workspaceId: ctx.wid, templateKey: 'order_confirmation' } })).toBe(0);

    expect((await enable(ctx, 'order_shipped')).status).toBe(201);
  });

  it('lets a plan with the feature through, and a console grant without changing the plan', async () => {
    gateOn();
    const withIt = await storeWith([FEATURE]);
    expect((await integration(withIt)).planLocked).toBe(false);
    expect((await connect(withIt)).status).toBe(200);
    expect((await enable(withIt, 'order_confirmation')).status).toBe(201);

    const granted = await storeWith([]);
    const admin = await makePlatformUser('admin');
    const g = await request(app).post(`/api/v1/admin/workspaces/${granted.wid}/feature-overrides`).set(admin.H).send({ featureKey: FEATURE, mode: 'grant', reason: 'Pilot' });
    expect(g.status).toBe(201);
    expect((await connect(granted)).status).toBe(200);
  });

  it('keeps what a store already has: its number, its reconnects and its confirmation rule', async () => {
    // Connected and switched on while the gate was off.
    const ctx = await storeWith([]);
    expect((await connect(ctx)).status).toBe(200);
    const made = await enable(ctx, 'order_confirmation');
    expect(made.status).toBe(201);
    gateOn();

    // Messages still arrive and go out.
    expect((await signed(ctx.wid, 'wamid.kept.1')).status).toBe(200);
    expect(await db.WhatsappMessage.count({ where: { workspaceId: ctx.wid, direction: 'in' } })).toBe(1);
    const reply = await request(app).post(`${base(ctx)}/whatsapp/messages`).set(ctx.H).send({ to: '01055551234', text: 'أهلًا' });
    expect(reply.status).toBe(201);

    // A reconnect with a new token is an edit, not a new connection.
    const again = await connect(ctx, { accessToken: TOKEN });
    expect(again.status).toBe(200);
    expect((await integration(ctx)).planLocked).toBe(true);

    // The rule is answered again, and can be paused and resumed.
    const second = await enable(ctx, 'order_confirmation');
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ created: false, rule: { id: made.body.rule.id } });
    expect((await templates(ctx)).order_confirmation.planLocked).toBe(false);
    const ruleUrl = `${base(ctx)}/automations/${made.body.rule.id}`;
    expect((await request(app).patch(ruleUrl).set(ctx.H).send({ isActive: false })).status).toBe(200);
    expect((await request(app).patch(ruleUrl).set(ctx.H).send({ isActive: true })).status).toBe(200);

    // Disconnecting is allowed; connecting again is a new connection.
    expect((await request(app).delete(`${base(ctx)}/whatsapp/integration`).set(ctx.H)).status).toBe(200);
    expect((await connect(ctx)).status).toBe(403);
  });
});
