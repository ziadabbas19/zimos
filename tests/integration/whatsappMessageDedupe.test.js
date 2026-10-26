'use strict';

// One row per Meta message id in a store (migration 720): the copies already
// stored are removed but the oldest, the unique index refuses a new one, the
// webhook skips a copy that loses that race, and the bot's job is keyed by
// Meta's id so a message delivered twice is answered once.

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const queue = require('../../src/core/queue');
const migration = require('../../src/db/migrations/720-whatsapp-messages-unique-wa-id');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const TOKEN = 'EAAG-dedupe-token-1234567890';
const APP_SECRET = 'meta-app-secret-for-tests';
const PHONE_ID = '1122334455';
const INDEX = 'whatsapp_messages_ws_wamid_unique';

const realFetch = global.fetch;
const startingAi = { ...env.ai };

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
  jest.restoreAllMocks();
  Object.assign(env.ai, startingAi);
});

async function connected() {
  const ctx = await setupWorkspaceWithProduct();
  await request(app)
    .put(`/api/v1/workspaces/${ctx.workspace.id}/whatsapp/integration`)
    .set(bearer(ctx.auth.accessToken))
    .send({ phoneNumberId: PHONE_ID, accessToken: TOKEN, appSecret: APP_SECRET })
    .expect(200);
  return ctx;
}

function signed(workspaceId, payload) {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  return request(app).post(`/api/v1/webhooks/whatsapp/${workspaceId}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', `sha256=${sig}`).send(raw);
}

const inbound = (id, text) => ({
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: PHONE_ID },
            contacts: [{ wa_id: '201055551234', profile: { name: 'Mona' } }],
            messages: [{ from: '201055551234', id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
          },
        },
      ],
    },
  ],
});

async function indexState() {
  const [rows] = await db.sequelize.query(
    `SELECT i.indisvalid AS valid, i.indisunique AS "unique"
       FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = :name`,
    { replacements: { name: INDEX } }
  );
  return rows[0] || null;
}

describe('migration 720', () => {
  it('removes the later copies of a message, keeps the oldest, then builds the unique index (twice is safe)', async () => {
    const qi = db.sequelize.getQueryInterface();
    const { workspace } = await setupWorkspaceWithProduct();
    const conversation = await db.WhatsappConversation.create({ workspaceId: workspace.id, phoneNormalized: '201055551234' });
    const row = (waMessageId, body, secondsAgo) =>
      db.WhatsappMessage.create({ workspaceId: workspace.id, conversationId: conversation.id, direction: 'in', waMessageId, body, status: 'received' }).then(async (m) => {
        await db.sequelize.query('UPDATE whatsapp_messages SET created_at = NOW() - make_interval(secs => :s) WHERE id = :id', { replacements: { s: secondsAgo, id: m.id } });
        return m.id;
      });

    await migration.down(qi);
    expect(await indexState()).toBeNull();
    try {
      const oldest = await row('wamid.dup', 'first', 30);
      await row('wamid.dup', 'second', 20);
      await row('wamid.dup', 'third', 10);
      const single = await row('wamid.single', 'alone', 5);
      // Failed sends carry no id: never copies of each other.
      const noId1 = await row(null, 'failed one', 4);
      const noId2 = await row(null, 'failed two', 3);

      await migration.up(qi);

      const left = await db.WhatsappMessage.findAll({ where: { workspaceId: workspace.id }, attributes: ['id'] });
      expect(left.map((m) => m.id).sort()).toEqual([oldest, single, noId1, noId2].sort());
      expect(await indexState()).toEqual({ valid: true, unique: true });

      await migration.up(qi);
      expect(await indexState()).toEqual({ valid: true, unique: true });
      await expect(row('wamid.single', 'again', 1)).rejects.toBeInstanceOf(db.Sequelize.UniqueConstraintError);
    } finally {
      await migration.up(qi);
    }
  });
});

describe('the webhook and a message delivered twice', () => {
  it('records it once when both deliveries arrive together', async () => {
    const { workspace } = await connected();
    const payload = inbound('wamid.twice', 'عايز أسأل');
    const answers = await Promise.all([signed(workspace.id, payload), signed(workspace.id, payload)]);
    expect(answers.map((r) => r.status)).toEqual([200, 200]);
    expect(answers.reduce((n, r) => n + r.body.messages, 0)).toBe(1);
    expect(await db.WhatsappMessage.count({ where: { workspaceId: workspace.id, waMessageId: 'wamid.twice' } })).toBe(1);
    const conversation = await db.WhatsappConversation.findOne({ where: { workspaceId: workspace.id } });
    expect(conversation.unreadCount).toBe(1);
  });

  it('skips a copy that passed the look-up but lost the insert to the index', async () => {
    const { workspace } = await connected();
    await signed(workspace.id, inbound('wamid.race', 'hi')).expect(200);
    // The look-up before the insert sees nothing, as when two deliveries run side by side.
    jest.spyOn(db.WhatsappMessage, 'findOne').mockResolvedValueOnce(null);
    const res = await signed(workspace.id, inbound('wamid.race', 'hi'));
    expect(res.status).toBe(200);
    expect(res.body.messages).toBe(0);
    expect(await db.WhatsappMessage.count({ where: { workspaceId: workspace.id, waMessageId: 'wamid.race' } })).toBe(1);
    const conversation = await db.WhatsappConversation.findOne({ where: { workspaceId: workspace.id } });
    expect(conversation.unreadCount).toBe(1);
  });
});

describe("the bot's job", () => {
  it("is keyed by Meta's message id, so a second delivery queues nothing new", async () => {
    const { workspace } = await connected();
    const row = await db.Workspace.findByPk(workspace.id);
    await row.update({ settings: { ...(row.settings || {}), wa_bot: { enabled: true, always_on: true } } });
    env.ai.enabled = true;
    const add = jest.spyOn(queue, 'add').mockResolvedValue({ id: null, queued: true });

    await signed(workspace.id, inbound('wamid.bot.1', 'عندكم توصيل؟')).expect(200);

    const botJobs = add.mock.calls.filter(([name]) => name === 'ai');
    expect(botJobs).toHaveLength(1);
    expect(botJobs[0][3]).toMatchObject({ workspaceId: workspace.id, dedupeKey: `wabot:${workspace.id}:wamid.bot.1` });
  });
});
