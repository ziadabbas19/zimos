'use strict';

// The Mylerz adapter end to end through the real endpoints, against a fake
// Mylerz behind carrierHttp.request (tests/helpers/fakeMylerz.js). Mylerz is
// a beta carrier: it is switched on for this file only.

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct, confirmCodOrder } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const carrierHttp = require('../../src/modules/shipping/carriers/carrierHttp');
const accounts = require('../../src/modules/shipping/carrierAccountService');
const sync = require('../../src/modules/shipping/carrierSyncService');
const mylerz = require('../../src/modules/shipping/carriers/mylerz');
const logger = require('../../src/core/utils/logger');
const fake = require('../helpers/fakeMylerz');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const HOUR = 60 * 60 * 1000;
const CREDS = { username: fake.USERNAME, password: fake.PASSWORD };
const ADDRESS = { country: 'EG', province: 'القاهره', city: 'مدينه نصر', addressLine: '12 Abbas El Akkad Street' };

let seq = 0;
const nextKey = () => `mylerz-${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2)}`;

const originalKey = env.carriers.credentialsKey;
const originalBeta = env.carriers.beta;
const originalBetaWorkspaces = env.carriers.betaWorkspaces;
let httpSpy;

beforeAll(() => {
  env.carriers.credentialsKey = crypto.randomBytes(32).toString('base64');
  env.carriers.beta = [...originalBeta, 'mylerz'];
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
  mylerz.clearTokens();
  accounts.clearCitiesCache();
  httpSpy = jest.spyOn(carrierHttp, 'request').mockImplementation(fake.handle);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// --- helpers -----------------------------------------------------------------------

/** A store in the Mylerz beta. */
async function store() {
  const setup = await setupWorkspaceWithProduct({ price: 12345, stock: 50 });
  env.carriers.betaWorkspaces = [...env.carriers.betaWorkspaces, String(setup.workspace.slug).toLowerCase()];
  const token = setup.auth.accessToken;
  const ws = setup.workspace.id;
  return { ...setup, token, ws, api: (method, path) => request(app)[method](`/api/v1/workspaces/${ws}${path}`).set(bearer(token)) };
}

const connect = (ctx, body = { credentials: CREDS }) => ctx.api('put', '/carriers/mylerz').send(body);

async function connected(settings) {
  const ctx = await store();
  const res = await connect(ctx, { credentials: CREDS, ...(settings ? { settings } : {}) });
  if (res.status !== 200) throw new Error(`connect failed: ${res.status} ${JSON.stringify(res.body)}`);
  return ctx;
}

async function placeOrder(ctx, { address = ADDRESS, paymentMethod = 'cod', contact } = {}) {
  const res = await ctx
    .api('post', '/orders')
    .set('Idempotency-Key', nextKey())
    .send({
      items: [{ variantId: ctx.variant.id, quantity: 1 }],
      contact: contact || { fullName: 'Mona Adel Hassan', phone: '+201012345678', email: 'mona@example.com' },
      shippingAddress: address,
      paymentMethod,
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

async function confirmedOrder(ctx, opts) {
  const order = await placeOrder(ctx, opts);
  await confirmCodOrder(ctx.token, ctx.ws, order.id);
  return order;
}

const ship = (ctx, orderId, body = { carrierCode: 'mylerz' }) => ctx.api('post', `/orders/${orderId}/shipments`).send(body);

async function booked(opts) {
  const ctx = await connected();
  const order = await confirmedOrder(ctx, opts);
  const res = await ship(ctx, order.id);
  if (res.status !== 201) throw new Error(`booking failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...ctx, order, shipment: res.body.shipment };
}

const addOrdersBodies = () => fake.callsTo('POST', '/api/Orders/AddOrders').map((c) => c.body[0]);

// --- connecting -----------------------------------------------------------------

describe('connecting a Mylerz account', () => {
  it('logs in with the username and password, reads the warehouses, and stores the credentials encrypted', async () => {
    const ctx = await store();
    const res = await connect(ctx, { credentials: CREDS, settings: { warehouseName: 'Main Warehouse', serviceType: 'DTD' } });

    expect(res.status).toBe(200);
    const [login] = fake.callsTo('POST', '/token');
    expect(login.form).toEqual({ grant_type: 'password', username: fake.USERNAME, password: fake.PASSWORD });
    expect(fake.callsTo('GET', '/api/Orders/GetWarehouses')[0].headers.Authorization).toMatch(/^bearer mylerz-token-\d+$/);
    expect(res.body.verification.pickupLocations).toEqual([
      { id: 'Main Warehouse', name: 'Main Warehouse' },
      { id: 'Nasr City Store', name: 'Nasr City Store' },
    ]);
    expect(res.body.carrier.connection).toMatchObject({ status: 'active', settings: { warehouseName: 'Main Warehouse' } });
    expect(res.body.webhook.setup).toBe('none');

    const row = await db.CarrierAccount.scope('withCredentials').findOne({ where: { workspaceId: ctx.ws } });
    expect(row.credentialsEncrypted).not.toContain(fake.PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain(fake.PASSWORD);
  });

  it('rejects a wrong password with 422 CARRIER_AUTH_FAILED naming the username/password, and stores nothing', async () => {
    const ctx = await store();
    const res = await connect(ctx, { credentials: { username: fake.USERNAME, password: 'wrong-password' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CARRIER_AUTH_FAILED');
    expect(res.body.error.message).toBe(
      "Mylerz rejected the username or password. Check it in Mylerz's dashboard and connect the account again."
    );
    expect(fake.callsTo('GET', '/api/Orders/GetWarehouses')).toHaveLength(0);
    expect(await db.CarrierAccount.count({ where: { workspaceId: ctx.ws } })).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain('wrong-password');
  });

  it('validates the credential fields and refuses a warehouse the account does not have', async () => {
    const ctx = await store();
    const missing = await connect(ctx, { credentials: { username: fake.USERNAME } });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details[0].field).toBe('credentials.password');

    const badWarehouse = await connect(ctx, { credentials: CREDS, settings: { warehouseName: 'Somewhere else' } });
    expect(badWarehouse.status).toBe(422);
    expect(badWarehouse.body.error.details[0].field).toBe('settings.warehouseName');

    const badService = await connect(ctx, { credentials: CREDS, settings: { serviceType: 'XYZ' } });
    expect(badService.status).toBe(422);
    expect(await db.CarrierAccount.count({ where: { workspaceId: ctx.ws } })).toBe(0);
  });
});

// --- address tree ---------------------------------------------------------------------

describe('the Mylerz address tree', () => {
  it('serves cities with their zones as city > neighborhood', async () => {
    const ctx = await connected();
    const res = await ctx.api('get', '/carriers/mylerz/cities');
    expect(res.status).toBe(200);
    expect(res.body.levels).toEqual(['city', 'neighborhood']);
    expect(res.body.cities.map((c) => c.id)).toEqual(['CAI', 'GIZ']);
    expect(res.body.cities[0]).toMatchObject({ name: 'Cairo', nameAr: 'القاهرة' });
    expect(res.body.cities[0].children.map((z) => z.id)).toEqual(['NASR', 'MAADI', 'HELIO']);
  });

  it('matches the order\'s governorate and area to a zone, and sends the zone code as Neighborhood', async () => {
    const { shipment } = await booked();
    const [sent] = addOrdersBodies();
    expect(sent).toMatchObject({ Country: 'Egypt', Neighborhood: 'NASR', Street: '12 Abbas El Akkad Street' });
    expect(sent.City).toBeUndefined();
    expect(shipment.carrierResponse.address).toEqual({ path: ['CAI', 'NASR'] });
  });

  it('asks for the neighborhood when the area does not match, then books with an explicit path', async () => {
    const ctx = await connected();
    const order = await confirmedOrder(ctx, { address: { ...ADDRESS, city: 'Somewhere Unknown' } });
    const res = await ship(ctx, order.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CARRIER_ADDRESS_UNMATCHED');
    expect(res.body.error.details).toMatchObject({ carrierCode: 'mylerz', level: 'neighborhood', levels: ['city', 'neighborhood'] });
    expect(res.body.error.details.matchedPath).toEqual([{ id: 'CAI', name: 'Cairo', nameAr: 'القاهرة' }]);
    expect(addOrdersBodies()).toHaveLength(0);

    const retry = await ship(ctx, order.id, { carrierCode: 'mylerz', carrierAddress: { path: ['CAI', 'MAADI'] } });
    expect(retry.status).toBe(201);
    expect(addOrdersBodies()[0].Neighborhood).toBe('MAADI');
  });
});

// --- booking ----------------------------------------------------------------------------

describe('booking a Mylerz shipment', () => {
  it('maps the order onto an OrderDTO: COD in EGP, local phone, reference, service defaults', async () => {
    const { shipment, order } = await booked();
    const [sent] = addOrdersBodies();
    expect(sent).toMatchObject({
      Package_Serial: 1,
      Reference: order.orderNumber,
      Service_Type: 'DTD',
      Service: 'ND',
      Service_Category: 'DELIVERY',
      Payment_Type: 'COD',
      COD_Value: String((Number(order.totalAmount) / 100).toFixed(2)),
      Currency: 'EGP',
      Customer_Name: 'Mona Adel Hassan',
      Mobile_No: '01012345678',
      Customer_Email: 'mona@example.com',
      Address_Category: 'H',
      Pieces: [{ PieceNo: 1 }],
    });
    expect(sent.Description).toMatch(/^1x /);
    expect(shipment).toMatchObject({ carrierCode: 'mylerz', status: 'created', waybillNumber: expect.stringMatching(mylerz.BARCODE) });
  });

  it('keeps no phone numbers or credentials on the shipment', async () => {
    const { shipment } = await booked();
    const stored = JSON.stringify(shipment.carrierResponse);
    expect(shipment.carrierResponse).toMatchObject({ barcode: shipment.waybillNumber, carrierShipmentId: expect.stringMatching(/^PU-/) });
    for (const secret of ['01012345678', '201012345678', fake.PASSWORD, fake.USERNAME, 'mylerz-token']) {
      expect(stored).not.toContain(secret);
    }
  });

  it('sends a prepaid, paid order as PP with nothing to collect', async () => {
    const ctx = await connected();
    const order = await placeOrder(ctx, { paymentMethod: 'card' });
    const init = await ctx.api('post', `/orders/${order.id}/payments`).send({});
    const captured = await ctx.api('post', `/payments/${init.body.payment.id}/capture`).send({});
    expect(captured.status).toBe(200);
    const res = await ship(ctx, order.id);
    expect(res.status).toBe(201);
    expect(addOrdersBodies()[0]).toMatchObject({ Payment_Type: 'PP', COD_Value: '0' });
  });

  it('declares the weight tier\'s upper bound in kilograms, and passes the warehouse and service settings', async () => {
    const ctx = await connected();
    await connect(ctx, { settings: { warehouseName: 'Nasr City Store', serviceType: 'DTC', service: 'SD' } });
    const tiers = await ctx.api('put', '/shipping/weight-tiers').send({ tiers: [{ upToGrams: 1000 }, { upToGrams: 3000 }] });
    expect(tiers.status).toBe(200);
    const order = await confirmedOrder(ctx);
    const res = await ship(ctx, order.id, { carrierCode: 'mylerz', tierId: tiers.body.tiers[1].id });
    expect(res.status).toBe(201);
    expect(addOrdersBodies()[0]).toMatchObject({ Total_Weight: 3, WarehouseName: 'Nasr City Store', Service_Type: 'DTC', Service: 'SD' });
    expect(res.body.shipment.carrierResponse.package).toMatchObject({ weightGrams: 3000, tierId: tiers.body.tiers[1].id, source: 'tier' });
  });

  it('refuses a non-EGP order, a goods value over 999999 EGP and an unreadable phone before calling Mylerz', async () => {
    const input = (over = {}) => ({
      order: { currency: 'EGP', orderNumber: 'ORD-1', contactSnapshot: { fullName: 'A B', phone: '01012345678' }, ...over.order },
      address: { path: [{ id: 'CAI' }, { id: 'NASR' }], firstLine: '12 Street' },
      cod: 10000,
      goodsValue: 10000,
      description: '1x Thing',
      carrierSettings: {},
      ...over.top,
    });
    await expect(mylerz.createShipment(CREDS, input({ order: { currency: 'USD' } }))).rejects.toMatchObject({
      code: 'CARRIER_CURRENCY_UNSUPPORTED',
      statusCode: 422,
    });
    await expect(mylerz.createShipment(CREDS, input({ top: { goodsValue: 100000000 } }))).rejects.toMatchObject({
      code: 'CARRIER_GOODS_VALUE_LIMIT',
      statusCode: 422,
    });
    await expect(
      mylerz.createShipment(CREDS, input({ order: { contactSnapshot: { fullName: 'A', phone: '12' } } }))
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 422 });
    expect(fake.state().calls).toHaveLength(0);
  });

  it('turns a package-level refusal into 502 CARRIER_ERROR with Mylerz\'s message, recording nothing', async () => {
    const ctx = await connected();
    const order = await confirmedOrder(ctx);
    fake.state().refuseCreate = 'Neighborhood is not covered';
    const res = await ship(ctx, order.id);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({ code: 'CARRIER_ERROR', message: 'Mylerz: Neighborhood is not covered' });
    expect(await db.Shipment.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('reuses one token across calls and logs in again once when Mylerz stops accepting it', async () => {
    const ctx = await connected();
    const order = await confirmedOrder(ctx);
    const loginsBefore = fake.callsTo('POST', '/token').length;
    fake.expireTokens();
    const res = await ship(ctx, order.id);
    expect(res.status).toBe(201);
    expect(fake.callsTo('POST', '/token').length).toBe(loginsBefore + 1);
    // denied once, then accepted with the fresh token
    expect(fake.callsTo('GET', '/api/packages/GetCityZoneList').length).toBe(2);
    expect(addOrdersBodies()).toHaveLength(1);
  });

  it('marks the account invalid when the stored password stops working', async () => {
    const ctx = await connected();
    const order = await confirmedOrder(ctx);
    fake.expireTokens();
    const account = await db.CarrierAccount.findOne({ where: { workspaceId: ctx.ws } });
    // The password was changed at Mylerz: every login now fails.
    httpSpy.mockImplementation((opts) =>
      opts.url.endsWith('/token')
        ? Promise.resolve({ status: 400, ok: false, json: { error: 'invalid_grant' }, text: '', headers: new Map() })
        : fake.handle(opts)
    );
    const res = await ship(ctx, order.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CARRIER_AUTH_FAILED');
    expect((await account.reload()).status).toBe('invalid');
  });
});

// --- statuses ----------------------------------------------------------------------------

describe('Mylerz status mapping', () => {
  it('maps the two Status values official sources name, and nothing else', () => {
    expect(mylerz.mapStatus({ Status: fake.DELIVERED })).toEqual({ status: 'delivered' });
    expect(mylerz.mapStatus({ Status: fake.REJECTED })).toEqual({ status: 'failed' });
    expect(Object.keys(mylerz.STATE_MAP)).toEqual([fake.DELIVERED, fake.REJECTED]);
    for (const other of ['New', 'Out for delivery', 'Cancelled', '', null]) {
      expect(mylerz.mapStatus({ Status: other })).toEqual({ status: undefined });
    }
  });

  it('never treats a state as "already cancelled" (none is documented)', () => {
    expect(mylerz.isCancelSettled({ code: 99, value: 'Cancelled' })).toBe(false);
    expect(mylerz.isCancelSettled(null)).toBe(false);
  });
});

describe('polling Mylerz', () => {
  it('books with a first poll scheduled, and the sync cron reads due packages in one bulk call', async () => {
    const a = await booked();
    const order2 = await confirmedOrder(a);
    const second = (await ship(a, order2.id)).body.shipment;
    expect(a.shipment.nextPollAt).not.toBeNull();

    fake.setStatus(a.shipment.waybillNumber, fake.DELIVERED, 70);
    fake.setStatus(second.waybillNumber, fake.REJECTED, 80);
    await sync.syncDue({ now: new Date(Date.now() + 2 * HOUR) });

    const bulk = fake.callsTo('POST', '/api/packages/GetPackageListStatus');
    expect(bulk).toHaveLength(1);
    expect([...bulk[0].body].sort()).toEqual([a.shipment.waybillNumber, second.waybillNumber].sort());

    const delivered = await db.Shipment.findByPk(a.shipment.id);
    expect(delivered.status).toBe('delivered');
    expect(delivered.nextPollAt).toBeNull();
    expect(delivered.carrierResponse.lastCarrierStatus).toEqual({ code: 70, value: fake.DELIVERED, phase: 'Pickup' });
    expect((await db.Shipment.findByPk(second.id)).status).toBe('failed');
  });

  it('an undocumented status leaves the shipment where it is, records what Mylerz said, and warns', async () => {
    const ctx = await booked();
    const warn = jest.spyOn(logger, 'warn');
    fake.setStatus(ctx.shipment.waybillNumber, 'Out For Delivery', 40);
    const res = await ctx.api('post', `/orders/${ctx.order.id}/shipments/${ctx.shipment.id}/sync`);
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.shipment.status).toBe('created');
    expect(res.body.carrierStatus).toEqual({ code: 40, value: 'Out For Delivery', phase: 'Pickup' });
    expect(warn).toHaveBeenCalledWith('Unmapped Mylerz package status — shipment status left unchanged', expect.objectContaining({ status: 'Out For Delivery' }));
  });

  it('a barcode Mylerz does not answer for is a failed read, not a status', async () => {
    const out = await mylerz.getShipments(CREDS, ['99999999999999']);
    expect(out.size).toBe(0);
    await expect(mylerz.getShipment(CREDS, '99999999999999')).rejects.toMatchObject({ code: 'CARRIER_ERROR' });
  });
});

// --- cancel -------------------------------------------------------------------------------

describe('cancelling an order with a Mylerz shipment', () => {
  it('cancels the package at Mylerz through CancelPackage, then the order', async () => {
    const ctx = await booked();
    const res = await ctx.api('post', `/orders/${ctx.order.id}/cancel`).send({ reason: 'Customer changed their mind' });
    expect(res.status).toBe(200);
    expect(fake.callsTo('POST', '/api/packages/CancelPackage')[0].body).toEqual([{ Barcode: ctx.shipment.waybillNumber }]);
    const shipment = await db.Shipment.findByPk(ctx.shipment.id);
    expect(shipment.status).toBe('cancelled');
    expect(shipment.cancelMode).not.toBe('manual_ack');
  });

  it('IsChanged false: 409 CARRIER_CANCEL_FAILED with Mylerz\'s reason, and nothing changes', async () => {
    const ctx = await booked();
    fake.state().refuseCancel = 'Package already picked up';
    const res = await ctx.api('post', `/orders/${ctx.order.id}/cancel`).send({ reason: 'Customer changed their mind' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CARRIER_CANCEL_FAILED');
    expect(res.body.error.message).toContain('Mylerz: Package already picked up');
    expect((await db.Shipment.findByPk(ctx.shipment.id)).status).toBe('created');
    expect((await db.Order.findByPk(ctx.order.id)).cancelledAt).toBeNull();
  });
});

// --- label --------------------------------------------------------------------------------

describe('the Mylerz label', () => {
  const getLabel = (ctx) =>
    ctx
      .api('get', `/orders/${ctx.order.id}/shipments/${ctx.shipment.id}/label`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  it('proxies the AWB PDF from GetAWB', async () => {
    const ctx = await booked();
    const res = await getLabel(ctx);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(Buffer.compare(res.body, fake.PDF_BYTES)).toBe(0);
    expect(fake.callsTo('POST', '/api/packages/GetAWB')[0].body).toEqual({ Barcode: ctx.shipment.waybillNumber });
  });

  it('refuses anything that is not a PDF with 502', async () => {
    const ctx = await booked();
    fake.state().awbNotPdf = true;
    const res = await getLabel(ctx);
    expect(res.status).toBe(502);
  });
});

// --- rollout + shared plumbing ------------------------------------------------------

describe('rollout', () => {
  it('Mylerz is invisible to a store outside CARRIERS_BETA_WORKSPACES', async () => {
    const outside = await setupWorkspaceWithProduct();
    const api = (method, p) => request(app)[method](`/api/v1/workspaces/${outside.workspace.id}${p}`).set(bearer(outside.auth.accessToken));
    const list = await api('get', '/carriers');
    expect(list.body.carriers.map((c) => c.code)).toEqual(['bosta']);
    expect((await api('put', '/carriers/mylerz').send({ credentials: CREDS })).status).toBe(404);
    expect(fake.state().calls).toHaveLength(0);
  });
});

describe('carrierHttp form bodies', () => {
  it('sends `form` as application/x-www-form-urlencoded (the /token exchange)', async () => {
    httpSpy.mockRestore();
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ access_token: 't' }), { status: 200 }));
    await carrierHttp.request({ method: 'POST', url: 'https://integration.mylerz.net/token', form: { grant_type: 'password', username: 'a b', password: 'p&q' } });
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toBe('grant_type=password&username=a+b&password=p%26q');
  });
});

// --- the login token ------------------------------------------------------------------

describe('the Mylerz login token', () => {
  const bulkCalls = () => fake.callsTo('POST', '/api/packages/GetPackageListStatus');
  const logins = () => fake.callsTo('POST', '/token');
  const accountOf = (ctx) => db.CarrierAccount.findOne({ where: { workspaceId: ctx.ws, carrierCode: 'mylerz' } });

  it('is cached: one login serves every later call', async () => {
    await mylerz.verifyCredentials(CREDS);
    await mylerz.listAddressTree(CREDS);
    await mylerz.getShipments(CREDS, ['10000000000001']);
    expect(logins()).toHaveLength(1);
    const tokensUsed = new Set(fake.state().calls.filter((c) => c.path !== '/token').map((c) => c.headers.Authorization));
    expect(tokensUsed.size).toBe(1);
  });

  it('an expired cached token during polling: one fresh login, the call repeated, the account stays active', async () => {
    const ctx = await booked();
    fake.setStatus(ctx.shipment.waybillNumber, fake.DELIVERED, 70);
    fake.expireTokens();
    const loginsBefore = logins().length;

    const outcome = await sync.syncDue({ now: new Date(Date.now() + 2 * HOUR) });

    expect(outcome).toMatchObject({ changed: 1, failed: 0, paused: 0 });
    expect(logins().length).toBe(loginsBefore + 1);
    // Refused with the old token, then answered with the new one.
    const [refused, answered] = bulkCalls();
    expect(refused.headers.Authorization).not.toBe(answered.headers.Authorization);
    expect((await db.Shipment.findByPk(ctx.shipment.id)).status).toBe('delivered');
    expect((await accountOf(ctx)).status).toBe('active');
  });

  it('only a failed fresh login rejects the credentials: account invalid, polling stops without calling Mylerz, and resumes after reconnecting', async () => {
    const ctx = await booked();
    fake.revokePassword(fake.PASSWORD); // changed at Mylerz: cached token dead, login refused
    const t1 = new Date(Date.now() + 2 * HOUR);

    const first = await sync.syncDue({ now: t1 });
    expect(first).toMatchObject({ paused: 1, failed: 0, changed: 0 });
    expect((await accountOf(ctx)).status).toBe('invalid');
    let row = await db.Shipment.findByPk(ctx.shipment.id);
    expect(row.pollFailures).toBe(0);
    expect(row.nextPollAt.getTime()).toBe(t1.getTime() + 60 * 60 * 1000);

    // Next run: the account is invalid, so Mylerz is not called at all.
    const callsBefore = fake.state().calls.length;
    const t2 = new Date(t1.getTime() + 2 * HOUR);
    expect(await sync.syncDue({ now: t2 })).toMatchObject({ claimed: 1, paused: 1 });
    expect(fake.state().calls.length).toBe(callsBefore);

    // The merchant reconnects with the new password: polling picks up again.
    expect((await connect(ctx, { credentials: { ...CREDS, password: fake.OTHER_PASSWORD } })).status).toBe(200);
    fake.setStatus(ctx.shipment.waybillNumber, fake.DELIVERED, 70);
    await sync.syncDue({ now: new Date(t2.getTime() + 2 * HOUR) });
    row = await db.Shipment.findByPk(ctx.shipment.id);
    expect(row.status).toBe('delivered');
  });

  it('refused right after a successful login is not a credentials problem: no second login, account not marked invalid', async () => {
    const ctx = await booked();
    fake.state().denyAll = true;
    mylerz.clearTokens();
    const loginsBefore = logins().length;

    const res = await ctx.api('post', `/orders/${ctx.order.id}/shipments/${ctx.shipment.id}/sync`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CARRIER_PERMISSION_DENIED');
    expect(logins().length).toBe(loginsBefore + 1);
    expect((await accountOf(ctx)).status).toBe('active');
  });
});
