'use strict';

// Order automations: rules fire after commit on real order events and send a
// WhatsApp template with order data; runs are recorded (sent/skipped/failed).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const TOKEN = 'EAAG-automation-token-1234567890';
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
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (String(url).includes('/messages')) {
      sent.push(JSON.parse(opts.body));
      return json(200, { messages: [{ id: `wamid.auto.${sent.length}` }] });
    }
    return json(200, { display_phone_number: '+20 10 1111 2222', verified_name: 'Auto Store' });
  });
});

async function waitForRuns(workspaceId, count) {
  for (let i = 0; i < 40; i += 1) {
    const rows = await db.AutomationRun.findAll({ where: { workspaceId } });
    if (rows.length >= count) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return db.AutomationRun.findAll({ where: { workspaceId } });
}

function storefrontOrder(workspaceId, variantId) {
  return request(app)
    .post(`/api/v1/store/${workspaceId}/checkout`)
    .set('Idempotency-Key', `auto-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      contact: { fullName: 'Mona Ali', phone: '01012312312' },
      shippingAddress: { country: 'EG', city: 'Alexandria', addressLine: '6 Test St' },
      paymentMethod: 'cod',
      item: { variantId, quantity: 1 },
    });
}

describe('automations', () => {
  it('sends a WhatsApp template with real order data when an order is created', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 25000 });
    await request(app)
      .put(`/api/v1/workspaces/${workspace.id}/whatsapp/integration`)
      .set(bearer(auth.accessToken))
      .send({ phoneNumberId: '5566778899', accessToken: TOKEN, appSecret: 'meta-app-secret-for-tests' })
      .expect(200);

    const created = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/automations`)
      .set(bearer(auth.accessToken))
      .send({
        name: 'Order received',
        trigger: 'order.created',
        actions: [{ type: 'whatsapp_template', template: 'order_received', language: 'ar', params: ['{{customer_name}}', '{{order_number}}', '{{order_total}}', '{{city}}'] }],
      });
    expect(created.status).toBe(201);

    const skipRule = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/automations`)
      .set(bearer(auth.accessToken))
      .send({ name: 'Big orders only', trigger: 'order.created', conditions: { minTotalAmount: 999999999 }, actions: [{ type: 'whatsapp_template', template: 'vip', params: [] }] });
    expect(skipRule.status).toBe(201);

    const order = await storefrontOrder(workspace.id, variant.id);
    expect(order.status).toBe(201);

    const runs = await waitForRuns(workspace.id, 2);
    expect(runs.map((r) => r.status).sort()).toEqual(['sent', 'skipped']);
    expect(sent).toHaveLength(1);
    expect(sent[0].template.name).toBe('order_received');
    expect(sent[0].template.components[0].parameters.map((p) => p.text)).toEqual(['Mona Ali', order.body.order.orderNumber, expect.stringContaining('EGP'), 'Alexandria']);

    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/automations`).set(bearer(auth.accessToken));
    const rule = list.body.rules.find((r) => r.id === created.body.rule.id);
    expect(rule.stats.sent).toBe(1);
    expect(list.body.triggers).toContain('order.delivered');

    const history = await request(app).get(`/api/v1/workspaces/${workspace.id}/automations/runs`).set(bearer(auth.accessToken));
    expect(history.body.runs[0].order.orderNumber).toBe(order.body.order.orderNumber);
  });

  it('records a failed run (without breaking the order) when WhatsApp is not connected', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/automations`)
      .set(bearer(auth.accessToken))
      .send({ name: 'No integration', trigger: 'order.created', actions: [{ type: 'whatsapp_template', template: 'order_received', params: [] }] })
      .expect(201);
    const order = await storefrontOrder(workspace.id, variant.id);
    expect(order.status).toBe(201);
    const runs = await waitForRuns(workspace.id, 1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].detail).toMatch(/Connect WhatsApp/);
  });
});
