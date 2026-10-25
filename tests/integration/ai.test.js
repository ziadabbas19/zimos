'use strict';

// The AI features behind AI_ENABLED (config/env.js `ai`): off, their routes
// are not there, the WhatsApp bot stays silent, the order check does nothing
// and no provider is asked; on (with the sandbox provider), a job runs to
// the end and a store's requests stop at AI_DAILY_LIMIT a day.

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const sandbox = require('../../src/modules/ai/providers/sandbox');
const { getProvider } = require('../../src/modules/ai/providers');
const aiOrderCheck = require('../../src/modules/risk/aiOrderCheck');
const logger = require('../../src/core/utils/logger');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const TOKEN = 'EAAG-test-access-token-1234567890';
const APP_SECRET = 'meta-app-secret-for-tests';
const PHONE_ID = '1122334455';
const PRODUCT_INPUT = { name: 'Cotton summer shirt', price: '450 EGP', notes: 'Light, breathable' };

const realFetch = global.fetch;
const startingAi = { ...env.ai };
let sent;
let generate;

beforeAll(() => {
  process.env.WHATSAPP_GRAPH_BASE = 'https://graph.test/v21.0';
});
afterAll(() => {
  global.fetch = realFetch;
  delete process.env.WHATSAPP_GRAPH_BASE;
});
beforeEach(() => {
  Object.assign(env.ai, startingAi);
  generate = jest.spyOn(sandbox, 'generate');
  sent = [];
  global.fetch = jest.fn(async (url, opts = {}) => {
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if ((opts.headers && opts.headers.Authorization) !== `Bearer ${TOKEN}`) return json(401, { error: { message: 'Invalid OAuth access token', code: 190 } });
    if (String(url).includes('/messages')) {
      sent.push(JSON.parse(opts.body));
      return json(200, { messages: [{ id: `wamid.out${sent.length}` }] });
    }
    return json(200, { display_phone_number: '+20 10 0000 1111', verified_name: 'Nile Store' });
  });
});
afterEach(() => {
  generate.mockRestore();
  Object.assign(env.ai, startingAi);
});

async function connectedWithBot() {
  const ctx = await setupWorkspaceWithProduct();
  const res = await request(app)
    .put(`/api/v1/workspaces/${ctx.workspace.id}/whatsapp/integration`)
    .set(bearer(ctx.auth.accessToken))
    .send({ phoneNumberId: PHONE_ID, accessToken: TOKEN, appSecret: APP_SECRET });
  expect(res.status).toBe(200);
  // The store has its bot switched on: only AI_ENABLED decides from here.
  const workspace = await db.Workspace.findByPk(ctx.workspace.id);
  await workspace.update({ settings: { ...(workspace.settings || {}), wa_bot: { enabled: true, always_on: true } } });
  return ctx;
}

function customerWrites(workspaceId, id, text) {
  const from = '201055551234';
  const raw = JSON.stringify({
    // metadata: the receiving number, which must be the store's connected one (whatsappService.handleWebhook).
    entry: [{ changes: [{ value: { metadata: { phone_number_id: PHONE_ID }, contacts: [{ wa_id: from, profile: { name: 'Mona' } }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }],
  });
  const sig = crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  return request(app).post(`/api/v1/webhooks/whatsapp/${workspaceId}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', `sha256=${sig}`).send(raw);
}

describe('AI_ENABLED off (the default)', () => {
  it('starts off under the suite, whatever the .env says', () => {
    expect(env.ai.enabled).toBe(false);
  });

  it('answers 404 on every AI route, as if they did not exist, and asks no provider', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const base = `/api/v1/workspaces/${workspace.id}`;
    const calls = [
      request(app).get(`${base}/ai/usage`).set(bearer(auth.accessToken)),
      request(app).get(`${base}/ai/jobs`).set(bearer(auth.accessToken)),
      request(app).post(`${base}/ai/jobs`).set(bearer(auth.accessToken)).send({ feature: 'product', input: PRODUCT_INPUT }),
      request(app).get(`${base}/wa-bot`).set(bearer(auth.accessToken)),
      request(app).post(`${base}/wa-bot/preview`).set(bearer(auth.accessToken)).send({ message: 'hi' }),
      request(app).post(`${base}/translations/ai`).set(bearer(auth.accessToken)).send({ entityType: 'product', locale: 'en' }),
      request(app).post(`${base}/translations/ai/apply`).set(bearer(auth.accessToken)).send({ jobIds: [crypto.randomUUID()] }),
    ];
    // The same answer as a path that never existed.
    const unknown = await request(app).get(`${base}/no-such-route`).set(bearer(auth.accessToken));
    expect(unknown.status).toBe(404);
    for (const res of await Promise.all(calls)) {
      expect([res.req.path, res.status, res.body.error.code]).toEqual([res.req.path, 404, unknown.body.error.code]);
    }
    // The translations screen itself is still there.
    const list = await request(app).get(`${base}/translations`).query({ entityType: 'product', locale: 'en' }).set(bearer(auth.accessToken));
    expect(list.status).not.toBe(404);
    expect(generate).not.toHaveBeenCalled();
    expect(await db.AiJob.count()).toBe(0);
  });

  it('keeps the WhatsApp bot silent: no reply, nothing marked sent by the bot', async () => {
    const { workspace } = await connectedWithBot();
    const res = await customerWrites(workspace.id, 'wamid.in.off', 'عندكم توصيل لإسكندرية؟');
    expect(res.status).toBe(200);
    expect(await db.WhatsappMessage.count({ where: { workspaceId: workspace.id, direction: 'in' } })).toBe(1);
    expect(await db.WhatsappMessage.count({ where: { workspaceId: workspace.id, direction: 'out' } })).toBe(0);
    expect(await db.WhatsappMessage.count({ where: { sentByBot: true } })).toBe(0);
    expect(sent).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });

  it('runs no AI order check and refuses to hand out a provider', async () => {
    const { workspace } = await setupWorkspaceWithProduct();
    await db.FeatureFlag.create({ key: aiOrderCheck.FLAG_KEY, enabled: true, rollout: 100 });
    expect(await aiOrderCheck.queueFor(workspace.id, crypto.randomUUID(), 'moderate', null)).toBe(false);
    expect(await aiOrderCheck.run(crypto.randomUUID(), workspace.id)).toBe('off');
    expect(() => getProvider()).toThrow(expect.objectContaining({ code: 'AI_DISABLED' }));
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('AI_ENABLED on, sandbox provider', () => {
  beforeEach(() => {
    env.ai.enabled = true;
  });

  it('runs a product job to the end and records its usage', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const base = `/api/v1/workspaces/${workspace.id}/ai`;
    const created = await request(app).post(`${base}/jobs`).set(bearer(auth.accessToken)).send({ feature: 'product', input: PRODUCT_INPUT });
    expect(created.status).toBe(202);
    expect(generate).toHaveBeenCalledTimes(1);

    const job = await request(app).get(`${base}/jobs/${created.body.job.id}`).set(bearer(auth.accessToken));
    expect(job.status).toBe(200);
    expect(job.body.job).toMatchObject({ feature: 'product', status: 'succeeded', provider: 'sandbox', error: null });
    expect(job.body.job.output.name).toEqual(expect.any(String));
    expect(await db.AiUsage.count({ where: { workspaceId: workspace.id, jobId: created.body.job.id, provider: 'sandbox' } })).toBe(1);

    const usage = await request(app).get(`${base}/usage`).set(bearer(auth.accessToken));
    expect(usage.status).toBe(200);
    expect(usage.body).toMatchObject({ used: 1, provider: { available: true, name: 'sandbox', sandbox: true }, daily: { limit: 50, used: 1, remaining: 49 } });
  });

  it('keeps a job to its own store and needs a signed-in member', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const created = await request(app).post(`/api/v1/workspaces/${workspace.id}/ai/jobs`).set(bearer(auth.accessToken)).send({ feature: 'product', input: PRODUCT_INPUT });
    expect(created.status).toBe(202);

    const other = await registerAndActivate();
    const otherWorkspace = await createWorkspace(other.accessToken, 'Other store');
    const foreign = await request(app).get(`/api/v1/workspaces/${otherWorkspace.id}/ai/jobs/${created.body.job.id}`).set(bearer(other.accessToken));
    expect(foreign.status).toBe(404);
    // Not a member: the store is not even found (tenantContext).
    const notMember = await request(app).get(`/api/v1/workspaces/${workspace.id}/ai/jobs/${created.body.job.id}`).set(bearer(other.accessToken));
    expect(notMember.status).toBe(404);
    expect(notMember.body.job).toBeUndefined();
    const anonymous = await request(app).get(`/api/v1/workspaces/${workspace.id}/ai/usage`);
    expect(anonymous.status).toBe(401);
  });

  it('opens the AI translation of missing texts, still behind website.edit', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    // English is not switched on for this store: the route is there and says so.
    const res = await request(app).post(`/api/v1/workspaces/${workspace.id}/translations/ai`).set(bearer(auth.accessToken)).send({ entityType: 'product', locale: 'en' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('LANGUAGE_NOT_OFFERED');
    const anonymous = await request(app).post(`/api/v1/workspaces/${workspace.id}/translations/ai`).send({ entityType: 'product', locale: 'en' });
    expect(anonymous.status).toBe(401);
  });

  it('stops a store at AI_DAILY_LIMIT requests a day with 429 AI_LIMIT_REACHED', async () => {
    env.ai.dailyLimit = 2;
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const post = () => request(app).post(`/api/v1/workspaces/${workspace.id}/ai/jobs`).set(bearer(auth.accessToken)).send({ feature: 'product', input: PRODUCT_INPUT });
    expect((await post()).status).toBe(202);
    expect((await post()).status).toBe(202);
    const third = await post();
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('AI_LIMIT_REACHED');
    expect(await db.AiJob.count({ where: { workspaceId: workspace.id } })).toBe(2);
    expect(generate).toHaveBeenCalledTimes(2);

    // Another store has its own count.
    const other = await setupWorkspaceWithProduct();
    const elsewhere = await request(app).post(`/api/v1/workspaces/${other.workspace.id}/ai/jobs`).set(bearer(other.auth.accessToken)).send({ feature: 'product', input: PRODUCT_INPUT });
    expect(elsewhere.status).toBe(202);
  });

  it('lets the WhatsApp bot answer a customer, marked as sent by the bot', async () => {
    const { workspace } = await connectedWithBot();
    const res = await customerWrites(workspace.id, 'wamid.in.on', 'Do you deliver to Alexandria?');
    expect(res.status).toBe(200);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ feature: 'support_reply', workspaceId: workspace.id }));
    const replies = await db.WhatsappMessage.findAll({ where: { workspaceId: workspace.id, direction: 'out' } });
    expect(replies).toHaveLength(1);
    expect(replies[0].sentByBot).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('counts the bot replies against the daily cap: once used up, it hands over instead of answering', async () => {
    env.ai.dailyLimit = 0;
    const { workspace } = await connectedWithBot();
    await customerWrites(workspace.id, 'wamid.in.cap', 'Hello?');
    expect(generate).not.toHaveBeenCalled();
    expect(await db.WhatsappMessage.count({ where: { workspaceId: workspace.id, direction: 'out' } })).toBe(0);
    const conversation = await db.WhatsappConversation.findOne({ where: { workspaceId: workspace.id } });
    expect(conversation.botPausedAt).not.toBeNull();
  });
});

describe('the sandbox provider in production', () => {
  const startingProduction = env.isProduction;
  afterEach(() => {
    env.isProduction = startingProduction;
  });

  it('is refused unless AI_PROVIDER=sandbox is set on purpose, which logs a warning', () => {
    env.ai.enabled = true;
    env.isProduction = true;
    env.ai.provider = '';
    expect(() => getProvider()).toThrow(expect.objectContaining({ code: 'AI_NOT_CONFIGURED' }));
    env.ai.provider = 'nope';
    expect(() => getProvider()).toThrow(expect.objectContaining({ code: 'AI_NOT_CONFIGURED' }));

    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    env.ai.provider = 'sandbox';
    expect(getProvider().name).toBe('sandbox');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('AI_PROVIDER=sandbox in production'));
    warn.mockRestore();
  });
});
