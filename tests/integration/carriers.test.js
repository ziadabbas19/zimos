'use strict';

// Merchant courier accounts and Bosta shipments, end to end through the real
// endpoints. Bosta itself is a fake behind carrierHttp.request — nothing here
// ever reaches app.bosta.co. The fake answers in the shapes Bosta's OpenAPI
// spec documents (https://docs.bosta.co/api/api.yaml).

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const carrierHttp = require('../../src/modules/shipping/carriers/carrierHttp');
const accounts = require('../../src/modules/shipping/carrierAccountService');
const webhooks = require('../../src/modules/shipping/carrierWebhookService');
const waybillService = require('../../src/modules/waybill/waybillService');
const bosta = require('../../src/modules/shipping/carriers/bosta');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const VALID_KEY = 'bosta-valid-api-key-0001';
const OTHER_VALID_KEY = 'bosta-valid-api-key-0002';
const BAD_KEY = 'bosta-revoked-api-key-9999';

// --- fake Bosta ---------------------------------------------------------------

const CITIES = [
  {
    cityId: 'CAI',
    cityName: 'Cairo',
    cityOtherName: 'القاهرة',
    cityCode: 'EG-01',
    dropOffAvailability: true,
    districts: [
      { zoneId: 'Z-NASR', zoneName: 'Nasr City', zoneOtherName: 'مدينة نصر', districtId: 'D-NASR', districtName: 'Nasr City', districtOtherName: 'مدينة نصر', dropOffAvailability: true },
      { zoneId: 'Z-MAADI', zoneName: 'Maadi', zoneOtherName: 'المعادي', districtId: 'D-MAADI', districtName: 'Maadi', districtOtherName: 'المعادى', dropOffAvailability: true },
      { zoneId: 'Z-NC', zoneName: 'New Cairo', zoneOtherName: 'القاهره الجديده', districtId: 'D-NC10', districtName: '1st Settlement - District 10', districtOtherName: 'التجمع الاول - الحي 10', dropOffAvailability: true },
      { zoneId: 'Z-NC', zoneName: 'New Cairo', zoneOtherName: 'القاهره الجديده', districtId: 'D-NC11', districtName: '1st Settlement - District 11', districtOtherName: 'التجمع الاول - الحي 11', dropOffAvailability: true },
      { zoneId: 'Z-15', zoneName: '15 May', zoneOtherName: '١٥ مايو', districtId: 'D-15', districtName: '15 May', districtOtherName: '١٥ مايو', dropOffAvailability: true },
    ],
  },
  {
    cityId: 'GIZ',
    cityName: 'Giza',
    cityOtherName: 'الجيزة',
    cityCode: 'EG-03',
    dropOffAvailability: true,
    districts: [
      { zoneId: 'Z-DOKKI', zoneName: 'Dokki', zoneOtherName: 'الدقي', districtId: 'D-DOKKI', districtName: 'Dokki', districtOtherName: 'الدقى', dropOffAvailability: true },
      { zoneId: 'Z-6OCT', zoneName: '6th of October', zoneOtherName: 'السادس من أكتوبر', districtId: 'D-6OCT', districtName: '6th of October', districtOtherName: '٦ أكتوبر', dropOffAvailability: true },
    ],
  },
];

const PDF_BYTES = Buffer.from('%PDF-1.4\n% fake bosta awb\n');

let fake;

function resetFake() {
  fake = {
    calls: [],
    deliveries: new Map(),
    nextTracking: 71000001,
    refuseTerminate: false,
  };
}

const reply = (status, json) => ({
  status,
  ok: status >= 200 && status < 300,
  json,
  text: JSON.stringify(json),
  headers: new Map(),
});

async function fakeBosta({ method = 'GET', url, headers = {}, body }) {
  const { pathname } = new URL(url);
  const path = pathname.replace(/^\/api\/v2/, '');
  fake.calls.push({ method, path, body, headers });

  if (![VALID_KEY, OTHER_VALID_KEY].includes(headers.Authorization)) {
    return reply(401, { success: false, message: 'User is not authorized!', errorCode: 1007, data: null });
  }

  if (method === 'GET' && path === '/pickup-locations') {
    return reply(200, {
      success: true,
      message: 'Done successfully.',
      data: { total: 1, list: [{ _id: 'LOC-1', locationName: 'Main warehouse', isDefault: true }], page: 1, limit: 50, pages: 1 },
    });
  }
  if (method === 'GET' && path === '/cities/getAllDistricts') {
    return reply(200, { success: true, message: 'Done successfully.', data: CITIES });
  }
  if (method === 'POST' && path === '/deliveries') {
    const trackingNumber = String(fake.nextTracking++);
    const delivery = {
      _id: `DLV-${trackingNumber}`,
      trackingNumber,
      businessReference: body.businessReference,
      state: { code: 10, value: 'Pickup requested' },
      type: { code: 10, value: 'Send' },
      owner: headers.Authorization,
    };
    fake.deliveries.set(trackingNumber, delivery);
    return reply(200, {
      success: true,
      message: 'Done successfully.',
      data: {
        _id: delivery._id,
        trackingNumber,
        businessReference: body.businessReference,
        sender: { _id: 'S1', phone: '+201065685435', name: 'Business Name', type: 'BUSINESS_ACCOUNT' },
        message: 'Delivery created successfully!',
        state: delivery.state,
        creationSrc: 'API',
      },
    });
  }
  const view = path.match(/^\/deliveries\/business\/([^/]+)$/);
  if (method === 'GET' && view) {
    const delivery = fake.deliveries.get(view[1]);
    if (!delivery || delivery.owner !== headers.Authorization) {
      return reply(404, { success: false, message: 'Delivery not found', errorCode: 1066, data: null });
    }
    return reply(200, {
      success: true,
      data: {
        _id: delivery._id,
        trackingNumber: delivery.trackingNumber,
        state: delivery.state,
        type: delivery.type,
        receiver: { firstName: 'Should', lastName: 'NotBeStored', phone: '01000000000' },
        holder: { _id: 'H1', name: 'Bosta Bronz', phone: '01099999999', role: 'BUSINESS_ADMIN' },
      },
    });
  }
  const terminate = path.match(/^\/deliveries\/business\/([^/]+)\/terminate$/);
  if (method === 'DELETE' && terminate) {
    if (fake.refuseTerminate) {
      return reply(400, { success: false, message: 'Delivery can not be terminated in its current state', errorCode: 1070, data: null });
    }
    const delivery = fake.deliveries.get(terminate[1]);
    if (!delivery) return reply(404, { success: false, message: 'Delivery not found', errorCode: 1066, data: null });
    delivery.state = { code: 48, value: 'Terminated' };
    return reply(200, { success: true, message: 'Delivery has been terminated successfully.', data: { _id: delivery._id } });
  }
  if (method === 'POST' && path === '/deliveries/mass-awb') {
    return reply(200, { success: true, data: PDF_BYTES.toString('base64') });
  }
  return reply(404, { success: false, message: `fake bosta: no route ${method} ${path}`, data: null });
}

/** Moves a delivery inside the fake, as Bosta's own operations would. */
function setBostaState(trackingNumber, code, type = { code: 10, value: 'Send' }) {
  const delivery = fake.deliveries.get(String(trackingNumber));
  delivery.state = { code, value: bosta.STATE_NAMES[code] || 'unknown' };
  delivery.type = type;
}

const callsTo = (method, path) => fake.calls.filter((c) => c.method === method && c.path === path);

// --- app helpers ----------------------------------------------------------------

let seq = 0;
const nextKey = () => `carrier-${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2)}`;

const DEFAULT_ADDRESS = { country: 'EG', province: 'القاهره', city: 'مدينه نصر', addressLine: '12 Abbas El Akkad Street' };

async function placeOrder(token, workspaceId, variantId, { address = DEFAULT_ADDRESS, paymentMethod = 'cod', quantity = 1 } = {}) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', nextKey())
    .send({
      items: [{ variantId, quantity }],
      contact: { fullName: 'Mona Adel Hassan', phone: '+201012345678', email: 'mona@example.com' },
      shippingAddress: address,
      paymentMethod,
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

async function confirmOrder(token, workspaceId, orderId) {
  const task = await db.ConfirmationTask.findOne({ where: { orderId } });
  await request(app).post(`/api/v1/workspaces/${workspaceId}/confirmation-tasks/${task.id}/claim`).set(bearer(token)).send({});
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/confirmation-tasks/${task.id}/outcome`)
    .set(bearer(token))
    .send({ outcome: 'confirmed' });
  if (res.status !== 200) throw new Error(`confirm failed: ${res.status} ${JSON.stringify(res.body)}`);
}

async function payOrder(token, workspaceId, orderId) {
  const init = await request(app).post(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/payments`).set(bearer(token)).send({});
  const captured = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/payments/${init.body.payment.id}/capture`)
    .set(bearer(token))
    .send({});
  if (captured.status !== 200) throw new Error(`capture failed: ${captured.status} ${JSON.stringify(captured.body)}`);
}

const connectBosta = (token, workspaceId, body = { credentials: { apiKey: VALID_KEY } }) =>
  request(app).put(`/api/v1/workspaces/${workspaceId}/carriers/bosta`).set(bearer(token)).send(body);

const createShipment = (token, workspaceId, orderId, body = { carrierCode: 'bosta' }) =>
  request(app).post(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/shipments`).set(bearer(token)).send(body);

const getOrder = (token, workspaceId, orderId) =>
  request(app).get(`/api/v1/workspaces/${workspaceId}/orders/${orderId}`).set(bearer(token));

const cancelOrder = (token, workspaceId, orderId) =>
  request(app).post(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/cancel`).set(bearer(token)).send({ reason: 'Customer changed their mind' });

async function postWebhook(token, body, code = 'bosta') {
  const res = await request(app).post(`/api/v1/webhooks/carriers/${code}/${token}`).send(body);
  await webhooks.whenIdle();
  return res;
}

/** A connected workspace with one confirmed COD order, ready to book. */
async function readyToBook(opts = {}) {
  const setup = await setupWorkspaceWithProduct({ price: 12345, stock: 20 });
  const token = setup.auth.accessToken;
  const connected = await connectBosta(token, setup.workspace.id);
  if (connected.status !== 200) throw new Error(`connect failed: ${connected.status} ${JSON.stringify(connected.body)}`);
  const order = await placeOrder(token, setup.workspace.id, setup.variant.id, opts);
  await confirmOrder(token, setup.workspace.id, order.id);
  return { ...setup, token, order, webhookToken: connected.body.carrier.connection.webhookUrl.split('/').pop() };
}

async function bookedShipment(opts) {
  const ctx = await readyToBook(opts);
  const res = await createShipment(ctx.token, ctx.workspace.id, ctx.order.id);
  if (res.status !== 201) throw new Error(`createShipment failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...ctx, shipment: res.body.shipment };
}

// --- setup ------------------------------------------------------------------------

const originalKey = env.carriers.credentialsKey;
const originalAppUrl = env.appUrl;
let httpSpy;

beforeAll(() => {
  env.carriers.credentialsKey = crypto.randomBytes(32).toString('base64');
  env.appUrl = 'https://api.zimos.test';
});

afterAll(() => {
  env.carriers.credentialsKey = originalKey;
  env.appUrl = originalAppUrl;
});

beforeEach(() => {
  resetFake();
  accounts.clearCitiesCache();
  httpSpy = jest.spyOn(carrierHttp, 'request').mockImplementation(fakeBosta);
});

afterEach(() => {
  httpSpy.mockRestore();
});

// --- tests ------------------------------------------------------------------------

describe('connecting a Bosta account', () => {
  it('lists Bosta as available and not connected', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await request(app).get(`/api/v1/workspaces/${workspace.id}/carriers`).set(bearer(auth.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    const entry = res.body.carriers.find((c) => c.code === 'bosta');
    expect(entry).toMatchObject({ name: 'Bosta', webhookSetup: 'per_shipment', supportsLabel: true, connection: null });
    expect(entry.credentialFields).toEqual([{ key: 'apiKey', label: 'API key', secret: true }]);
  });

  it('verifies a good key with Bosta, stores it encrypted and returns the webhook URL', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await connectBosta(auth.accessToken, workspace.id, {
      credentials: { apiKey: VALID_KEY },
      settings: { businessLocationId: 'LOC-1', awbLang: 'en' },
    });

    expect(res.status).toBe(200);
    expect(callsTo('GET', '/pickup-locations')).toHaveLength(1);
    expect(res.body.carrier.connection).toMatchObject({ status: 'active', settings: { businessLocationId: 'LOC-1', awbLang: 'en' } });
    expect(res.body.webhook.setup).toBe('per_shipment');
    expect(res.body.webhook.manualSetupRequired).toBe(false);
    expect(res.body.webhook.url).toMatch(/^https:\/\/api\.zimos\.test\/api\/v1\/webhooks\/carriers\/bosta\/[A-Za-z0-9_-]{43}$/);
    expect(res.body.verification.pickupLocations).toEqual([{ id: 'LOC-1', name: 'Main warehouse', isDefault: true }]);

    const row = await db.CarrierAccount.scope('withCredentials').findOne({ where: { workspaceId: workspace.id } });
    expect(row.credentialsEncrypted).toMatch(/^v1:/);
    expect(row.credentialsEncrypted).not.toContain(VALID_KEY);
    expect(JSON.stringify(res.body)).not.toContain(VALID_KEY);
  });

  it('rejects a bad key with 422 and stores nothing', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await connectBosta(auth.accessToken, workspace.id, { credentials: { apiKey: BAD_KEY } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CARRIER_AUTH_FAILED');
    expect(await db.CarrierAccount.count({ where: { workspaceId: workspace.id } })).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain(BAD_KEY);
  });

  it('validates credentials and settings per adapter', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const missing = await connectBosta(auth.accessToken, workspace.id, { credentials: {} });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details[0].field).toBe('credentials.apiKey');

    const badLocation = await connectBosta(auth.accessToken, workspace.id, {
      credentials: { apiKey: VALID_KEY },
      settings: { businessLocationId: 'NOT-MINE' },
    });
    expect(badLocation.status).toBe(422);
    expect(badLocation.body.error.details[0].field).toBe('settings.businessLocationId');
    expect(await db.CarrierAccount.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  it('never puts credentials in a response or an audit row, and keeps the webhook token on re-connect', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const first = await connectBosta(auth.accessToken, workspace.id);
    const second = await connectBosta(auth.accessToken, workspace.id, { credentials: { apiKey: OTHER_VALID_KEY } });
    const settingsOnly = await connectBosta(auth.accessToken, workspace.id, { settings: { awbType: 'A6' } });
    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/carriers`).set(bearer(auth.accessToken));

    expect(second.status).toBe(200);
    expect(settingsOnly.status).toBe(200);
    expect(settingsOnly.body.carrier.connection.settings).toEqual({ awbType: 'A6' });
    expect(second.body.webhook.url).toBe(first.body.webhook.url);

    for (const res of [first, second, settingsOnly, list]) {
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(VALID_KEY);
      expect(text).not.toContain(OTHER_VALID_KEY);
      expect(text).not.toContain('credentialsEncrypted');
    }

    const audits = await db.AuditLog.findAll({ where: { workspaceId: workspace.id, entityType: 'CarrierAccount' } });
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['carrier_account.connect', 'carrier_account.update'])
    );
    const auditText = JSON.stringify(audits.map((a) => a.toJSON()));
    expect(auditText).not.toContain(VALID_KEY);
    expect(auditText).not.toContain(OTHER_VALID_KEY);
    expect(auditText).not.toContain('v1:');
    expect(audits.find((a) => a.action === 'carrier_account.connect').afterState.credentialsUpdated).toBe(true);
  });

  it('disconnects; the webhook token stops resolving', async () => {
    const ctx = await bookedShipment();
    const res = await request(app).delete(`/api/v1/workspaces/${ctx.workspace.id}/carriers/bosta`).set(bearer(ctx.token));
    expect(res.status).toBe(200);
    expect(await db.CarrierAccount.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);
    // The shipment keeps its data.
    const shipment = await db.Shipment.findByPk(ctx.shipment.id);
    expect(shipment.waybillNumber).toBe(ctx.shipment.waybillNumber);

    const hook = await postWebhook(ctx.webhookToken, { trackingNumber: ctx.shipment.waybillNumber, state: 45 });
    expect(hook.status).toBe(404);
  });

  it('serves the cities list, cached per workspace', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    await connectBosta(auth.accessToken, workspace.id);
    const first = await request(app).get(`/api/v1/workspaces/${workspace.id}/carriers/bosta/cities`).set(bearer(auth.accessToken));
    const second = await request(app)
      .get(`/api/v1/workspaces/${workspace.id}/carriers/bosta/cities?cityId=GIZ`)
      .set(bearer(auth.accessToken));

    expect(first.status).toBe(200);
    expect(first.body.cities.map((c) => c.id)).toEqual(['CAI', 'GIZ']);
    expect(first.body.cities[0].districts[0]).toEqual({
      id: 'D-NASR',
      name: 'Nasr City',
      nameAr: 'مدينة نصر',
      zoneId: 'Z-NASR',
      zoneName: 'Nasr City',
      zoneNameAr: 'مدينة نصر',
      dropOffAvailable: true,
    });
    expect(second.body.cities.map((c) => c.id)).toEqual(['GIZ']);
    expect(callsTo('GET', '/cities/getAllDistricts')).toHaveLength(1);
  });
});

describe('without CARRIER_CREDENTIALS_KEY', () => {
  let key;
  beforeEach(() => {
    key = env.carriers.credentialsKey;
  });
  afterEach(() => {
    env.carriers.credentialsKey = key;
  });

  it('answers 503 for carrier features and leaves manual shipments working', async () => {
    const ctx = await readyToBook();
    env.carriers.credentialsKey = '';

    const connect = await connectBosta(ctx.token, ctx.workspace.id);
    expect(connect.status).toBe(503);
    expect(connect.body.error.code).toBe('CARRIERS_NOT_CONFIGURED');

    const booking = await createShipment(ctx.token, ctx.workspace.id, ctx.order.id);
    expect(booking.status).toBe(503);
    expect(booking.body.error.code).toBe('CARRIERS_NOT_CONFIGURED');

    const list = await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/carriers`).set(bearer(ctx.token));
    expect(list.status).toBe(200);
    expect(list.body.configured).toBe(false);

    const manual = await createShipment(ctx.token, ctx.workspace.id, ctx.order.id, { carrierCode: 'manual', waybillNumber: 'M-1' });
    expect(manual.status).toBe(201);
  });
});

describe('booking a Bosta shipment', () => {
  it('creates it at Bosta, stores the tracking number, and sends COD in EGP', async () => {
    const ctx = await readyToBook({ quantity: 2 });
    const res = await createShipment(ctx.token, ctx.workspace.id, ctx.order.id, { carrierCode: 'bosta', notes: 'Call before arriving' });

    expect(res.status).toBe(201);
    const creates = callsTo('POST', '/deliveries');
    expect(creates).toHaveLength(1);
    const sent = creates[0].body;

    const order = await db.Order.findByPk(ctx.order.id);
    // Our minor units (piastres) -> Bosta's EGP.
    expect(sent.cod).toBe(Number(order.totalAmount) / 100);
    expect(sent.cod).toBe(246.9);
    expect(sent.type).toBe(10);
    expect(sent.goodsInfo).toEqual({ amount: 246.9 });
    expect(sent.specs).toEqual({ packageType: 'Parcel', packageDetails: { itemsCount: 2, description: '2x Test Product' } });
    expect(sent.dropOffAddress).toEqual({ city: 'Cairo', districtId: 'D-NASR', zoneId: 'Z-NASR', firstLine: '12 Abbas El Akkad Street' });
    expect(sent.receiver).toEqual({ firstName: 'Mona', lastName: 'Adel Hassan', phone: '01012345678', email: 'mona@example.com' });
    expect(sent.businessReference).toBe(order.orderNumber);
    expect(sent.notes).toBe('Call before arriving');
    expect(sent.webhookUrl).toBe(`https://api.zimos.test/api/v1/webhooks/carriers/bosta/${ctx.webhookToken}`);
    expect(creates[0].headers.Authorization).toBe(VALID_KEY);

    const trackingNumber = [...fake.deliveries.keys()][0];
    expect(res.body.shipment).toMatchObject({ carrierCode: 'bosta', waybillNumber: trackingNumber, status: 'created', trackingUrl: null });
    expect(res.body.shipment.trackingCode).toMatch(/^zg\d{9}$/);
    // The stored carrier response is a whitelist: no sender phone.
    expect(JSON.stringify(res.body.shipment.carrierResponse)).not.toContain('01065685435');
    expect(res.body.shipment.carrierResponse).toMatchObject({ _id: `DLV-${trackingNumber}`, trackingNumber, carrierShipmentId: `DLV-${trackingNumber}` });

    // The printed waybill carries Bosta's number, not our zg code.
    const model = await waybillService.computeWaybillModel(ctx.workspace.id, ctx.order.id);
    expect(model.trackingValue).toBe(trackingNumber);

    const audit = await db.AuditLog.findOne({ where: { entityId: res.body.shipment.id, action: 'shipment.create' } });
    expect(audit.metadata).toEqual({ source: 'carrier', carrierCode: 'bosta' });
  });

  it('collects only the outstanding amount, and nothing for a paid prepaid order', async () => {
    const setup = await setupWorkspaceWithProduct({ price: 50000, stock: 5 });
    const token = setup.auth.accessToken;
    await connectBosta(token, setup.workspace.id);

    const prepaid = await placeOrder(token, setup.workspace.id, setup.variant.id, { paymentMethod: 'card' });
    const unpaid = await createShipment(token, setup.workspace.id, prepaid.id);
    expect(unpaid.status).toBe(409);
    expect(unpaid.body.error.code).toBe('ORDER_NOT_PAID');

    await payOrder(token, setup.workspace.id, prepaid.id);
    const res = await createShipment(token, setup.workspace.id, prepaid.id);
    expect(res.status).toBe(201);
    expect(callsTo('POST', '/deliveries')[0].body.cod).toBe(0);

    // A COD order with part already paid: the courier collects the rest.
    const cod = await placeOrder(token, setup.workspace.id, setup.variant.id);
    await confirmOrder(token, setup.workspace.id, cod.id);
    await db.Order.update({ amountPaid: 20000 }, { where: { id: cod.id } });
    const partial = await createShipment(token, setup.workspace.id, cod.id);
    expect(partial.status).toBe(201);
    expect(callsTo('POST', '/deliveries')[1].body.cod).toBe(300);
  });

  it('refuses unconfirmed and cancelled orders with 409, without calling Bosta', async () => {
    const setup = await setupWorkspaceWithProduct({ stock: 5 });
    const token = setup.auth.accessToken;
    await connectBosta(token, setup.workspace.id);

    const unconfirmed = await placeOrder(token, setup.workspace.id, setup.variant.id);
    const res1 = await createShipment(token, setup.workspace.id, unconfirmed.id);
    expect(res1.status).toBe(409);
    expect(res1.body.error.code).toBe('ORDER_NOT_CONFIRMED');

    const cancelled = await placeOrder(token, setup.workspace.id, setup.variant.id);
    await confirmOrder(token, setup.workspace.id, cancelled.id);
    await cancelOrder(token, setup.workspace.id, cancelled.id);
    const res2 = await createShipment(token, setup.workspace.id, cancelled.id);
    expect(res2.status).toBe(409);
    expect(res2.body.error.code).toBe('ORDER_CANCELLED');

    expect(callsTo('POST', '/deliveries')).toHaveLength(0);
    expect(await db.Shipment.count({ where: { workspaceId: setup.workspace.id } })).toBe(0);
  });

  it('a double click books one shipment: one Bosta call, the second request gets 409', async () => {
    const ctx = await readyToBook();
    const [a, b] = await Promise.all([
      createShipment(ctx.token, ctx.workspace.id, ctx.order.id),
      createShipment(ctx.token, ctx.workspace.id, ctx.order.id),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409).body.error.code).toBe('SHIPMENT_ALREADY_EXISTS');
    expect(callsTo('POST', '/deliveries')).toHaveLength(1);
    expect(await db.Shipment.count({ where: { orderId: ctx.order.id } })).toBe(1);
  });

  it('asks for the district when the address does not match, then books with the explicit ids', async () => {
    const ctx = await readyToBook({
      address: { country: 'EG', province: 'Cairo', city: 'Settlement', addressLine: '5 Ninetieth Street, villa 7' },
    });
    const res = await createShipment(ctx.token, ctx.workspace.id, ctx.order.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CARRIER_ADDRESS_UNMATCHED');
    const details = res.body.error.details;
    expect(details).toMatchObject({
      carrierCode: 'bosta',
      level: 'district',
      orderAddress: { province: 'Cairo', city: 'Settlement' },
      matchedCity: { id: 'CAI', name: 'Cairo', nameAr: 'القاهرة' },
    });
    // Partial matches come first, flagged; then the rest of the city.
    expect(details.candidates.slice(0, 2).map((c) => [c.districtId, c.suggested])).toEqual([
      ['D-NC10', true],
      ['D-NC11', true],
    ]);
    expect(details.candidates).toHaveLength(5);
    expect(details.candidates[0]).toEqual({
      cityId: 'CAI',
      cityName: 'Cairo',
      cityNameAr: 'القاهرة',
      districtId: 'D-NC10',
      districtName: '1st Settlement - District 10',
      districtNameAr: 'التجمع الاول - الحي 10',
      zoneId: 'Z-NC',
      zoneName: 'New Cairo',
      suggested: true,
    });
    expect(callsTo('POST', '/deliveries')).toHaveLength(0);

    const explicit = await createShipment(ctx.token, ctx.workspace.id, ctx.order.id, {
      carrierCode: 'bosta',
      carrierAddress: { cityId: 'CAI', districtId: 'D-NC11' },
    });
    expect(explicit.status).toBe(201);
    expect(callsTo('POST', '/deliveries')[0].body.dropOffAddress).toMatchObject({ city: 'Cairo', districtId: 'D-NC11', zoneId: 'Z-NC' });

    // Ids that aren't Bosta's are refused, never passed through.
    const other = await readyToBook();
    const wrong = await createShipment(other.token, other.workspace.id, other.order.id, {
      carrierCode: 'bosta',
      carrierAddress: { cityId: 'GIZ', districtId: 'D-NASR' },
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.details[0].field).toBe('carrierAddress.districtId');
  });

  it('asks for the city when the governorate is unknown', async () => {
    const ctx = await readyToBook({ address: { country: 'EG', province: 'Atlantis', city: 'Downtown', addressLine: '1 Unknown Road Here' } });
    const res = await createShipment(ctx.token, ctx.workspace.id, ctx.order.id);
    expect(res.status).toBe(422);
    expect(res.body.error.details.level).toBe('city');
    expect(res.body.error.details.matchedCity).toBeNull();
    expect(res.body.error.details.candidates.map((c) => c.cityId)).toEqual(['CAI', 'GIZ']);
  });

  it.each([
    [{ province: 'الجيزه', city: 'السادس من اكتوبر' }, 'D-6OCT'],
    [{ province: 'Giza Governorate', city: '6 October' }, 'D-6OCT'],
    [{ province: 'El Giza', city: 'Al-Dokki' }, 'D-DOKKI'],
    [{ province: 'محافظة القاهرة', city: '15 مايو' }, 'D-15'],
    [{ province: null, city: 'Cairo' }, null],
  ])('matches common spellings: %j', async (address, districtId) => {
    const ctx = await readyToBook({ address: { country: 'EG', addressLine: '99 Some Long Street', ...address } });
    const res = await createShipment(ctx.token, ctx.workspace.id, ctx.order.id);
    if (districtId) {
      expect(res.status).toBe(201);
      expect(callsTo('POST', '/deliveries')[0].body.dropOffAddress.districtId).toBe(districtId);
    } else {
      // "Cairo" as the city is the governorate — no district to match on.
      expect(res.status).toBe(422);
      expect(res.body.error.details).toMatchObject({ level: 'district', matchedCity: { id: 'CAI' } });
    }
  });

  it('marks the account invalid when Bosta rejects the stored key', async () => {
    const ctx = await readyToBook();
    // Bosta revokes the key after it was connected.
    httpSpy.mockImplementation((opts) => fakeBosta({ ...opts, headers: { ...opts.headers, Authorization: BAD_KEY } }));
    const res = await createShipment(ctx.token, ctx.workspace.id, ctx.order.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CARRIER_AUTH_FAILED');
    const account = await db.CarrierAccount.findOne({ where: { workspaceId: ctx.workspace.id } });
    expect(account.status).toBe('invalid');
    expect(await db.Shipment.count({ where: { orderId: ctx.order.id } })).toBe(0);
  });

  it('turns other Bosta errors into 502 CARRIER_ERROR with the sanitised message', async () => {
    const ctx = await readyToBook();
    httpSpy.mockImplementation(async (opts) =>
      opts.method === 'POST'
        ? reply(400, { success: false, message: `City Not Found for key ${VALID_KEY}`, errorCode: 3001, data: null })
        : fakeBosta(opts)
    );
    const res = await createShipment(ctx.token, ctx.workspace.id, ctx.order.id);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('CARRIER_ERROR');
    expect(res.body.error.message).toBe('Bosta: City Not Found for key [redacted]');
    expect(res.body.error.details).toEqual({ carrierErrorCode: 3001, httpStatus: 400 });
  });

  it('treats "bosta" as a manual carrier name when the store has not connected Bosta', async () => {
    // The shipment form's carrier field is free text: stores that never
    // connected Bosta and type "bosta" keep getting a manual shipment.
    const setup = await setupWorkspaceWithProduct();
    const order = await placeOrder(setup.auth.accessToken, setup.workspace.id, setup.variant.id);
    const res = await createShipment(setup.auth.accessToken, setup.workspace.id, order.id, {
      carrierCode: 'bosta',
      waybillNumber: 'TYPED-123',
    });
    expect(res.status).toBe(201);
    expect(res.body.shipment).toMatchObject({ carrierCode: 'bosta', waybillNumber: 'TYPED-123', carrierResponse: null });
    expect(fake.calls).toHaveLength(0);

    // Such a row is never treated as carrier-booked.
    const sync = await request(app)
      .post(`/api/v1/workspaces/${setup.workspace.id}/orders/${order.id}/shipments/${res.body.shipment.id}/sync`)
      .set(bearer(setup.auth.accessToken));
    expect(sync.status).toBe(409);
    expect(sync.body.error.code).toBe('SHIPMENT_NOT_CARRIER_MANAGED');
    const model = await waybillService.computeWaybillModel(setup.workspace.id, order.id);
    expect(model.trackingValue).toBe(res.body.shipment.trackingCode);
  });

  it('answers 409 CARRIER_NOT_CONNECTED when syncing after the carrier was disconnected', async () => {
    const ctx = await bookedShipment();
    await request(app).delete(`/api/v1/workspaces/${ctx.workspace.id}/carriers/bosta`).set(bearer(ctx.token));
    const res = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}/shipments/${ctx.shipment.id}/sync`)
      .set(bearer(ctx.token));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CARRIER_NOT_CONNECTED');
  });
});

describe('Bosta status updates', () => {
  it('a webhook fetches the status from Bosta and moves the order along the pipeline', async () => {
    const ctx = await bookedShipment();
    const trackingNumber = ctx.shipment.waybillNumber;

    setBostaState(trackingNumber, 21);
    const res = await postWebhook(ctx.webhookToken, { _id: `DLV-${trackingNumber}`, trackingNumber: Number(trackingNumber), state: 21, type: 'SEND' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(callsTo('GET', `/deliveries/business/${trackingNumber}`)).toHaveLength(1);

    let order = (await getOrder(ctx.token, ctx.workspace.id, ctx.order.id)).body.order;
    expect(order.shipments[0].status).toBe('picked_up');
    expect(order.shipments[0].shippedAt).not.toBeNull();
    expect(order.fulfillmentState).toBe('partially_fulfilled');
    expect(order.stage).toBe('shipped');

    setBostaState(trackingNumber, 41);
    await postWebhook(ctx.webhookToken, { trackingNumber, state: 41, type: 'SEND' });
    order = (await getOrder(ctx.token, ctx.workspace.id, ctx.order.id)).body.order;
    expect(order.stage).toBe('out_for_delivery');

    setBostaState(trackingNumber, 45);
    await postWebhook(ctx.webhookToken, { trackingNumber, state: 45, type: 'SEND' });
    order = (await getOrder(ctx.token, ctx.workspace.id, ctx.order.id)).body.order;
    expect(order.shipments[0].status).toBe('delivered');
    expect(order.shipments[0].deliveredAt).not.toBeNull();
    expect(order.fulfillmentState).toBe('fulfilled');
    expect(order.stage).toBe('delivered');

    const pipeline = await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/orders/pipeline`).set(bearer(ctx.token));
    expect(pipeline.body.stages.delivered).toBe(1);

    const audits = await db.AuditLog.findAll({ where: { entityId: ctx.shipment.id, action: 'shipment.update' } });
    expect(audits).toHaveLength(3);
    for (const audit of audits) {
      expect(audit.actorUserId).toBeNull();
      expect(audit.metadata).toMatchObject({ source: 'carrier', trigger: 'webhook', carrierCode: 'bosta' });
    }
  });

  it('ignores a forged status in the payload: what Bosta reports wins', async () => {
    const ctx = await bookedShipment();
    const trackingNumber = ctx.shipment.waybillNumber;
    setBostaState(trackingNumber, 24);

    await postWebhook(ctx.webhookToken, { trackingNumber, state: 45, type: 'SEND', isConfirmedDelivery: true });
    const shipment = await db.Shipment.findByPk(ctx.shipment.id);
    expect(shipment.status).toBe('in_transit');
    expect(shipment.deliveredAt).toBeNull();
  });

  it('the same status twice writes one audit row', async () => {
    const ctx = await bookedShipment();
    const trackingNumber = ctx.shipment.waybillNumber;
    setBostaState(trackingNumber, 30);
    await postWebhook(ctx.webhookToken, { trackingNumber, state: 30 });
    await postWebhook(ctx.webhookToken, { trackingNumber, state: 30 });
    // Another Bosta state that is still 'in_transit' for us: no audit either.
    setBostaState(trackingNumber, 24);
    await postWebhook(ctx.webhookToken, { trackingNumber, state: 24 });

    expect(await db.AuditLog.count({ where: { entityId: ctx.shipment.id, action: 'shipment.update' } })).toBe(1);
    const shipment = await db.Shipment.findByPk(ctx.shipment.id);
    expect(shipment.status).toBe('in_transit');
    expect(shipment.carrierResponse.lastCarrierStatus).toMatchObject({ code: 24, value: 'Received at warehouse' });
  });

  it('never moves a delivered shipment backwards, but accepts returned after delivered', async () => {
    const ctx = await bookedShipment();
    const trackingNumber = ctx.shipment.waybillNumber;
    setBostaState(trackingNumber, 45);
    await postWebhook(ctx.webhookToken, { trackingNumber });

    setBostaState(trackingNumber, 30);
    await postWebhook(ctx.webhookToken, { trackingNumber });
    expect((await db.Shipment.findByPk(ctx.shipment.id)).status).toBe('delivered');

    setBostaState(trackingNumber, 46, 'RTO');
    await postWebhook(ctx.webhookToken, { trackingNumber });
    expect((await db.Shipment.findByPk(ctx.shipment.id)).status).toBe('returned');
    expect((await db.Order.findByPk(ctx.order.id)).fulfillmentState).toBe('returned');
  });

  it('keeps the status on a state Bosta documents for other order types', async () => {
    const ctx = await bookedShipment();
    setBostaState(ctx.shipment.waybillNumber, 25); // Fulfilled — fulfillment orders only
    await postWebhook(ctx.webhookToken, { trackingNumber: ctx.shipment.waybillNumber });
    expect((await db.Shipment.findByPk(ctx.shipment.id)).status).toBe('created');
    expect(await db.AuditLog.count({ where: { entityId: ctx.shipment.id, action: 'shipment.update' } })).toBe(0);
  });

  it('404s an unknown token or carrier, and acknowledges an unknown shipment', async () => {
    const ctx = await bookedShipment();
    const unknown = await postWebhook(crypto.randomBytes(32).toString('base64url'), { trackingNumber: ctx.shipment.waybillNumber });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');

    expect((await postWebhook('short', { trackingNumber: '1' })).status).toBe(404);
    expect((await postWebhook(ctx.webhookToken, { trackingNumber: '1' }, 'aramex')).status).toBe(404);

    const stranger = await postWebhook(ctx.webhookToken, { trackingNumber: '99999999' });
    expect(stranger.status).toBe(200);
    expect(callsTo('GET', '/deliveries/business/99999999')).toHaveLength(0);

    const empty = await postWebhook(ctx.webhookToken, { hello: 'world' });
    expect(empty.status).toBe(200);
  });

  it('POST .../sync pulls the status now', async () => {
    const ctx = await bookedShipment();
    setBostaState(ctx.shipment.waybillNumber, 47);
    const res = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}/shipments/${ctx.shipment.id}/sync`)
      .set(bearer(ctx.token));

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.shipment.status).toBe('failed');
    expect(res.body.carrierStatus).toEqual({ code: 47, value: 'Exception', type: { code: 10, value: 'Send' } });
    expect(JSON.stringify(res.body)).not.toContain('NotBeStored');
    expect(JSON.stringify(res.body)).not.toContain('01099999999');
    const order = (await getOrder(ctx.token, ctx.workspace.id, ctx.order.id)).body.order;
    expect(order.stage).toBe('delivery_failed');

    const again = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}/shipments/${ctx.shipment.id}/sync`)
      .set(bearer(ctx.token));
    expect(again.body.changed).toBe(false);
  });

  it('sync refuses a manual shipment', async () => {
    const ctx = await readyToBook();
    const manual = await createShipment(ctx.token, ctx.workspace.id, ctx.order.id, { carrierCode: 'manual' });
    const res = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}/shipments/${manual.body.shipment.id}/sync`)
      .set(bearer(ctx.token));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SHIPMENT_NOT_CARRIER_MANAGED');
  });

  it('proxies Bosta\'s label PDF', async () => {
    const ctx = await bookedShipment();
    const res = await request(app)
      .get(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}/shipments/${ctx.shipment.id}/label`)
      .set(bearer(ctx.token))
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(Buffer.compare(res.body, PDF_BYTES)).toBe(0);
    expect(callsTo('POST', '/deliveries/mass-awb')[0].body).toEqual({
      trackingNumbers: ctx.shipment.waybillNumber,
      requestedAwbType: 'A4',
      lang: 'ar',
    });
  });
});

describe('a failed Bosta shipment is not final', () => {
  const shipmentStatus = async (id) => (await db.Shipment.findByPk(id)).status;
  const updateAudits = (id) => db.AuditLog.count({ where: { entityId: id, action: 'shipment.update' } });

  it('47 Exception, then a re-attempt (41 SEND): failed -> out_for_delivery', async () => {
    const ctx = await bookedShipment();
    const tn = ctx.shipment.waybillNumber;
    setBostaState(tn, 47);
    await postWebhook(ctx.webhookToken, { trackingNumber: tn });
    expect(await shipmentStatus(ctx.shipment.id)).toBe('failed');
    // The same status again writes no audit row.
    await postWebhook(ctx.webhookToken, { trackingNumber: tn });
    expect(await updateAudits(ctx.shipment.id)).toBe(1);

    setBostaState(tn, 41, 'SEND');
    await postWebhook(ctx.webhookToken, { trackingNumber: tn });
    expect(await shipmentStatus(ctx.shipment.id)).toBe('out_for_delivery');
    expect(await updateAudits(ctx.shipment.id)).toBe(2);
  });

  it('41 on the return leg, then 46 Returned to business: failed -> returned', async () => {
    const ctx = await bookedShipment();
    const tn = ctx.shipment.waybillNumber;
    setBostaState(tn, 41, 'RTO');
    await postWebhook(ctx.webhookToken, { trackingNumber: tn });
    expect(await shipmentStatus(ctx.shipment.id)).toBe('failed');

    setBostaState(tn, 46, 'RTO');
    await postWebhook(ctx.webhookToken, { trackingNumber: tn });
    expect(await shipmentStatus(ctx.shipment.id)).toBe('returned');
    expect((await db.Order.findByPk(ctx.order.id)).fulfillmentState).toBe('returned');
  });

  it('an exception, then delivered on the re-attempt: failed -> delivered', async () => {
    const ctx = await bookedShipment();
    const tn = ctx.shipment.waybillNumber;
    setBostaState(tn, 47);
    await postWebhook(ctx.webhookToken, { trackingNumber: tn });
    expect(await shipmentStatus(ctx.shipment.id)).toBe('failed');

    setBostaState(tn, 45);
    await postWebhook(ctx.webhookToken, { trackingNumber: tn });
    const shipment = await db.Shipment.findByPk(ctx.shipment.id);
    expect(shipment.status).toBe('delivered');
    expect(shipment.deliveredAt).not.toBeNull();
    expect((await db.Order.findByPk(ctx.order.id)).fulfillmentState).toBe('fulfilled');
  });

  it('the merchant can PATCH failed -> cancelled while Bosta is connected, then book a new Bosta shipment', async () => {
    const ctx = await bookedShipment();
    const tn = ctx.shipment.waybillNumber;
    setBostaState(tn, 49); // Canceled -> failed
    await postWebhook(ctx.webhookToken, { trackingNumber: tn });
    expect(await shipmentStatus(ctx.shipment.id)).toBe('failed');

    // While failed, a second booking is refused.
    const blocked = await createShipment(ctx.token, ctx.workspace.id, ctx.order.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('SHIPMENT_ALREADY_EXISTS');

    const patched = await request(app)
      .patch(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}/shipments/${ctx.shipment.id}`)
      .set(bearer(ctx.token))
      .send({ status: 'cancelled' });
    expect(patched.status).toBe(200);
    expect(await shipmentStatus(ctx.shipment.id)).toBe('cancelled');
    // A manual PATCH never calls Bosta.
    expect(callsTo('DELETE', `/deliveries/business/${tn}/terminate`)).toHaveLength(0);

    const rebooked = await createShipment(ctx.token, ctx.workspace.id, ctx.order.id);
    expect(rebooked.status).toBe(201);
    expect(rebooked.body.shipment.waybillNumber).not.toBe(tn);
    expect(callsTo('POST', '/deliveries')).toHaveLength(2);

    // A late webhook for the old parcel can't revive the cancelled row.
    setBostaState(tn, 45);
    await postWebhook(ctx.webhookToken, { trackingNumber: tn });
    expect(await shipmentStatus(ctx.shipment.id)).toBe('cancelled');
  });
});

describe('carrier HTTP timeouts', () => {
  it('a create gets 15s, every other Bosta call the 10s default', async () => {
    const ctx = await bookedShipment();
    await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}/shipments/${ctx.shipment.id}/sync`)
      .set(bearer(ctx.token));

    const timeoutFor = (method, path) =>
      httpSpy.mock.calls.find(([opts]) => opts.method === method && new URL(opts.url).pathname.endsWith(path))[0].timeoutMs;
    expect(timeoutFor('POST', '/deliveries')).toBe(15000);
    expect(timeoutFor('GET', `/deliveries/business/${ctx.shipment.waybillNumber}`)).toBeUndefined();
    expect(carrierHttp.DEFAULT_TIMEOUT_MS).toBe(10000);
  });

  it('carrierHttp aborts a hung request and rejects with CarrierUnreachableError', async () => {
    httpSpy.mockRestore();
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      (url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        })
    );
    try {
      await expect(carrierHttp.request({ url: 'https://example.test/x', timeoutMs: 20 })).rejects.toMatchObject({
        name: 'CarrierUnreachableError',
        message: 'timed out',
      });
      expect(fetchSpy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('a create that times out: 502, nothing recorded, no cancel attempt, and the order can be booked again', async () => {
    const ctx = await readyToBook();
    httpSpy.mockImplementation(async (opts) => {
      if (opts.method === 'POST' && new URL(opts.url).pathname.endsWith('/deliveries')) {
        throw new carrierHttp.CarrierUnreachableError('timed out');
      }
      return fakeBosta(opts);
    });

    const res = await createShipment(ctx.token, ctx.workspace.id, ctx.order.id);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('CARRIER_ERROR');
    expect(res.body.error.message).toMatch(/may still have been created.*Bosta dashboard/);
    expect(await db.Shipment.count({ where: { orderId: ctx.order.id } })).toBe(0);
    expect(fake.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);

    // The row lock was released with the rolled-back transaction.
    httpSpy.mockImplementation(fakeBosta);
    const retry = await createShipment(ctx.token, ctx.workspace.id, ctx.order.id);
    expect(retry.status).toBe(201);
  });
});

describe('the cities list is loaded before the order is locked', () => {
  const isCitiesFetch = (opts) => new URL(opts.url).pathname.endsWith('/cities/getAllDistricts');

  it('a slow cities fetch on a cold cache never holds the order row lock', async () => {
    const ctx = await readyToBook();
    accounts.clearCitiesCache();

    let entered;
    const inFetch = new Promise((resolve) => (entered = resolve));
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    httpSpy.mockImplementation(async (opts) => {
      if (isCitiesFetch(opts)) {
        entered();
        await gate;
      }
      return fakeBosta(opts);
    });

    // .then() fires the request now (supertest is lazy until awaited).
    const booking = createShipment(ctx.token, ctx.workspace.id, ctx.order.id).then((r) => r);
    await inFetch;

    // While the fetch hangs, another transaction can take the same row lock.
    const locked = await db.sequelize.transaction(async (transaction) => {
      await db.sequelize.query("SET LOCAL lock_timeout = '2s'", { transaction });
      return db.Order.findOne({ where: { id: ctx.order.id }, transaction, lock: transaction.LOCK.UPDATE });
    });
    expect(locked.id).toBe(ctx.order.id);

    release();
    const res = await booking;
    expect(res.status).toBe(201);
  });

  it('a failing cities fetch fails the booking before any lock or create', async () => {
    const ctx = await readyToBook();
    accounts.clearCitiesCache();
    httpSpy.mockImplementation(async (opts) =>
      isCitiesFetch(opts) ? reply(500, { success: false, message: 'Internal Server Error', errorCode: 1000, data: null }) : fakeBosta(opts)
    );

    const res = await createShipment(ctx.token, ctx.workspace.id, ctx.order.id);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('CARRIER_ERROR');
    expect(callsTo('POST', '/deliveries')).toHaveLength(0);
    expect(await db.Shipment.count({ where: { orderId: ctx.order.id } })).toBe(0);
  });
});

describe('COD booking', () => {
  it('a COD order that is not paid is booked (no ORDER_NOT_PAID), and 12345 piastres goes out as cod 123.45', async () => {
    const ctx = await readyToBook(); // price 12345, quantity 1, COD, confirmed
    const order = await db.Order.findByPk(ctx.order.id);
    expect(Number(order.totalAmount)).toBe(12345);
    expect(order.financialState).not.toBe('paid');

    const res = await createShipment(ctx.token, ctx.workspace.id, ctx.order.id);
    expect(res.status).toBe(201);
    const sent = callsTo('POST', '/deliveries')[0].body;
    expect(sent.cod).toBe(123.45);
    expect(JSON.stringify(sent)).toContain('"cod":123.45');
  });
});

describe('cancelling an order with a Bosta shipment', () => {
  it('cancels the shipment at Bosta first', async () => {
    const ctx = await bookedShipment();
    const res = await cancelOrder(ctx.token, ctx.workspace.id, ctx.order.id);

    expect(res.status).toBe(200);
    expect(callsTo('DELETE', `/deliveries/business/${ctx.shipment.waybillNumber}/terminate`)).toHaveLength(1);
    expect((await db.Shipment.findByPk(ctx.shipment.id)).status).toBe('cancelled');
    expect((await db.Order.findByPk(ctx.order.id)).cancelledAt).not.toBeNull();

    // Bosta then reports Terminated: already final, nothing to do.
    await postWebhook(ctx.webhookToken, { trackingNumber: ctx.shipment.waybillNumber, state: 48 });
    expect((await db.Shipment.findByPk(ctx.shipment.id)).status).toBe('cancelled');
  });

  it('changes nothing when Bosta refuses', async () => {
    const ctx = await bookedShipment();
    const before = await db.Order.findByPk(ctx.order.id);
    const reservedBefore = await db.ProductVariant.findByPk(ctx.variant.id);
    fake.refuseTerminate = true;

    const res = await cancelOrder(ctx.token, ctx.workspace.id, ctx.order.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CARRIER_CANCEL_FAILED');
    expect(res.body.error.message).toContain('Delivery can not be terminated in its current state');

    const after = await db.Order.findByPk(ctx.order.id);
    expect(after.cancelledAt).toBeNull();
    expect(after.confirmationState).toBe(before.confirmationState);
    expect((await db.Shipment.findByPk(ctx.shipment.id)).status).toBe('created');
    expect((await db.ProductVariant.findByPk(ctx.variant.id)).toJSON()).toEqual(reservedBefore.toJSON());
    expect(await db.AuditLog.count({ where: { entityId: ctx.order.id, action: 'order.cancel' } })).toBe(0);
  });

  it('explains a missing Full Access scope', async () => {
    const ctx = await bookedShipment();
    httpSpy.mockImplementation(async (opts) =>
      opts.method === 'DELETE'
        ? reply(403, { success: false, message: 'Access to the requested resource is forbidden', errorCode: 1008, data: null })
        : fakeBosta(opts)
    );
    const res = await cancelOrder(ctx.token, ctx.workspace.id, ctx.order.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CARRIER_CANCEL_FAILED');
    expect(res.body.error.message).toContain('Full Access');
  });
});

describe('manual shipments are unchanged', () => {
  it('books without confirmation, needs no carrier and cancels without calling one', async () => {
    const setup = await setupWorkspaceWithProduct();
    const token = setup.auth.accessToken;
    const order = await placeOrder(token, setup.workspace.id, setup.variant.id);

    const first = await createShipment(token, setup.workspace.id, order.id, { carrierCode: 'manual', waybillNumber: 'WB-1' });
    const second = await createShipment(token, setup.workspace.id, order.id, { carrierCode: 'aramex-manual', waybillNumber: 'WB-2' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const patched = await request(app)
      .patch(`/api/v1/workspaces/${setup.workspace.id}/orders/${order.id}/shipments/${first.body.shipment.id}`)
      .set(bearer(token))
      .send({ status: 'created' });
    expect(patched.status).toBe(200);
    const audits = await db.AuditLog.findAll({ where: { entityId: first.body.shipment.id, action: 'shipment.update' } });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorUserId).toBe(setup.auth.userId);
    expect(audits[0].metadata).toBeNull();

    const model = await waybillService.computeWaybillModel(setup.workspace.id, order.id);
    expect(model.trackingValue).toMatch(/^zg\d{9}$/);

    const cancelled = await cancelOrder(token, setup.workspace.id, order.id);
    expect(cancelled.status).toBe(200);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('workspace isolation', () => {
  it('keeps connections, shipments and webhooks inside their workspace', async () => {
    const a = await bookedShipment();
    const b = await setupWorkspaceWithProduct();
    const tokenB = b.auth.accessToken;

    // B sees no connection of its own.
    const listB = await request(app).get(`/api/v1/workspaces/${b.workspace.id}/carriers`).set(bearer(tokenB));
    expect(listB.body.carriers[0].connection).toBeNull();
    const citiesB = await request(app).get(`/api/v1/workspaces/${b.workspace.id}/carriers/bosta/cities`).set(bearer(tokenB));
    expect(citiesB.status).toBe(409);
    expect(citiesB.body.error.code).toBe('CARRIER_NOT_CONNECTED');

    // B cannot reach A's shipment or A's carrier settings.
    const sync = await request(app)
      .post(`/api/v1/workspaces/${b.workspace.id}/orders/${a.order.id}/shipments/${a.shipment.id}/sync`)
      .set(bearer(tokenB));
    expect(sync.status).toBe(404);
    const label = await request(app)
      .get(`/api/v1/workspaces/${b.workspace.id}/orders/${a.order.id}/shipments/${a.shipment.id}/label`)
      .set(bearer(tokenB));
    expect(label.status).toBe(404);
    const crossWorkspace = await request(app).get(`/api/v1/workspaces/${a.workspace.id}/carriers`).set(bearer(tokenB));
    // resolveTenant answers 404 for a workspace the caller is not a member of.
    expect(crossWorkspace.status).toBe(404);
    const disconnectA = await request(app).delete(`/api/v1/workspaces/${b.workspace.id}/carriers/bosta`).set(bearer(tokenB));
    expect(disconnectA.status).toBe(404);
    expect(await db.CarrierAccount.count({ where: { workspaceId: a.workspace.id } })).toBe(1);

    // B connects its own Bosta account: a different webhook token.
    const connectedB = await connectBosta(tokenB, b.workspace.id, { credentials: { apiKey: OTHER_VALID_KEY } });
    const webhookTokenB = connectedB.body.webhook.url.split('/').pop();
    expect(webhookTokenB).not.toBe(a.webhookToken);

    // A row in B that happens to carry the same tracking number is never
    // touched by A's webhook, and B's token never reaches A's shipment.
    const orderB = await placeOrder(tokenB, b.workspace.id, b.variant.id);
    const rowB = await db.Shipment.create({
      workspaceId: b.workspace.id,
      orderId: orderB.id,
      trackingCode: 'zg000000001',
      carrierCode: 'bosta',
      waybillNumber: a.shipment.waybillNumber,
      status: 'created',
      carrierResponse: { carrierShipmentId: null },
    });

    setBostaState(a.shipment.waybillNumber, 21);
    await postWebhook(a.webhookToken, { trackingNumber: a.shipment.waybillNumber });
    expect((await db.Shipment.findByPk(a.shipment.id)).status).toBe('picked_up');
    expect((await db.Shipment.findByPk(rowB.id)).status).toBe('created');

    setBostaState(a.shipment.waybillNumber, 45);
    await postWebhook(webhookTokenB, { trackingNumber: a.shipment.waybillNumber });
    // B's lookup is made with B's key, which Bosta says doesn't own it.
    expect((await db.Shipment.findByPk(a.shipment.id)).status).toBe('picked_up');
    expect((await db.Shipment.findByPk(rowB.id)).status).toBe('created');
  });
});

describe('Bosta state mapping', () => {
  it('maps every state Bosta documents for Deliver orders, and 41 by leg', () => {
    expect(bosta.mapState(10, 'SEND').status).toBe('created');
    expect(bosta.mapState(21, 'SEND').status).toBe('picked_up');
    expect(bosta.mapState(41, 'SEND').status).toBe('out_for_delivery');
    expect(bosta.mapState(41, { code: 10, value: 'Send' }).status).toBe('out_for_delivery');
    expect(bosta.mapState(41, 'RTO').status).toBe('failed');
    expect(bosta.mapState(41, 'EXCHANGE').status).toBeUndefined();
    expect(bosta.mapState(45).status).toBe('delivered');
    expect(bosta.mapState(46).status).toBe('returned');
    expect(bosta.mapState(48).status).toBe('cancelled');
    expect(bosta.mapState(105).status).toBeNull();
    expect(bosta.mapState(11).status).toBeUndefined();
    expect(bosta.mapState(999).status).toBeUndefined();
  });

  it('converts piastres to EGP', () => {
    expect(bosta.toEgp(12345)).toBe(123.45);
    expect(bosta.toEgp('500000')).toBe(5000);
    expect(bosta.toEgp(0)).toBe(0);
  });
});
