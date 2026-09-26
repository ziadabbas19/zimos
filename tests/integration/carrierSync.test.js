'use strict';

// Carrier polling (scripts/sync-carrier-shipments.js -> carrierSyncService),
// manual-cancel acknowledgement and its follow-up checks, and migration 102.
// Driven through the test-only fake carriers (tests/helpers/fakeCarriers.js):
// fakepoll is polled in bulk and cancels through its API; fakemanual is
// polled one parcel at a time and has no cancel API.

const crypto = require('crypto');
const { Sequelize } = require('sequelize');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const accounts = require('../../src/modules/shipping/carrierAccountService');
const sync = require('../../src/modules/shipping/carrierSyncService');
const migration102 = require('../../src/db/migrations/102-add-carrier-sync-fields-to-shipments');
const fakes = require('../helpers/fakeCarriers');

const HOUR = 60 * 60 * 1000;
const MANUAL_ADDRESS = { country: 'EG', province: 'Cairo', city: 'Maadi', addressLine: '9 Road 233, Degla' };

const originalKey = env.carriers.credentialsKey;
let uninstall;

beforeAll(() => {
  env.carriers.credentialsKey = crypto.randomBytes(32).toString('base64');
  uninstall = fakes.installFakeCarriers();
});

afterAll(() => {
  uninstall();
  env.carriers.credentialsKey = originalKey;
});

beforeEach(() => {
  fakes.reset();
  accounts.clearCitiesCache();
});

async function connectedStore(code) {
  const setup = await setupWorkspaceWithProduct({ price: 5000, stock: 30 });
  const api = fakes.api(setup.auth.accessToken);
  const res = await api.connect(setup.workspace.id, code);
  if (res.status !== 200) throw new Error(`connect failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...setup, api, token: setup.auth.accessToken, wid: setup.workspace.id, account: res.body.carrier };
}

async function book(store, code, address) {
  const order = await store.api.confirmedOrder(store.wid, store.variant.id, address);
  const res = await store.api.ship(store.wid, order.id, { carrierCode: code });
  if (res.status !== 201) throw new Error(`booking failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { order, shipment: res.body.shipment };
}

const reload = (id) => db.Shipment.findByPk(id);

describe('booking schedules the first poll', () => {
  it('a polled carrier: carrierAccountId and nextPollAt set, ~pollIntervalMinutes ahead', async () => {
    const store = await connectedStore('fakepoll');
    const before = Date.now();
    const { shipment } = await book(store, 'fakepoll');
    const account = await db.CarrierAccount.findOne({ where: { workspaceId: store.wid, carrierCode: 'fakepoll' } });

    expect(shipment.carrierAccountId).toBe(account.id);
    const next = new Date(shipment.nextPollAt).getTime();
    expect(next).toBeGreaterThanOrEqual(before + 30 * 60 * 1000);
    expect(next).toBeLessThan(Date.now() + 31 * 60 * 1000);
    expect(shipment).toMatchObject({ pollFailures: 0, lastPolledAt: null, cancelMode: null });
  });

  it('a manual shipment is never scheduled', async () => {
    const store = await connectedStore('fakepoll');
    const order = await store.api.confirmedOrder(store.wid, store.variant.id);
    const res = await store.api.ship(store.wid, order.id, { carrierCode: 'Local courier', waybillNumber: 'LC-1' });
    expect(res.status).toBe(201);
    expect(res.body.shipment).toMatchObject({ nextPollAt: null, carrierAccountId: null });
  });
});

describe('polling', () => {
  it('reads every due shipment of an account in one bulk call and applies the statuses', async () => {
    const store = await connectedStore('fakepoll');
    const a = await book(store, 'fakepoll');
    const b = await book(store, 'fakepoll');
    fakes.setStatus(a.shipment.waybillNumber, 'in_transit');
    fakes.setStatus(b.shipment.waybillNumber, 'delivered');

    const now = new Date(Date.now() + HOUR);
    const result = await sync.syncDue({ now });

    expect(result).toMatchObject({ claimed: 2, changed: 2, failed: 0 });
    const bulk = fakes.calls('getShipments', 'fakepoll');
    expect(bulk).toHaveLength(1);
    expect(bulk[0].refs.sort()).toEqual([a.shipment.waybillNumber, b.shipment.waybillNumber].sort());
    expect(fakes.calls('getShipment')).toHaveLength(0);

    const inTransit = await reload(a.shipment.id);
    expect(inTransit.status).toBe('in_transit');
    expect(inTransit.lastPolledAt.getTime()).toBe(now.getTime());
    expect(inTransit.nextPollAt.getTime()).toBe(now.getTime() + 30 * 60 * 1000);

    // Final: never polled again.
    const delivered = await reload(b.shipment.id);
    expect(delivered.status).toBe('delivered');
    expect(delivered.nextPollAt).toBeNull();

    const audit = await db.AuditLog.findOne({ where: { entityId: a.shipment.id, action: 'shipment.update' } });
    expect(audit.metadata).toMatchObject({ source: 'carrier', trigger: 'poll', carrierCode: 'fakepoll' });
    expect(audit.actorUserId).toBeNull();
    expect((await request(app).get(`/api/v1/workspaces/${store.wid}/orders/${a.order.id}`).set('Authorization', `Bearer ${store.token}`)).body.order.fulfillmentState).toBe('partially_fulfilled');
  });

  it('leaves shipments that are not due alone, and a second overlapping run claims nothing', async () => {
    const store = await connectedStore('fakepoll');
    await book(store, 'fakepoll');
    expect((await sync.syncDue({ now: new Date() })).claimed).toBe(0);

    const now = new Date(Date.now() + HOUR);
    const [first, second] = await Promise.all([sync.syncDueOnce({ now }), sync.syncDueOnce({ now })]);
    expect(first.claimed + second.claimed).toBe(1);
  });

  it('backs off on failures (interval x 2^failures) and resets after a good read', async () => {
    const store = await connectedStore('fakepoll');
    const { shipment } = await book(store, 'fakepoll');
    fakes.state.failReads = true;

    const t1 = new Date(Date.now() + HOUR);
    await sync.syncDue({ now: t1 });
    let row = await reload(shipment.id);
    expect(row.pollFailures).toBe(1);
    expect(row.nextPollAt.getTime()).toBe(t1.getTime() + 60 * 60 * 1000);

    const t2 = new Date(row.nextPollAt.getTime() + 1000);
    await sync.syncDue({ now: t2 });
    row = await reload(shipment.id);
    expect(row.pollFailures).toBe(2);
    expect(row.nextPollAt.getTime()).toBe(t2.getTime() + 120 * 60 * 1000);
    expect(row.status).toBe('created');

    fakes.state.failReads = false;
    const t3 = new Date(row.nextPollAt.getTime() + 1000);
    await sync.syncDue({ now: t3 });
    row = await reload(shipment.id);
    expect(row.pollFailures).toBe(0);
    expect(row.lastPolledAt.getTime()).toBe(t3.getTime());
  });

  it('a parcel missing from the bulk answer counts as a failed read for that parcel only', async () => {
    const store = await connectedStore('fakepoll');
    const a = await book(store, 'fakepoll');
    const b = await book(store, 'fakepoll');
    fakes.state.omitFromBulk.add(b.shipment.waybillNumber);
    fakes.setStatus(a.shipment.waybillNumber, 'picked_up');

    const result = await sync.syncDue({ now: new Date(Date.now() + HOUR) });
    expect(result).toMatchObject({ claimed: 2, changed: 1, failed: 1 });
    expect((await reload(a.shipment.id)).pollFailures).toBe(0);
    expect((await reload(b.shipment.id)).pollFailures).toBe(1);
  });

  it('stops polling once the account is disconnected', async () => {
    const store = await connectedStore('fakepoll');
    const { shipment } = await book(store, 'fakepoll');
    const res = await request(app).delete(`/api/v1/workspaces/${store.wid}/carriers/fakepoll`).set('Authorization', `Bearer ${store.token}`);
    expect(res.status).toBe(200);
    const row = await reload(shipment.id);
    expect(row.nextPollAt).toBeNull();
    // ON DELETE SET NULL
    expect(row.carrierAccountId).toBeNull();
    expect((await sync.syncDue({ now: new Date(Date.now() + HOUR) })).claimed).toBe(0);
  });

  it('stops polling a carrier this server no longer offers', async () => {
    const store = await connectedStore('fakepoll');
    const { shipment } = await book(store, 'fakepoll');
    const enabled = env.carriers.enabled;
    env.carriers.enabled = enabled.filter((c) => c !== 'fakepoll');
    try {
      const result = await sync.syncDue({ now: new Date(Date.now() + HOUR) });
      expect(result).toMatchObject({ claimed: 1, stopped: 1 });
    } finally {
      env.carriers.enabled = enabled;
    }
    expect((await reload(shipment.id)).nextPollAt).toBeNull();
    expect(fakes.calls('getShipments')).toHaveLength(0);
  });

  it('stops polling a shipment older than CARRIER_POLL_MAX_AGE_DAYS', async () => {
    const store = await connectedStore('fakepoll');
    const { shipment } = await book(store, 'fakepoll');
    const now = new Date(Date.now() + (env.carriers.pollMaxAgeDays + 1) * 24 * HOUR);
    await sync.syncDue({ now });
    const row = await reload(shipment.id);
    expect(row.lastPolledAt.getTime()).toBe(now.getTime());
    expect(row.nextPollAt).toBeNull();
  });

  it('a webhook that finalises a shipment also stops its polling', async () => {
    const store = await connectedStore('fakepoll');
    const { shipment } = await book(store, 'fakepoll');
    fakes.setStatus(shipment.waybillNumber, 'delivered');
    const token = (await db.CarrierAccount.findOne({ where: { workspaceId: store.wid } })).webhookToken;
    const webhooks = require('../../src/modules/shipping/carrierWebhookService');
    await request(app).post(`/api/v1/webhooks/carriers/fakepoll/${token}`).send({ ref: shipment.waybillNumber });
    await webhooks.whenIdle();
    const row = await reload(shipment.id);
    expect(row.status).toBe('delivered');
    expect(row.nextPollAt).toBeNull();
  });

  it('cancelling an order cancels a polled carrier\'s shipment through its API and stops polling', async () => {
    const store = await connectedStore('fakepoll');
    const { order, shipment } = await book(store, 'fakepoll');
    const res = await store.api.cancelOrder(store.wid, order.id);
    expect(res.status).toBe(200);
    expect(fakes.calls('cancelShipment', 'fakepoll')).toHaveLength(1);
    expect(await reload(shipment.id)).toMatchObject({ status: 'cancelled', cancelMode: 'api', nextPollAt: null });
  });
});

describe('a courier without a cancel API', () => {
  it('order cancel: 409 CARRIER_MANUAL_CANCEL_REQUIRED until acknowledged, then cancelled as manual_ack', async () => {
    const store = await connectedStore('fakemanual');
    const { order, shipment } = await book(store, 'fakemanual', MANUAL_ADDRESS);

    const refused = await store.api.cancelOrder(store.wid, order.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CARRIER_MANUAL_CANCEL_REQUIRED');
    expect(refused.body.error.details).toEqual({
      shipments: [{ shipmentId: shipment.id, carrierCode: 'fakemanual', carrierName: 'FakeManual', waybillNumber: shipment.waybillNumber }],
    });
    expect((await db.Order.findByPk(order.id)).cancelledAt).toBeNull();
    expect((await reload(shipment.id)).status).toBe('created');

    const before = Date.now();
    const ok = await store.api.cancelOrder(store.wid, order.id, { acknowledgeManualCancel: true });
    expect(ok.status).toBe(200);
    const row = await reload(shipment.id);
    expect(row).toMatchObject({ status: 'cancelled', cancelMode: 'manual_ack', cancelAcknowledgedBy: store.auth.userId });
    expect(row.nextPollAt.getTime() - row.cancelAcknowledgedAt.getTime()).toBe(24 * HOUR);
    expect(row.cancelAcknowledgedAt.getTime()).toBeGreaterThanOrEqual(before);

    const audit = await db.AuditLog.findOne({ where: { entityId: shipment.id, action: 'shipment.update' } });
    expect(audit.metadata).toMatchObject({ source: 'merchant', trigger: 'order_cancel', cancelMode: 'manual_ack' });
    expect(audit.actorUserId).toBe(store.auth.userId);
  });

  it('the follow-up checks: flag the order if the carrier still has the parcel moving, then stop for good', async () => {
    const store = await connectedStore('fakemanual');
    const { order, shipment } = await book(store, 'fakemanual', MANUAL_ADDRESS);
    await store.api.cancelOrder(store.wid, order.id, { acknowledgeManualCancel: true });
    const ackAt = (await reload(shipment.id)).cancelAcknowledgedAt.getTime();
    fakes.setStatus(shipment.waybillNumber, 'in_transit');

    // Not due before ~24h.
    expect((await sync.syncDue({ now: new Date(ackAt + 23 * HOUR) })).claimed).toBe(0);

    const first = await sync.syncDue({ now: new Date(ackAt + 25 * HOUR) });
    expect(first).toMatchObject({ claimed: 1, flagged: 1 });
    expect(fakes.calls('getShipment', 'fakemanual')).toHaveLength(1);
    let row = await reload(shipment.id);
    // Our status is not changed by the carrier's answer.
    expect(row.status).toBe('cancelled');
    expect(row.nextPollAt.getTime()).toBe(ackAt + 72 * HOUR);
    expect((await db.Order.findByPk(order.id)).riskFlags).toEqual(['carrier_cancel_unconfirmed']);
    const audits = await db.AuditLog.findAll({ where: { entityId: shipment.id, action: 'shipment.carrier_cancel_unconfirmed' } });
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ check: 1, reportedStatus: 'in_transit', trackingNumber: shipment.waybillNumber });

    // Still moving at ~72h: flagged again in the audit, the flag itself once.
    await sync.syncDue({ now: new Date(ackAt + 73 * HOUR) });
    row = await reload(shipment.id);
    expect(row.nextPollAt).toBeNull();
    expect((await db.Order.findByPk(order.id)).riskFlags).toEqual(['carrier_cancel_unconfirmed']);
    expect(await db.AuditLog.count({ where: { entityId: shipment.id, action: 'shipment.carrier_cancel_unconfirmed' } })).toBe(2);

    // After the last check: never read again.
    expect((await sync.syncDue({ now: new Date(ackAt + 200 * HOUR) })).claimed).toBe(0);
    expect(fakes.calls('getShipment', 'fakemanual')).toHaveLength(2);
  });

  it('a webhook or manual sync showing the parcel moving raises the same flag; failed does not; status stays cancelled', async () => {
    const webhooks = require('../../src/modules/shipping/carrierWebhookService');
    const store = await connectedStore('fakemanual');
    const { order, shipment } = await book(store, 'fakemanual', MANUAL_ADDRESS);
    await store.api.cancelOrder(store.wid, order.id, { acknowledgeManualCancel: true });
    const ackAt = (await reload(shipment.id)).cancelAcknowledgedAt.getTime();
    const token = (await db.CarrierAccount.findOne({ where: { workspaceId: store.wid } })).webhookToken;
    const hook = async (status) => {
      fakes.setStatus(shipment.waybillNumber, status);
      const res = await request(app).post(`/api/v1/webhooks/carriers/fakemanual/${token}`).send({ ref: shipment.waybillNumber });
      expect(res.status).toBe(200);
      await webhooks.whenIdle();
    };
    const flagAudits = () =>
      db.AuditLog.findAll({ where: { entityId: shipment.id, action: 'shipment.carrier_cancel_unconfirmed' }, order: [['createdAt', 'ASC']] });

    await hook('failed');
    expect((await db.Order.findByPk(order.id)).riskFlags).toEqual([]);
    expect(await flagAudits()).toHaveLength(0);

    await hook('in_transit');
    expect((await db.Order.findByPk(order.id)).riskFlags).toEqual(['carrier_cancel_unconfirmed']);
    let audits = await flagAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ source: 'carrier', trigger: 'webhook', check: null, reportedStatus: 'in_transit' });
    let row = await reload(shipment.id);
    expect(row.status).toBe('cancelled');
    expect(row.cancelMode).toBe('manual_ack');
    // The scheduled checks are still due.
    expect(row.nextPollAt.getTime()).toBe(ackAt + 24 * HOUR);

    await hook('delivered');
    expect((await reload(shipment.id)).status).toBe('cancelled');

    // The merchant's sync button, same rule.
    const manualSync = async (status) => {
      fakes.setStatus(shipment.waybillNumber, status);
      const res = await request(app)
        .post(`/api/v1/workspaces/${store.wid}/orders/${order.id}/shipments/${shipment.id}/sync`)
        .set('Authorization', `Bearer ${store.token}`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.shipment.status).toBe('cancelled');
      expect(res.body.changed).toBe(false);
    };
    await manualSync('failed');
    expect(await flagAudits()).toHaveLength(2);
    await manualSync('out_for_delivery');
    audits = await flagAudits();
    expect(audits).toHaveLength(3);
    expect(audits[2].metadata).toMatchObject({ source: 'carrier', trigger: 'manual_sync', check: null, reportedStatus: 'out_for_delivery' });
    expect((await db.Order.findByPk(order.id)).riskFlags).toEqual(['carrier_cancel_unconfirmed']);
    expect((await reload(shipment.id)).nextPollAt.getTime()).toBe(ackAt + 24 * HOUR);

    // The scheduled check agrees: one more audit row, still one flag.
    await sync.syncDue({ now: new Date(ackAt + 25 * HOUR) });
    audits = await flagAudits();
    expect(audits.map((a) => a.metadata.trigger)).toEqual(['webhook', 'webhook', 'manual_sync', 'cancel_check']);
    expect((await db.Order.findByPk(order.id)).riskFlags).toEqual(['carrier_cancel_unconfirmed']);
    row = await reload(shipment.id);
    expect(row.status).toBe('cancelled');
    expect(row.nextPollAt.getTime()).toBe(ackAt + 72 * HOUR);
  });

  it('a carrier that confirms the cancel raises nothing', async () => {
    const store = await connectedStore('fakemanual');
    const { order, shipment } = await book(store, 'fakemanual', MANUAL_ADDRESS);
    await store.api.cancelOrder(store.wid, order.id, { acknowledgeManualCancel: true });
    const ackAt = (await reload(shipment.id)).cancelAcknowledgedAt.getTime();
    fakes.setStatus(shipment.waybillNumber, 'cancelled');

    expect(await sync.syncDue({ now: new Date(ackAt + 25 * HOUR) })).toMatchObject({ flagged: 0, cancelConfirmed: 1 });
    expect((await db.Order.findByPk(order.id)).riskFlags).toEqual([]);
    expect(await db.AuditLog.count({ where: { action: 'shipment.carrier_cancel_unconfirmed' } })).toBe(0);
  });

  it('PATCH to cancelled needs the acknowledgement too', async () => {
    const store = await connectedStore('fakemanual');
    const { order, shipment } = await book(store, 'fakemanual', MANUAL_ADDRESS);

    const refused = await store.api.patchShipment(store.wid, order.id, shipment.id, { status: 'cancelled' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CARRIER_MANUAL_CANCEL_REQUIRED');

    const ok = await store.api.patchShipment(store.wid, order.id, shipment.id, { status: 'cancelled', acknowledgeManualCancel: true });
    expect(ok.status).toBe(200);
    expect(ok.body.shipment).toMatchObject({ status: 'cancelled', cancelMode: 'manual_ack', cancelAcknowledgedBy: store.auth.userId });

    // Acknowledgement alone is not an update.
    expect((await store.api.patchShipment(store.wid, order.id, shipment.id, { acknowledgeManualCancel: true })).status).toBe(422);
  });

  it('a confirmation correction to rejected needs the acknowledgement too', async () => {
    const store = await connectedStore('fakemanual');
    const { order, shipment } = await book(store, 'fakemanual', MANUAL_ADDRESS);
    const task = await db.ConfirmationTask.findOne({ where: { orderId: order.id } });
    const correct = (extra = {}) =>
      request(app)
        .post(`/api/v1/workspaces/${store.wid}/confirmation-tasks/${task.id}/correction`)
        .set('Authorization', `Bearer ${store.token}`)
        .send({ outcome: 'rejected', reason: 'Customer refused on a second call', ...extra });

    const refused = await correct();
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CARRIER_MANUAL_CANCEL_REQUIRED');
    expect((await db.Order.findByPk(order.id)).confirmationState).toBe('confirmed');

    const ok = await correct({ acknowledgeManualCancel: true });
    expect(ok.status).toBe(200);
    expect(await reload(shipment.id)).toMatchObject({ status: 'cancelled', cancelMode: 'manual_ack' });
    const audit = await db.AuditLog.findOne({ where: { entityId: shipment.id, action: 'shipment.update' } });
    expect(audit.metadata.trigger).toBe('confirmation_correction');
  });

  it('a booking that could not be saved: no cancel attempt, 502 CARRIER_BOOKING_NOT_SAVED and an audit row', async () => {
    const store = await connectedStore('fakemanual');
    const order = await store.api.confirmedOrder(store.wid, store.variant.id, MANUAL_ADDRESS);
    const spy = jest.spyOn(db.Shipment, 'create').mockRejectedValueOnce(new Error('disk full'));
    try {
      const res = await store.api.ship(store.wid, order.id, { carrierCode: 'fakemanual' });
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('CARRIER_BOOKING_NOT_SAVED');
      expect(res.body.error.details).toMatchObject({ carrierCode: 'fakemanual', trackingNumber: 'FM00001', manualCancelRequired: true });
    } finally {
      spy.mockRestore();
    }
    expect(await db.Shipment.count({ where: { orderId: order.id } })).toBe(0);
    const audit = await db.AuditLog.findOne({ where: { action: 'shipment.booking_not_saved', entityId: order.id } });
    expect(audit.metadata).toMatchObject({ trackingNumber: 'FM00001', manualCancelRequired: true });
  });

  it('a polled carrier that could not save its booking still cancels it through the API', async () => {
    const store = await connectedStore('fakepoll');
    const order = await store.api.confirmedOrder(store.wid, store.variant.id);
    const spy = jest.spyOn(db.Shipment, 'create').mockRejectedValueOnce(new Error('disk full'));
    try {
      const res = await store.api.ship(store.wid, order.id, { carrierCode: 'fakepoll' });
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(fakes.calls('cancelShipment', 'fakepoll')).toHaveLength(1);
  });
});

describe('migration 102', () => {
  const qi = () => db.sequelize.getQueryInterface();

  it('goes down cleanly, and backfills carrier_account_id on the way up', async () => {
    const store = await connectedStore('fakepoll');
    const { shipment } = await book(store, 'fakepoll');
    // An older manual row under the same carrier code (from before the name
    // was reserved): no carrierShipmentId, so never linked to the account.
    const order = await store.api.confirmedOrder(store.wid, store.variant.id);
    const manual = await db.Shipment.create({
      workspaceId: store.wid,
      orderId: order.id,
      carrierCode: 'fakepoll',
      waybillNumber: 'TYPED-1',
      trackingCode: 'zg000000102',
      status: 'created',
    });
    const account = await db.CarrierAccount.findOne({ where: { workspaceId: store.wid } });

    await migration102.down(qi(), Sequelize);
    const down = await qi().describeTable('shipments');
    for (const column of ['carrier_account_id', 'cancel_mode', 'cancel_acknowledged_by', 'cancel_acknowledged_at', 'next_poll_at', 'last_polled_at', 'poll_failures']) {
      expect(down[column]).toBeUndefined();
    }
    const [constraints] = await db.sequelize.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = 'shipments'::regclass AND conname LIKE 'shipments_cancel_mode%'"
    );
    expect(constraints).toEqual([]);
    const [indexes] = await db.sequelize.query("SELECT indexname FROM pg_indexes WHERE tablename = 'shipments' AND indexname IN ('shipments_next_poll_at_due_idx', 'shipments_carrier_account_id_idx')");
    expect(indexes).toEqual([]);

    await migration102.up(qi(), Sequelize);
    const up = await qi().describeTable('shipments');
    expect(up.poll_failures.allowNull).toBe(false);
    const [rows] = await db.sequelize.query('SELECT id, carrier_account_id, next_poll_at FROM shipments');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[shipment.id].carrier_account_id).toBe(account.id);
    expect(byId[shipment.id].next_poll_at).toBeNull();
    expect(byId[manual.id].carrier_account_id).toBeNull();

    await expect(
      db.sequelize.query(`UPDATE shipments SET cancel_mode = 'bogus' WHERE id = '${shipment.id}'`)
    ).rejects.toThrow(/shipments_cancel_mode_check/);
  });
});
