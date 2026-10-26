'use strict';

// WEBHOOK_DELIVERY_RETENTION_DAYS (webhooks/deliveryRetention.js): the delivery
// log keeps that many days. Older deliveries that are done — delivered,
// exhausted, or stopped — go; one still pending or due for a retry stays,
// whatever its age. Unset or 0: nothing is deleted.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { pruneOnce, maybePrune } = require('../../src/modules/webhooks/deliveryRetention');

const saved = env.webhooks.deliveryRetentionDays;
afterEach(() => {
  env.webhooks.deliveryRetentionDays = saved;
});

const DAY = 24 * 60 * 60 * 1000;
let seq = 0;

async function delivery(endpoint, { status, nextAttemptAt = null, daysAgo }) {
  seq += 1;
  const row = await db.WebhookDelivery.create({
    workspaceId: endpoint.workspaceId,
    endpointId: endpoint.id,
    eventId: `test:${seq}`,
    eventType: 'order.created',
    payload: { id: `test:${seq}`, data: { order: { id: 'o' } } },
    status,
    nextAttemptAt,
    attemptCount: 1,
  });
  await db.sequelize.query('UPDATE webhook_deliveries SET created_at = :at WHERE id = :id', { replacements: { at: new Date(Date.now() - daysAgo * DAY), id: row.id } });
  return row;
}

async function endpointOf() {
  const { auth, workspace } = await setupWorkspaceWithProduct();
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspace.id}/webhooks`)
    .set({ Authorization: `Bearer ${auth.accessToken}` })
    .send({ url: 'https://hooks.example.com/zimos', events: ['order.created'] });
  return db.WebhookEndpoint.findByPk(res.body.endpoint.id);
}

describe('webhook delivery retention', () => {
  it('deletes the old ones that are done and keeps what is pending, due for a retry, or recent', async () => {
    const endpoint = await endpointOf();
    const gone = [
      await delivery(endpoint, { status: 'delivered', daysAgo: 31 }),
      await delivery(endpoint, { status: 'exhausted', daysAgo: 40 }),
      await delivery(endpoint, { status: 'failed', nextAttemptAt: null, daysAgo: 45 }),
    ];
    const kept = [
      await delivery(endpoint, { status: 'failed', nextAttemptAt: new Date(Date.now() + DAY), daysAgo: 45 }),
      await delivery(endpoint, { status: 'pending', nextAttemptAt: new Date(), daysAgo: 60 }),
      await delivery(endpoint, { status: 'delivered', daysAgo: 29 }),
    ];

    expect(await pruneOnce({ days: 0 })).toBe(0);
    expect(await pruneOnce({ days: 30 })).toBe(3);
    const left = (await db.WebhookDelivery.findAll({ where: { endpointId: endpoint.id } })).map((d) => d.id).sort();
    expect(left).toEqual(kept.map((d) => d.id).sort());
    for (const d of gone) expect(await db.WebhookDelivery.findByPk(d.id)).toBeNull();
  });

  it('runs from the worker only while set, and at most once a day', async () => {
    const endpoint = await endpointOf();
    await delivery(endpoint, { status: 'delivered', daysAgo: 31 });
    env.webhooks.deliveryRetentionDays = 0;
    expect(await maybePrune()).toBe(0);
    env.webhooks.deliveryRetentionDays = 30;
    const now = new Date(Date.now() + 1000 * DAY);
    expect(await maybePrune({ now })).toBe(1);
    await delivery(endpoint, { status: 'delivered', daysAgo: 31 });
    expect(await maybePrune({ now: new Date(now.getTime() + 60 * 1000) })).toBe(0);
    expect(await maybePrune({ now: new Date(now.getTime() + DAY) })).toBe(1);
  });
});
