'use strict';

// The Postgres queue driver (core/queue/postgresDriver): a running job keeps
// its lock fresh, a stale job goes back in line only when it may run again,
// and a job that may not run twice (an automatic courier booking) is failed
// and reported instead.

const db = require('../../src/db/models');
const driver = require('../../src/core/queue/postgresDriver');
const queue = require('../../src/core/queue');
const carriers = require('../../src/modules/shipping/carriers');
const carrierBooking = require('../../src/modules/shipping/carrierBooking');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');

const HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000);

async function staleJob(fields) {
  return db.QueueJob.create({ queue: 'carriers', status: 'active', lockedAt: HOUR_AGO(), lockedBy: 'gone:1', attempts: 1, maxAttempts: 3, ...fields });
}

afterEach(async () => {
  await driver.stop();
  driver.configureInterruptions({});
  jest.restoreAllMocks();
});

describe('stale queue jobs', () => {
  it('puts a job with attempts left back in line, and fails one on its last attempt', async () => {
    const retry = await staleJob({ name: 'shipments.bulk_book', attempts: 1, maxAttempts: 3 });
    const spent = await staleJob({ name: 'shipments.bulk_book', attempts: 3, maxAttempts: 3 });
    await driver.releaseStale({ force: true });

    expect(await db.QueueJob.findByPk(retry.id)).toMatchObject({ status: 'pending', lockedBy: null });
    const failed = await db.QueueJob.findByPk(spent.id);
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toMatch(/worker stopped/);
  });

  it('fails a `once` job however many attempts it has left, and reports it', async () => {
    const reported = [];
    driver.configureInterruptions({ once: ['carriers/consume:carrier_auto_booking'], interrupted: async (job) => reported.push(job.id) });
    const once = await staleJob({ name: 'consume:carrier_auto_booking', attempts: 1, maxAttempts: 5 });
    const other = await staleJob({ name: 'shipments.bulk_book', attempts: 1, maxAttempts: 3 });
    await driver.releaseStale({ force: true });

    expect((await db.QueueJob.findByPk(once.id)).status).toBe('failed');
    expect((await db.QueueJob.findByPk(other.id)).status).toBe('pending');
    expect(reported).toEqual([once.id]);
  });

  it('a fresh active job is left alone', async () => {
    const live = await db.QueueJob.create({ queue: 'carriers', name: 'shipments.bulk_book', status: 'active', lockedAt: new Date(), lockedBy: 'live:1', attempts: 1, maxAttempts: 3 });
    await driver.releaseStale({ force: true });
    expect((await db.QueueJob.findByPk(live.id)).status).toBe('active');
  });

  it('the automatic courier booking is declared once, with its interruption report', () => {
    require('../../src/core/queue/registry').load();
    // The worker registers each outbox consumer's job when it starts (core/workerRuntime).
    require('../../src/core/outbox/outbox').registerHandlers();
    const settings = queue.interruptionSettings();
    expect(settings.once).toContain('carriers/consume:carrier_auto_booking');
  });
});

describe('a long job keeps its lock', () => {
  it('renews locked_at while the handler runs, and completes once', async () => {
    let runs = 0;
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    driver.process('io', async () => {
      runs += 1;
      await held;
    });
    // A stale age of 4 s gives a heartbeat every second.
    await driver.start({ pollMs: 100, concurrency: 1, staleLockMs: 4000 });
    const { id } = await driver.add('io', 'test.long', {});

    const until = async (check, ms = 5000) => {
      const end = Date.now() + ms;
      for (;;) {
        const row = await db.QueueJob.findByPk(id);
        if (row && check(row)) return row;
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const first = await until((row) => row.status === 'active' && row.lockedAt);
    const renewed = await until((row) => row.lockedAt.getTime() > first.lockedAt.getTime() + 500, 4000);
    expect(renewed.status).toBe('active');

    release();
    await until((row) => row.status === 'completed');
    expect(runs).toBe(1);
  });

  it('a run whose job was taken back and claimed again records nothing over the next run', async () => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    driver.process('io', () => held);
    await driver.start({ pollMs: 100, concurrency: 1, staleLockMs: 600000 });
    const { id } = await driver.add('io', 'test.fenced', {});
    const until = async (check, ms = 5000) => {
      const end = Date.now() + ms;
      for (;;) {
        const row = await db.QueueJob.findByPk(id);
        if (row && check(row)) return row;
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const first = await until((row) => row.status === 'active');
    expect(first.attempts).toBe(1);
    // The sweep took the job back and this same process claimed it again: same
    // holder, still active, one attempt further on.
    await db.QueueJob.update({ attempts: 2, lockedAt: new Date() }, { where: { id } });

    // The first run ends now. It is on attempt 1, the row on attempt 2.
    release();
    await new Promise((r) => setTimeout(r, 500));
    const after = await db.QueueJob.findByPk(id);
    expect(after.status).toBe('active');
    expect(after.attempts).toBe(2);
    expect(after.lockedBy).toBe(first.lockedBy);
    expect(after.finishedAt).toBeNull();
  });

  it('does the same with the control connection on (QUEUE_CONTROL_CONNECTION)', async () => {
    let runs = 0;
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    driver.process('io', async () => {
      runs += 1;
      await held;
    });
    await driver.start({ pollMs: 100, concurrency: 1, staleLockMs: 4000, controlConnection: true });
    const { id } = await driver.add('io', 'test.long', {});

    const until = async (check, ms = 5000) => {
      const end = Date.now() + ms;
      for (;;) {
        const row = await db.QueueJob.findByPk(id);
        if (row && check(row)) return row;
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    // Claimed and renewed over the driver's own connection.
    const first = await until((row) => row.status === 'active' && row.lockedAt);
    const renewed = await until((row) => row.lockedAt.getTime() > first.lockedAt.getTime() + 500, 4000);
    expect(renewed.status).toBe('active');

    release();
    await until((row) => row.status === 'completed');
    expect(runs).toBe(1);
    // stop() (afterEach) closes that connection; a second stop is harmless.
    await driver.stop();
    await driver.stop();
  });
});

describe('an interrupted automatic booking', () => {
  it('tells the merchant to check the courier, unless the order has its shipment by now', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    jest.spyOn(carriers, 'adapterFor').mockResolvedValue({});
    await db.CarrierAccount.create({ workspaceId: workspace.id, carrierCode: 'bosta', credentialsEncrypted: 'x', webhookToken: 'tok-auto-1', autoCreateOn: 'confirmed', isDefault: true });
    const order = (await request(app)
        .post(`/api/v1/workspaces/${workspace.id}/orders`)
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .set('Idempotency-Key', `ab-${Date.now()}`)
        .send({ items: [{ variantId: variant.id, quantity: 1 }], contact: { fullName: 'Auto Buyer', phone: '01022223333' }, shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 St' }, paymentMethod: 'cod' })).body.order;

    const event = { type: 'order.confirmed', workspaceId: workspace.id, payload: { orderId: order.id } };
    expect(await carrierBooking.autoBookInterrupted(event)).toEqual({ interrupted: true });
    const audit = await db.AuditLog.findOne({ where: { action: 'shipment.auto_booking_failed', entityId: order.id } });
    expect(audit.metadata.reason).toMatch(/stopped before it finished/);

    await db.Shipment.create({ workspaceId: workspace.id, orderId: order.id, carrierCode: 'bosta', status: 'created', trackingCode: 'TRK0000AUTO1' });
    expect(await carrierBooking.autoBookInterrupted(event)).toBeNull();
  });
});
