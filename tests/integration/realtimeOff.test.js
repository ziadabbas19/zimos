'use strict';

/**
 * REALTIME_ENABLED off (the default): nothing of the live updates exists. No
 * socket server, no consumer, and none of their events recorded — the same
 * outbox rows as before the module, for the same changes.
 */

const http = require('http');
const { app, request, registerAndActivate, setupWorkspaceWithProduct, makePlatformUser, confirmCodOrder } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const billingService = require('../../src/modules/billing/billingService');
const realtime = require('../../src/modules/realtime');
const registry = require('../../src/core/queue/registry');

const LIVE_ONLY = ['order.stage_changed', 'merchant.created', 'ticket.created', 'subscription.paid'];
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

describe('REALTIME_ENABLED off', () => {
  it('starts off under test', () => {
    expect(env.realtime.enabled).toBe(false);
  });

  it('attaches no socket server: the socket path is an unknown path of the API', async () => {
    const server = http.createServer(app);
    expect(realtime.attach(server, app)).toBe(null);
    const res = await request(app).get(`${realtime.PATH}/?EIO=4&transport=websocket`);
    expect(res.status).toBe(404);
  });

  it('the realtime consumer listens to nothing, so no job is queued for it', () => {
    const consumer = registry.load().consumers.find((c) => c.name === 'realtime');
    expect(consumer.events).toEqual([]);
  });

  it('a sign-up, an order, its confirmation, a ticket and a paid charge record no live-only event', async () => {
    await billingService.seedDefaultPlans();
    const ctx = await setupWorkspaceWithProduct();
    const order = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders`)
      .set(bearer(ctx.auth.accessToken))
      .set('Idempotency-Key', `off-${Date.now()}`)
      .send({
        items: [{ variantId: ctx.variant.id, quantity: 1 }],
        contact: { fullName: 'Off Buyer', phone: '01000008888' },
        shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Quiet St' },
        paymentMethod: 'cod',
      })
      .expect(201);
    await confirmCodOrder(ctx.auth.accessToken, ctx.workspace.id, order.body.order.id);
    await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/support/tickets`)
      .set(bearer(ctx.auth.accessToken))
      .send({ subject: 'Help', body: 'Something is wrong.', category: 'technical' })
      .expect(201);
    const admin = await makePlatformUser('admin');
    const starter = await db.Plan.findOne({ where: { key: 'starter' } });
    await db.Subscription.update({ planId: starter.id }, { where: { workspaceId: ctx.workspace.id } });
    await request(app).post(`/api/v1/admin/workspaces/${ctx.workspace.id}/charges`).set(admin.H).expect(201);
    const charge = (await request(app).get(`/api/v1/admin/workspaces/${ctx.workspace.id}/charges`).set(admin.H)).body.charges[0];
    await request(app).post(`/api/v1/admin/charges/${charge.id}/record-payment`).set(admin.H).send({ amountReceived: Number((await db.BillingInvoice.findByPk(charge.id)).amount) }).expect(200);
    await registerAndActivate({ fullName: 'Another Sign-up' });

    const types = (await db.DomainEvent.findAll({ attributes: ['type'] })).map((e) => e.type);
    expect(types).toContain('order.created');
    expect(types).toContain('order.confirmed');
    expect(types.filter((t) => LIVE_ONLY.includes(t))).toEqual([]);
  });
});
