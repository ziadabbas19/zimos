'use strict';

// The J&T Express Egypt adapter end to end through the real endpoints,
// against a fake open platform behind carrierHttp.request
// (tests/helpers/fakeJtexpress.js). J&T is a beta carrier: it is switched on
// for this file only.

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct, confirmCodOrder } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const carrierHttp = require('../../src/modules/shipping/carriers/carrierHttp');
const accounts = require('../../src/modules/shipping/carrierAccountService');
const sync = require('../../src/modules/shipping/carrierSyncService');
const jt = require('../../src/modules/shipping/carriers/jtexpress');
const logger = require('../../src/core/utils/logger');
const fake = require('../helpers/fakeJtexpress');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const HOUR = 60 * 60 * 1000;
const CREDS = { apiAccount: fake.API_ACCOUNT, privateKey: fake.PRIVATE_KEY, customerCode: fake.CUSTOMER_CODE, password: fake.PASSWORD };
const SETTINGS = { ...fake.SENDER, defaultWeightGrams: 500 };
// Governorate + an area two levels below it (J&T: governorate > city > area).
const ADDRESS = { country: 'EG', province: 'القاهره', city: 'الحي السابع', addressLine: '12 Abbas El Akkad Street' };

let seq = 0;
const nextKey = () => `jt-${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2)}`;

const originalKey = env.carriers.credentialsKey;
const originalBeta = env.carriers.beta;
const originalBetaWorkspaces = env.carriers.betaWorkspaces;

beforeAll(() => {
  env.carriers.credentialsKey = crypto.randomBytes(32).toString('base64');
  env.carriers.beta = [...originalBeta, 'jtexpress'];
});

afterAll(() => {
  env.carriers.credentialsKey = originalKey;
  env.carriers.beta = originalBeta;
  env.carriers.betaWorkspaces = originalBetaWorkspaces;
});

beforeEach(() => {
  // Slugs repeat once the tables are truncated: each test starts empty.
  env.carriers.betaWorkspaces = originalBetaWorkspaces;
  fake.reset();
  accounts.clearCitiesCache();
  jest.spyOn(carrierHttp, 'request').mockImplementation(fake.handle);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// --- helpers -----------------------------------------------------------------------

async function store() {
  const setup = await setupWorkspaceWithProduct({ price: 12345, stock: 50 });
  env.carriers.betaWorkspaces = [...env.carriers.betaWorkspaces, String(setup.workspace.slug).toLowerCase()];
  const token = setup.auth.accessToken;
  const ws = setup.workspace.id;
  return { ...setup, token, ws, api: (method, path) => request(app)[method](`/api/v1/workspaces/${ws}${path}`).set(bearer(token)) };
}

const connect = (ctx, body = { credentials: CREDS, settings: SETTINGS }) => ctx.api('put', '/carriers/jtexpress').send(body);

async function connected(settings = SETTINGS) {
  const ctx = await store();
  const res = await connect(ctx, { credentials: CREDS, settings });
  if (res.status !== 200) throw new Error(`connect failed: ${res.status} ${JSON.stringify(res.body)}`);
  return ctx;
}

async function confirmedOrder(ctx, { address = ADDRESS, paymentMethod = 'cod' } = {}) {
  const res = await ctx
    .api('post', '/orders')
    .set('Idempotency-Key', nextKey())
    .send({
      items: [{ variantId: ctx.variant.id, quantity: 1 }],
      contact: { fullName: 'Mona Adel Hassan', phone: '+201012345678', email: 'mona@example.com' },
      shippingAddress: address,
      paymentMethod,
    });
  if (res.status !== 201) throw new Error(`order failed: ${res.status} ${JSON.stringify(res.body)}`);
  if (paymentMethod === 'cod') await confirmCodOrder(ctx.token, ctx.ws, res.body.order.id);
  return res.body.order;
}

const ship = (ctx, orderId, body = { carrierCode: 'jtexpress' }) => ctx.api('post', `/orders/${orderId}/shipments`).send(body);

async function booked(settings) {
  const ctx = await connected(settings);
  const order = await confirmedOrder(ctx);
  const res = await ship(ctx, order.id);
  if (res.status !== 201) throw new Error(`booking failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...ctx, order, shipment: res.body.shipment };
}

const addOrders = () => fake.callsTo('order/addOrder').map((c) => c.biz);

// --- signing + connecting -------------------------------------------------------------

describe('signing', () => {
  it('matches J&T\'s PHP example for both digests', () => {
    const bizContent = '{"billCodes":"UEG000000000001"}';
    expect(jt.headerDigest(bizContent, fake.PRIVATE_KEY)).toBe(fake.phpDigest(bizContent + fake.PRIVATE_KEY));
    expect(jt.businessDigest(CREDS)).toBe(fake.expectedBusinessDigest(fake.CUSTOMER_CODE, fake.PASSWORD, fake.PRIVATE_KEY));
  });
});

describe('connecting a J&T account', () => {
  it('checks the account with vip/checkCusPwd (signed form post), validates the pickup address, stores encrypted', async () => {
    const ctx = await store();
    const res = await connect(ctx);
    expect(res.status).toBe(200);

    const [check] = fake.callsTo('vip/checkCusPwd');
    expect(check.url).toBe('https://openapi.jtjms-eg.com/webopenplatformapi/api/vip/checkCusPwd');
    expect(check.headers).toMatchObject({ apiAccount: fake.API_ACCOUNT, timestamp: expect.stringMatching(/^\d{13}$/) });
    expect(check.biz).toEqual({ customerCode: fake.CUSTOMER_CODE, digest: expect.any(String) });
    expect(fake.callsTo('location/getLocation')).toHaveLength(1);
    expect(res.body.carrier.connection).toMatchObject({ status: 'active', settings: { senderArea: 'دجلة' } });

    const row = await db.CarrierAccount.scope('withCredentials').findOne({ where: { workspaceId: ctx.ws } });
    for (const secret of [fake.PRIVATE_KEY, fake.PASSWORD]) {
      expect(row.credentialsEncrypted).not.toContain(secret);
      expect(JSON.stringify(res.body)).not.toContain(secret);
    }
  });

  it('a wrong private key is 145003030: 422 naming the API account/private key', async () => {
    const ctx = await store();
    const res = await connect(ctx, { credentials: { ...CREDS, privateKey: 'not-the-private-key' }, settings: SETTINGS });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'CARRIER_AUTH_FAILED', message: expect.stringContaining('rejected the API account or private key') });
    expect(await db.CarrierAccount.count({ where: { workspaceId: ctx.ws } })).toBe(0);
  });

  it('a wrong customer password is 145003031: 422 naming the customer code/password', async () => {
    const ctx = await store();
    const res = await connect(ctx, { credentials: { ...CREDS, password: 'wrong' }, settings: SETTINGS });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('rejected the customer code or password');
    expect(JSON.stringify(res.body)).not.toContain(fake.PRIVATE_KEY);
  });

  it('refuses a partial pickup address, and one J&T\'s location list does not have', async () => {
    const ctx = await store();
    const partial = await connect(ctx, { credentials: CREDS, settings: { senderName: 'Zimos Store' } });
    expect(partial.status).toBe(422);
    expect(partial.body.error.details.map((d) => d.field)).toContain('settings.senderArea');

    const unknown = await connect(ctx, { credentials: CREDS, settings: { ...fake.SENDER, senderArea: 'Atlantis' } });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.details[0].field).toBe('settings.senderArea');

    const badMobile = await connect(ctx, { credentials: CREDS, settings: { ...fake.SENDER, senderMobile: '+447700900123' } });
    expect(badMobile.status).toBe(422);
    expect(await db.CarrierAccount.count({ where: { workspaceId: ctx.ws } })).toBe(0);
  });

  it('talks to J&T\'s sandbox host when the credentials say so', async () => {
    await jt.verifyCredentials({ ...CREDS, environment: 'sandbox' }, {});
    expect(fake.callsTo('vip/checkCusPwd')[0].url).toBe('https://demoopenapi.jtjms-eg.com/webopenplatformapi/api/vip/checkCusPwd');
  });
});

// --- address tree ---------------------------------------------------------------------

describe('the J&T address tree', () => {
  it('groups getLocation\'s flat rows into governorate > city > area', async () => {
    const ctx = await connected();
    const res = await ctx.api('get', '/carriers/jtexpress/cities');
    expect(res.status).toBe(200);
    expect(res.body.levels).toEqual(['governorate', 'city', 'area']);
    expect(res.body.cities.map((p) => [p.id, p.name])).toEqual([['1', 'القاهرة'], ['2', 'الجيزة']]);
    expect(res.body.cities[0].children.map((c) => c.id)).toEqual(['11', '12']);
    expect(res.body.cities[0].children[0].children.map((a) => [a.id, a.name])).toEqual([['111', 'الحي السابع'], ['112', 'الحي الاول']]);
    expect(fake.callsTo('location/getLocation').at(-1).biz).toEqual({ countryCode: 'EGY' });
  });

  it('matches an area two levels below the governorate and sends J&T\'s own names', async () => {
    const { shipment } = await booked();
    const [sent] = addOrders();
    expect(sent.receiver).toMatchObject({ countryCode: 'EGY', prov: 'القاهرة', city: 'مدينة نصر', area: 'الحي السابع', street: '12 Abbas El Akkad Street' });
    expect(shipment.carrierResponse.address).toEqual({ path: ['1', '11', '111'] });
  });

  it('asks for the level it could not match, then books with an explicit path', async () => {
    const ctx = await connected();
    const order = await confirmedOrder(ctx, { address: { ...ADDRESS, city: 'Unknown Place' } });
    const res = await ship(ctx, order.id);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'CARRIER_ADDRESS_UNMATCHED', details: { level: 'city', levels: ['governorate', 'city', 'area'] } });
    expect(addOrders()).toHaveLength(0);

    const retry = await ship(ctx, order.id, { carrierCode: 'jtexpress', carrierAddress: { path: ['1', '12', '121'] } });
    expect(retry.status).toBe(201);
    expect(addOrders()[0].receiver).toMatchObject({ city: 'المعادي', area: 'دجلة' });
  });
});

// --- booking -----------------------------------------------------------------------------

describe('booking a J&T shipment', () => {
  it('maps the order: COD in EGP, local 11-digit mobile, pickup address, fixed EZ/home delivery, one parcel', async () => {
    const { order, shipment } = await booked();
    const [sent] = addOrders();
    expect(sent).toMatchObject({
      customerCode: fake.CUSTOMER_CODE,
      txlogisticId: expect.stringMatching(new RegExp(`^${order.orderNumber}-[0-9A-Z]+$`)),
      expressType: 'EZ',
      deliveryType: '04',
      serviceType: '01',
      orderType: '2',
      payType: 'PP_PM',
      goodsType: 'ITN16',
      operateType: 1,
      totalQuantity: 1,
      weight: 0.5,
      itemsValue: (Number(order.totalAmount) / 100).toFixed(2),
      priceCurrency: 'EGP',
      sender: { name: 'Zimos Store', mobile: '01000000000', countryCode: 'EGY', prov: 'القاهرة', city: 'المعادي', area: 'دجلة', street: '9 Road 233' },
      receiver: { name: 'Mona Adel Hassan', mobile: '01012345678', mailBox: 'mona@example.com' },
    });
    expect(sent.sendStartTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(sent.items).toEqual([expect.objectContaining({ itemType: 'ITN16', number: 1, priceCurrency: 'EGP' })]);
    expect(shipment).toMatchObject({ carrierCode: 'jtexpress', status: 'created', waybillNumber: expect.stringMatching(/^UEG\d{12}$/) });
    expect(shipment.carrierResponse).toMatchObject({ carrierShipmentId: sent.txlogisticId, sortingCode: '20,J01-01,000' });
  });

  it('keeps no phone numbers or secrets on the shipment', async () => {
    const { shipment } = await booked();
    const stored = JSON.stringify(shipment.carrierResponse);
    for (const secret of ['01012345678', '01000000000', fake.PRIVATE_KEY, fake.PASSWORD]) expect(stored).not.toContain(secret);
  });

  it('sends a paid prepaid order with nothing to collect', async () => {
    const ctx = await connected();
    const order = await confirmedOrder(ctx, { paymentMethod: 'card' });
    const init = await ctx.api('post', `/orders/${order.id}/payments`).send({});
    expect((await ctx.api('post', `/payments/${init.body.payment.id}/capture`).send({})).status).toBe(200);
    expect((await ship(ctx, order.id)).status).toBe(201);
    expect(addOrders()[0].itemsValue).toBeUndefined();
  });

  it('declares the weight tier\'s bound in kg; above 30 kg it falls back to the order\'s own weight', async () => {
    const ctx = await connected();
    const tiers = await ctx.api('put', '/shipping/weight-tiers').send({ tiers: [{ upToGrams: 3000 }, { upToGrams: 50000 }] });
    const order = await confirmedOrder(ctx);
    expect((await ship(ctx, order.id, { carrierCode: 'jtexpress', tierId: tiers.body.tiers[0].id })).status).toBe(201);
    expect(addOrders()[0].weight).toBe(3);

    const base = { order: { currency: 'EGP', orderNumber: 'ORD-9', contactSnapshot: { fullName: 'A', phone: '01012345678' } }, address: { path: [{ name: 'القاهرة' }, { name: 'مدينة نصر' }, { name: 'الحي السابع' }], firstLine: '1 St' }, cod: 0, goodsValue: 100, description: '1x Thing', carrierSettings: fake.SENDER };
    await jt.createShipment(CREDS, { ...base, order: { ...base.order, totalWeightGrams: 1200 }, package: { weightGrams: 50000 } });
    expect(addOrders()[1].weight).toBe(1.2);
    await expect(jt.createShipment(CREDS, { ...base, package: { weightGrams: 50000 } })).rejects.toMatchObject({ code: 'CARRIER_WEIGHT_LIMIT', statusCode: 422 });
    await expect(jt.createShipment(CREDS, { ...base, package: { weightGrams: null } })).rejects.toMatchObject({ code: 'CARRIER_WEIGHT_REQUIRED', statusCode: 422 });
  });

  it('refuses before calling J&T: no pickup address, a non-EGP order, a non-Egyptian mobile', async () => {
    const input = (over = {}) => ({
      order: { currency: 'EGP', orderNumber: 'ORD-1', contactSnapshot: { fullName: 'A B', phone: '01012345678' }, ...over.order },
      address: { path: [{ name: 'القاهرة' }, { name: 'مدينة نصر' }, { name: 'الحي السابع' }], firstLine: '12 Street' },
      cod: 10000,
      goodsValue: 10000,
      description: '1x Thing',
      carrierSettings: over.settings || SETTINGS,
    });
    await expect(jt.createShipment(CREDS, input({ settings: { defaultWeightGrams: 500 } }))).rejects.toMatchObject({ code: 'CARRIER_SETTINGS_INCOMPLETE', statusCode: 422 });
    await expect(jt.createShipment(CREDS, input({ order: { currency: 'USD' } }))).rejects.toMatchObject({ code: 'CARRIER_CURRENCY_UNSUPPORTED' });
    await expect(jt.createShipment(CREDS, input({ order: { contactSnapshot: { fullName: 'A', phone: '+447700900123' } } }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(fake.state().calls).toHaveLength(0);
  });

  it('a J&T refusal is 502 CARRIER_ERROR with its message, recording nothing', async () => {
    const ctx = await connected();
    const order = await confirmedOrder(ctx);
    fake.state().refuseCreate = { code: '145003112', msg: 'Not yet open COD business' };
    const res = await ship(ctx, order.id);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({ code: 'CARRIER_ERROR', message: 'J&T Express: Not yet open COD business', details: { carrierErrorCode: '145003112' } });
    expect(await db.Shipment.count({ where: { orderId: order.id } })).toBe(0);
  });
});

// --- statuses ----------------------------------------------------------------------------

describe('J&T scan mapping', () => {
  it('maps every documented scan type code', () => {
    const expected = {
      1: 'picked_up', 2: 'in_transit', 3: 'in_transit', 4: 'in_transit', 5: 'in_transit', 6: 'in_transit', 7: null, 8: null,
      9: 'in_transit', 10: 'delivered', 11: 'failed', 12: 'failed', 13: 'returned', 14: 'failed', 15: 'in_transit',
    };
    for (const [code, status] of Object.entries(expected)) {
      expect([code, jt.mapStatus({ scanTypeCode: code }).status]).toEqual([code, status]);
    }
  });

  it('maps the labels the trace sample uses, in English and Chinese, and problemReason', () => {
    const cases = [
      [{ scanType: 'Pickup scan' }, 'picked_up'],
      [{ scanType: 'Sending scan' }, 'in_transit'],
      [{ scanType: 'Station arrival' }, 'in_transit'],
      [{ scanType: 'Delivery scan' }, 'out_for_delivery'],
      [{ scanType: 'Signing scan' }, 'delivered'],
      [{ scanType: '出仓扫描' }, 'in_transit'],
      [{ scanType: 'Something new', problemReason: '快件签收' }, 'delivered'],
      [{ scanType: 'Signing for express mail' }, 'delivered'],
    ];
    for (const [detail, status] of cases) expect([detail, jt.mapStatus(detail).status]).toEqual([detail, status]);
    expect(jt.mapStatus({ scanType: 'Something new' }).status).toBeUndefined();
  });

  it('a returned parcel (13) leaves a cancel nothing to stop; nothing else does', () => {
    expect(jt.isCancelSettled({ code: '13', value: 'Return signature' })).toBe(true);
    expect(jt.isCancelSettled({ code: 'Return signature', value: 'Return signature' })).toBe(true);
    expect(jt.isCancelSettled({ code: '10', value: 'Signing scan' })).toBe(false);
    expect(jt.isCancelSettled(null)).toBe(false);
  });
});

describe('polling J&T', () => {
  it('the sync cron reads due waybills with logistics/trace and applies the newest scan', async () => {
    const a = await booked();
    const second = (await ship(a, (await confirmedOrder(a)).id)).body.shipment;
    fake.addScan(a.shipment.waybillNumber, { scanType: 'Pickup scan', problemReason: '快件揽收' });
    fake.addScan(a.shipment.waybillNumber, { scanType: 'Signing scan', problemReason: '快件签收' });
    fake.addScan(second.waybillNumber, { scanType: 'Delivery scan', scanTypeCode: null, problemReason: '派件扫描' });

    await sync.syncDue({ now: new Date(Date.now() + 2 * HOUR) });
    const traces = fake.callsTo('logistics/trace');
    expect(traces).toHaveLength(1);
    expect(traces[0].biz.billCodes.split(',').sort()).toEqual([a.shipment.waybillNumber, second.waybillNumber].sort());

    const delivered = await db.Shipment.findByPk(a.shipment.id);
    expect(delivered.status).toBe('delivered');
    expect(delivered.carrierResponse.lastCarrierStatus).toMatchObject({ code: 'Signing scan', value: 'Signing scan' });
    expect(JSON.stringify(delivered.carrierResponse)).not.toContain('01099999999');
    expect((await db.Shipment.findByPk(second.id)).status).toBe('out_for_delivery');
  });

  it('a waybill with no scans yet stays created; an unknown scan warns and changes nothing', async () => {
    const ctx = await booked();
    const url = `/orders/${ctx.order.id}/shipments/${ctx.shipment.id}/sync`;
    const first = await ctx.api('post', url);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ changed: false, shipment: { status: 'created' } });

    const warn = jest.spyOn(logger, 'warn');
    fake.addScan(ctx.shipment.waybillNumber, { scanType: 'Brand new scan' });
    const second = await ctx.api('post', url);
    expect(second.body.shipment.status).toBe('created');
    expect(warn).toHaveBeenCalledWith('Unmapped J&T scan type — shipment status left unchanged', expect.objectContaining({ scanType: 'Brand new scan' }));
  });

  it('asks trace for at most 30 waybills per call', async () => {
    const refs = Array.from({ length: 31 }, (_, i) => `UEG${String(i + 1).padStart(12, '0')}`);
    await jt.getShipments(CREDS, refs);
    expect(fake.callsTo('logistics/trace').map((c) => c.biz.billCodes.split(',').length)).toEqual([30, 1]);
  });
});

// --- cancel ---------------------------------------------------------------------------------

describe('cancelling an order with a J&T shipment', () => {
  it('cancels at J&T by the txlogisticId we booked with, and the order can be booked again', async () => {
    const ctx = await booked();
    const res = await ctx.api('post', `/orders/${ctx.order.id}/cancel`).send({ reason: 'Customer changed their mind' });
    expect(res.status).toBe(200);
    const [cancel] = fake.callsTo('order/cancelOrder');
    expect(cancel.biz).toMatchObject({ customerCode: fake.CUSTOMER_CODE, orderType: '2', txlogisticId: ctx.shipment.carrierResponse.carrierShipmentId, reason: expect.any(String) });
    expect((await db.Shipment.findByPk(ctx.shipment.id)).status).toBe('cancelled');
  });

  it('a refused cancel is 409 CARRIER_CANCEL_FAILED and nothing changes', async () => {
    const ctx = await booked();
    fake.state().refuseCancel = 'Order already picked up';
    const res = await ctx.api('post', `/orders/${ctx.order.id}/cancel`).send({ reason: 'Customer changed their mind' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CARRIER_CANCEL_FAILED', message: expect.stringContaining('J&T Express: Order already picked up') });
    expect((await db.Shipment.findByPk(ctx.shipment.id)).status).toBe('created');
  });

  it('a refused cancel on a parcel J&T already returned (13) counts as done', async () => {
    const ctx = await booked();
    await db.Shipment.update({ status: 'failed' }, { where: { id: ctx.shipment.id } });
    fake.addScan(ctx.shipment.waybillNumber, { scanType: 'Return signature', scanTypeCode: 13 });
    fake.state().refuseCancel = 'Order cannot be cancelled';
    const res = await ctx.api('post', `/orders/${ctx.order.id}/cancel`).send({ reason: 'Customer changed their mind' });
    expect(res.status).toBe(200);
    expect((await db.Shipment.findByPk(ctx.shipment.id)).status).toBe('cancelled');
  });

  it('without a recorded txlogisticId the adapter refuses rather than guess', async () => {
    await expect(jt.cancelShipment(CREDS, 'UEG000000000001', {})).rejects.toMatchObject({ code: 'CARRIER_ERROR' });
    expect(fake.callsTo('order/cancelOrder')).toHaveLength(0);
  });
});

// --- label -----------------------------------------------------------------------------------

describe('the J&T label', () => {
  const getLabel = (ctx) =>
    ctx
      .api('get', `/orders/${ctx.order.id}/shipments/${ctx.shipment.id}/label`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  it('proxies printOrder\'s base64 PDF, with the label size setting and the COD amount shown', async () => {
    const ctx = await booked({ ...SETTINGS, printSize: 2 });
    const res = await getLabel(ctx);
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body, fake.PDF_BYTES)).toBe(0);
    expect(fake.callsTo('order/printOrder')[0].biz).toMatchObject({ billCode: ctx.shipment.waybillNumber, printSize: 2, printCod: 1 });
  });

  it('refuses anything that is not a PDF with 502', async () => {
    const ctx = await booked();
    fake.state().awbNotPdf = true;
    expect((await getLabel(ctx)).status).toBe(502);
  });
});

describe('rollout', () => {
  it('J&T is invisible to a store outside CARRIERS_BETA_WORKSPACES', async () => {
    const outside = await setupWorkspaceWithProduct();
    const api = (method, p) => request(app)[method](`/api/v1/workspaces/${outside.workspace.id}${p}`).set(bearer(outside.auth.accessToken));
    expect((await api('get', '/carriers')).body.carriers.map((c) => c.code)).toEqual(['bosta']);
    expect((await api('put', '/carriers/jtexpress').send({ credentials: CREDS })).status).toBe(404);
    expect(fake.state().calls).toHaveLength(0);
  });
});

// --- the sandbox ------------------------------------------------------------------------

describe('the J&T sandbox is for test stores only', () => {
  const SANDBOX = { ...CREDS, environment: 'sandbox' };
  const originalEnabled = env.carriers.enabled;
  afterEach(() => {
    env.carriers.enabled = originalEnabled;
  });

  /** A store J&T is available to (J&T switched on for everyone) but that is not a test store. */
  async function regularStore() {
    env.carriers.enabled = [...originalEnabled, 'jtexpress'];
    const setup = await setupWorkspaceWithProduct({ price: 12345, stock: 50 });
    const token = setup.auth.accessToken;
    const ws = setup.workspace.id;
    return { ...setup, token, ws, api: (method, path) => request(app)[method](`/api/v1/workspaces/${ws}${path}`).set(bearer(token)) };
  }

  it('a test store (CARRIERS_BETA_WORKSPACES) may connect the sandbox', async () => {
    const ctx = await store();
    const res = await connect(ctx, { credentials: SANDBOX, settings: SETTINGS });
    expect(res.status).toBe(200);
    expect(fake.callsTo('vip/checkCusPwd')[0].url).toMatch(/^https:\/\/demoopenapi\.jtjms-eg\.com\//);
  });

  it('the connection says which environment it is on, in the connect response and the listing, and no credential value', async () => {
    const ctx = await store();
    const sandbox = await connect(ctx, { credentials: SANDBOX, settings: SETTINGS });
    expect(sandbox.body.carrier.connection.environment).toBe('sandbox');
    let list = await ctx.api('get', '/carriers');
    expect(list.body.carriers.find((c) => c.code === 'jtexpress').connection.environment).toBe('sandbox');

    const production = await connect(ctx, { credentials: CREDS, settings: SETTINGS });
    expect(production.body.carrier.connection.environment).toBe('production');
    // A settings-only save reads the stored credentials.
    const settingsOnly = await connect(ctx, { settings: SETTINGS });
    expect(settingsOnly.body.carrier.connection.environment).toBe('production');
    list = await ctx.api('get', '/carriers');
    const listed = list.body.carriers.find((c) => c.code === 'jtexpress').connection;
    expect(listed.environment).toBe('production');

    for (const res of [sandbox, production, settingsOnly, list]) {
      const text = JSON.stringify(res.body);
      for (const secret of [fake.PRIVATE_KEY, fake.PASSWORD, fake.API_ACCOUNT, fake.CUSTOMER_CODE]) {
        expect(text).not.toContain(secret);
      }
    }
    expect(listed).not.toHaveProperty('credentials');
  });

  it('any other store gets 422 on credentials.environment, before J&T is called, and nothing is stored', async () => {
    const ctx = await regularStore();
    const res = await connect(ctx, { credentials: SANDBOX, settings: SETTINGS });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([
      { field: 'credentials.environment', message: expect.stringContaining('only creates test shipments') },
    ]);
    expect(fake.state().calls).toHaveLength(0);
    expect(await db.CarrierAccount.count({ where: { workspaceId: ctx.ws } })).toBe(0);

    // Production is fine for the same store.
    expect((await connect(ctx, { credentials: CREDS, settings: SETTINGS })).status).toBe(200);
  });

  it('a stored sandbox connection books nothing once the store is no longer a test store', async () => {
    const ctx = await store();
    expect((await connect(ctx, { credentials: SANDBOX, settings: SETTINGS })).status).toBe(200);
    const order = await confirmedOrder(ctx);

    // J&T goes live for everyone and the store leaves the test list.
    env.carriers.enabled = [...originalEnabled, 'jtexpress'];
    env.carriers.betaWorkspaces = [];

    const res = await ship(ctx, order.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CARRIER_SANDBOX_NOT_ALLOWED');
    expect(addOrders()).toHaveLength(0);
    expect(await db.Shipment.count({ where: { orderId: order.id } })).toBe(0);

    // Re-saving settings keeps the stored sandbox credentials: refused too.
    const resave = await connect(ctx, { settings: SETTINGS });
    expect(resave.status).toBe(422);
    expect(resave.body.error.details[0].field).toBe('credentials.environment');
  });
});
