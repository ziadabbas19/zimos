'use strict';

// WhatsApp Cloud API integration: connect (verified against the Graph API),
// encrypted token, send text/template, inbound webhook with signature, delivery
// statuses and the inbox endpoints. The Graph API is mocked with global.fetch.

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const TOKEN = 'EAAG-test-access-token-1234567890';
const APP_SECRET = 'meta-app-secret-for-tests';
const PHONE_ID = '1122334455';

const realFetch = global.fetch;
let sent;

beforeAll(() => {
  process.env.WHATSAPP_GRAPH_BASE = 'https://graph.test/v21.0';
});
afterAll(() => {
  global.fetch = realFetch;
  delete process.env.WHATSAPP_GRAPH_BASE;
});
beforeEach(() => {
  sent = [];
  global.fetch = jest.fn(async (url, opts = {}) => {
    const auth = opts.headers && opts.headers.Authorization;
    const ok = auth === `Bearer ${TOKEN}`;
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (!ok) return json(401, { error: { message: 'Invalid OAuth access token', code: 190 } });
    if (String(url).includes('/messages')) {
      const body = JSON.parse(opts.body);
      sent.push(body);
      return json(200, { messages: [{ id: `wamid.${sent.length}` }] });
    }
    return json(200, { display_phone_number: '+20 10 0000 1111', verified_name: 'Nile Store' });
  });
});

async function connected() {
  const ctx = await setupWorkspaceWithProduct();
  const res = await request(app)
    .put(`/api/v1/workspaces/${ctx.workspace.id}/whatsapp/integration`)
    .set(bearer(ctx.auth.accessToken))
    .send({ phoneNumberId: PHONE_ID, accessToken: TOKEN, appSecret: APP_SECRET });
  expect(res.status).toBe(200);
  return { ...ctx, integration: res.body.integration };
}

function signed(workspaceId, payload) {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  return request(app).post(`/api/v1/webhooks/whatsapp/${workspaceId}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', `sha256=${sig}`).send(raw);
}

// Meta names the receiving number in every messages change (value.metadata).
const metadata = (phoneNumberId = PHONE_ID) => ({ display_phone_number: '201000001111', phone_number_id: phoneNumberId });

const inbound = (from, id, text, phoneNumberId = PHONE_ID) => ({
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: metadata(phoneNumberId),
            contacts: [{ wa_id: from, profile: { name: 'Mona' } }],
            messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
          },
        },
      ],
    },
  ],
});

const statuses = (list, phoneNumberId = PHONE_ID) => ({ entry: [{ changes: [{ field: 'messages', value: { metadata: metadata(phoneNumberId), statuses: list } }] }] });

describe('WhatsApp integration', () => {
  it('rejects a token the Graph API refuses', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await request(app)
      .put(`/api/v1/workspaces/${workspace.id}/whatsapp/integration`)
      .set(bearer(auth.accessToken))
      .send({ phoneNumberId: PHONE_ID, accessToken: 'EAAG-wrong-token-000000000000', appSecret: APP_SECRET });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('WHATSAPP_AUTH_FAILED');
  });

  it('connects, never exposes the token, and stores it encrypted', async () => {
    const { integration, workspace } = await connected();
    expect(integration).toMatchObject({ connected: true, displayPhoneNumber: '+20 10 0000 1111', accessTokenMask: '••••7890', appSecretSet: true });
    expect(JSON.stringify(integration)).not.toContain(TOKEN);
    const row = await db.WorkspaceIntegration.findOne({ where: { workspaceId: workspace.id } });
    expect(row.secretsSealed).not.toContain(TOKEN);
  });

  it('verifies the webhook subscription with the verify token', async () => {
    const { integration, workspace } = await connected();
    const ok = await request(app)
      .get(`/api/v1/webhooks/whatsapp/${workspace.id}`)
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': integration.webhook.verifyToken, 'hub.challenge': '12345' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('12345');
    const bad = await request(app).get(`/api/v1/webhooks/whatsapp/${workspace.id}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' });
    expect(bad.status).toBe(403);
  });

  it('receives messages (signed), opens the 24h window, replies and tracks delivery', async () => {
    const { auth, workspace } = await connected();

    const unsigned = await request(app).post(`/api/v1/webhooks/whatsapp/${workspace.id}`).send(inbound('201055551234', 'wamid.in1', 'hi'));
    expect(unsigned.status).toBe(401);

    // Text outside the 24h window is refused.
    const closed = await request(app).post(`/api/v1/workspaces/${workspace.id}/whatsapp/messages`).set(bearer(auth.accessToken)).send({ to: '01055551234', text: 'hello' });
    expect(closed.status).toBe(422);
    expect(closed.body.error.code).toBe('WHATSAPP_WINDOW_CLOSED');

    const hook = await signed(workspace.id, inbound('201055551234', 'wamid.in1', 'عايز أسأل عن الطلب'));
    expect(hook.status).toBe(200);
    expect(hook.body.messages).toBe(1);
    // Duplicate delivery of the same webhook is ignored.
    await signed(workspace.id, inbound('201055551234', 'wamid.in1', 'عايز أسأل عن الطلب'));

    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/whatsapp/conversations`).set(bearer(auth.accessToken));
    expect(list.body.conversations).toHaveLength(1);
    expect(list.body.conversations[0]).toMatchObject({ customerName: 'Mona', unreadCount: 1, canReply: true });
    const conversationId = list.body.conversations[0].id;

    const reply = await request(app).post(`/api/v1/workspaces/${workspace.id}/whatsapp/messages`).set(bearer(auth.accessToken)).send({ to: '01055551234', text: 'أهلًا يا منى' });
    expect(reply.status).toBe(201);
    expect(sent[0]).toMatchObject({ to: '201055551234', type: 'text', text: { body: 'أهلًا يا منى' } });

    await signed(workspace.id, statuses([{ id: 'wamid.1', status: 'read' }]));

    const messages = await request(app).get(`/api/v1/workspaces/${workspace.id}/whatsapp/conversations/${conversationId}/messages`).set(bearer(auth.accessToken));
    expect(messages.body.messages.map((m) => [m.direction, m.status])).toEqual([
      ['in', 'received'],
      ['out', 'read'],
    ]);
    const after = await request(app).get(`/api/v1/workspaces/${workspace.id}/whatsapp/conversations`).set(bearer(auth.accessToken));
    expect(after.body.conversations[0].unreadCount).toBe(0);
  });

  it('sends approved templates without an open window', async () => {
    const { auth, workspace } = await connected();
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/whatsapp/messages`)
      .set(bearer(auth.accessToken))
      .send({ to: '01099990000', template: { name: 'order_confirmation', language: 'ar', params: ['منى', '1024'] } });
    expect(res.status).toBe(201);
    expect(sent[0]).toMatchObject({ type: 'template', template: { name: 'order_confirmation', language: { code: 'ar' } } });
  });
});

// S1: one Meta app can hold several numbers, and Meta sends all of them to the
// same callback URL. A store keeps only what reaches the number it connected.
describe('WhatsApp webhook: only the connected number counts', () => {
  it("ignores another number's messages: 200 for Meta, nothing in the inbox", async () => {
    const { auth, workspace } = await connected();
    const res = await signed(workspace.id, inbound('201055551234', 'wamid.other1', 'رسالة لمتجر تاني', '9988776655'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, messages: 0, ignored: 1 });
    expect(await db.WhatsappMessage.count({ where: { workspaceId: workspace.id } })).toBe(0);
    expect(await db.WhatsappConversation.count({ where: { workspaceId: workspace.id } })).toBe(0);

    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/whatsapp/conversations`).set(bearer(auth.accessToken));
    expect(list.body.conversations).toEqual([]);
  });

  it('ignores a messages change that names no number', async () => {
    const { workspace } = await connected();
    const payload = inbound('201055551234', 'wamid.nometa', 'hi');
    delete payload.entry[0].changes[0].value.metadata;
    const res = await signed(workspace.id, payload);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ messages: 0, ignored: 1 });
    expect(await db.WhatsappMessage.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  it("keeps the store's own messages when the same delivery also carries another number's", async () => {
    const { workspace } = await connected();
    const mine = inbound('201055551234', 'wamid.mine', 'ليّا');
    const theirs = inbound('201055559999', 'wamid.theirs', 'مش ليّا', '9988776655');
    const res = await signed(workspace.id, { entry: [...mine.entry, ...theirs.entry] });
    expect(res.body).toMatchObject({ messages: 1, ignored: 1 });
    const rows = await db.WhatsappMessage.findAll({ where: { workspaceId: workspace.id }, attributes: ['waMessageId'] });
    expect(rows.map((r) => r.waMessageId)).toEqual(['wamid.mine']);
  });

  it("does not move a message's status from another number's status update", async () => {
    const { auth, workspace } = await connected();
    await signed(workspace.id, inbound('201055551234', 'wamid.in.st', 'hi'));
    await request(app).post(`/api/v1/workspaces/${workspace.id}/whatsapp/messages`).set(bearer(auth.accessToken)).send({ to: '01055551234', text: 'أهلًا' }).expect(201);

    const other = await signed(workspace.id, statuses([{ id: 'wamid.1', status: 'read' }], '9988776655'));
    expect(other.body).toMatchObject({ statuses: 0, ignored: 1 });
    const out = await db.WhatsappMessage.findOne({ where: { workspaceId: workspace.id, waMessageId: 'wamid.1' } });
    expect(out.status).toBe('sent');

    await signed(workspace.id, statuses([{ id: 'wamid.1', status: 'delivered' }]));
    await out.reload();
    expect(out.status).toBe('delivered');
  });
});

// S6: without the App Secret every webhook would be refused, so a connection always has one.
// S7: the secrets are sealed before the token is sent to Meta.
describe('WhatsApp connect: the App Secret and the order of the steps', () => {
  const put = (ctx, body) => request(app).put(`/api/v1/workspaces/${ctx.workspace.id}/whatsapp/integration`).set(bearer(ctx.auth.accessToken)).send(body);

  it('refuses a first connection without the App Secret, before asking Meta', async () => {
    const ctx = await setupWorkspaceWithProduct();
    for (const appSecret of [undefined, '', null]) {
      const res = await put(ctx, { phoneNumberId: PHONE_ID, accessToken: TOKEN, ...(appSecret === undefined ? {} : { appSecret }) });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('WHATSAPP_APP_SECRET_REQUIRED');
    }
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await db.WorkspaceIntegration.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);
  });

  it('keeps the saved App Secret when a reconnect leaves it empty', async () => {
    const ctx = await connected();
    const res = await put(ctx, { phoneNumberId: PHONE_ID, accessToken: TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.integration.appSecretSet).toBe(true);
    // Still signed with the first one.
    const hook = await signed(ctx.workspace.id, inbound('201055551234', 'wamid.keep', 'hi'));
    expect(hook.status).toBe(200);
  });

  it('asks a connection saved without one (before this rule) for it on its next save', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const secretBox = require('../../src/core/utils/secretBox');
    await db.WorkspaceIntegration.create({
      workspaceId: ctx.workspace.id,
      provider: 'whatsapp_cloud',
      status: 'connected',
      config: { phoneNumberId: PHONE_ID, verifyToken: 'legacy-verify-token' },
      secretsSealed: secretBox.seal(JSON.stringify({ accessToken: TOKEN, appSecret: null })),
    });
    const refused = await put(ctx, { phoneNumberId: PHONE_ID, accessToken: TOKEN });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('WHATSAPP_APP_SECRET_REQUIRED');
    const saved = await put(ctx, { phoneNumberId: PHONE_ID, accessToken: TOKEN, appSecret: APP_SECRET });
    expect(saved.status).toBe(200);
    expect(saved.body.integration).toMatchObject({ appSecretSet: true, webhook: { verifyToken: 'legacy-verify-token' } });
  });

  it('sends nothing to Meta when the secrets cannot be sealed (INTEGRATIONS_ENCRYPTION_KEY missing)', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const key = process.env.INTEGRATIONS_ENCRYPTION_KEY;
    delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
    try {
      const res = await put(ctx, { phoneNumberId: PHONE_ID, accessToken: TOKEN, appSecret: APP_SECRET });
      expect(res.status).toBe(500);
    } finally {
      process.env.INTEGRATIONS_ENCRYPTION_KEY = key;
    }
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await db.WorkspaceIntegration.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);
  });
});

// S10: the verify token is compared in constant time; a near miss is refused like any other.
describe('WhatsApp webhook verification', () => {
  it('refuses a token that differs only in its last character, or that is longer', async () => {
    const { integration, workspace } = await connected();
    const token = integration.webhook.verifyToken;
    const near = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    for (const given of [near, `${token}x`, '']) {
      const res = await request(app).get(`/api/v1/webhooks/whatsapp/${workspace.id}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': given, 'hub.challenge': '7' });
      expect(res.status).toBe(403);
    }
  });
});
