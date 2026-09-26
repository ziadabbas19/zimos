'use strict';

// The generic carrier layer, exercised through test-only fake carriers
// (tests/helpers/fakeCarriers.js): the adapter contract, the env rollout
// gate (CARRIERS_ENABLED / CARRIERS_BETA / CARRIERS_BETA_WORKSPACES), manual
// name reservation for non-Bosta carriers, the connect race, and address
// trees deeper than city/district.

const crypto = require('crypto');
const Joi = require('joi');
const { setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const accounts = require('../../src/modules/shipping/carrierAccountService');
const { defineAdapter } = require('../../src/modules/shipping/carriers/adapterContract');
const fakes = require('../helpers/fakeCarriers');

const originalKey = env.carriers.credentialsKey;
let uninstall;

beforeAll(() => {
  env.carriers.credentialsKey = crypto.randomBytes(32).toString('base64');
});

afterAll(() => {
  env.carriers.credentialsKey = originalKey;
});

beforeEach(() => {
  fakes.reset();
  accounts.clearCitiesCache();
});

afterEach(() => {
  if (uninstall) uninstall();
  uninstall = null;
});

async function workspace() {
  const setup = await setupWorkspaceWithProduct({ price: 5000, stock: 20 });
  return { ...setup, token: setup.auth.accessToken, api: fakes.api(setup.auth.accessToken) };
}

describe('the adapter contract', () => {
  const base = () => ({
    code: 'x',
    name: 'X',
    credentialsSchema: Joi.object(),
    settingsSchema: Joi.object(),
    credentialFields: [],
    settingFields: [],
    verifyCredentials: async () => ({}),
    createShipment: async () => ({}),
    getShipment: async () => ({}),
    cancelShipment: async () => {},
    listCities: async () => [],
  });

  it('accepts a complete adapter and derives the fields the dashboard reads', () => {
    const adapter = defineAdapter({ ...base(), capabilities: { webhook: 'none', label: false } });
    expect(adapter).toMatchObject({ webhookSetup: 'none', supportsLabel: false, pollIntervalMinutes: 60 });
    expect(adapter.capabilities).toMatchObject({ cancel: 'api', polling: false, addressLevels: ['city', 'district'] });
  });

  it.each([
    [{ capabilities: { cancel: 'api' } }, { cancelShipment: undefined }, /cancelShipment/],
    [{ capabilities: { label: true } }, {}, /getLabel/],
    [{ capabilities: { webhook: 'account' } }, {}, /parseWebhook/],
    [{ capabilities: { webhook: 'account', webhookRefetch: false } }, { parseWebhook: () => null }, /verifyWebhook/],
    [{ capabilities: { bulkStatus: true } }, {}, /getShipments/],
    [{ capabilities: { addressLevels: ['a', 'b', 'c'] } }, {}, /listAddressTree/],
    [{ capabilities: { teleport: true } }, {}, /unknown capabilities/],
    [{ code: 'manual' }, {}, /reserved/],
  ])('refuses %j', (extra, overrides, message) => {
    expect(() => defineAdapter({ ...base(), ...overrides, ...extra })).toThrow(message);
  });

  it('describes capabilities in the carriers list', async () => {
    uninstall = fakes.installFakeCarriers();
    const ws = await workspace();
    const res = await ws.api.list(ws.workspace.id);
    expect(res.status).toBe(200);
    const byCode = Object.fromEntries(res.body.carriers.map((c) => [c.code, c]));
    expect(Object.keys(byCode)).toEqual(['bosta', 'fakepoll', 'fakemanual']);
    expect(byCode.bosta.capabilities).toEqual({
      cancel: 'api',
      label: true,
      webhook: 'per_shipment',
      polling: false,
      addressLevels: ['city', 'district'],
    });
    expect(byCode.fakemanual).toMatchObject({ webhookSetup: 'account', capabilities: { cancel: 'manual', addressLevels: ['zone', 'area'] } });
  });
});

describe('rollout gate', () => {
  it('a registered carrier that is neither enabled nor beta does not exist', async () => {
    uninstall = fakes.installFakeCarriers();
    env.carriers.enabled = ['bosta'];
    const ws = await workspace();
    expect((await ws.api.list(ws.workspace.id)).body.carriers.map((c) => c.code)).toEqual(['bosta']);
    expect((await ws.api.connect(ws.workspace.id, 'fakepoll')).status).toBe(404);
  });

  it('CARRIERS_ENABLED can switch Bosta off too', async () => {
    const original = env.carriers.enabled;
    env.carriers.enabled = [];
    try {
      const ws = await workspace();
      expect((await ws.api.list(ws.workspace.id)).body.carriers).toEqual([]);
      expect((await ws.api.connect(ws.workspace.id, 'bosta', { credentials: { apiKey: 'x'.repeat(20) } })).status).toBe(404);
      // Not a courier on this server: "Bosta" is just a manual courier name.
      const order = await ws.api.confirmedOrder(ws.workspace.id, ws.variant.id);
      const manual = await ws.api.ship(ws.workspace.id, order.id, { carrierCode: 'Bosta', waybillNumber: 'B-1' });
      expect(manual.status).toBe(201);
      expect(manual.body.shipment.carrierCode).toBe('Bosta');
    } finally {
      env.carriers.enabled = original;
    }
  });

  describe('beta carriers', () => {
    const originalBetaWorkspaces = env.carriers.betaWorkspaces;
    afterEach(() => {
      env.carriers.betaWorkspaces = originalBetaWorkspaces;
    });

    it('are listed and connectable only for the workspaces in CARRIERS_BETA_WORKSPACES', async () => {
      uninstall = fakes.installFakeCarriers({ beta: true });
      const inBeta = await workspace();
      const outside = await workspace();
      env.carriers.betaWorkspaces = [String(inBeta.workspace.slug).toLowerCase()];

      expect((await inBeta.api.list(inBeta.workspace.id)).body.carriers.map((c) => c.code)).toEqual([
        'bosta',
        'fakepoll',
        'fakemanual',
      ]);
      expect((await inBeta.api.connect(inBeta.workspace.id, 'fakepoll')).status).toBe(200);

      expect((await outside.api.list(outside.workspace.id)).body.carriers.map((c) => c.code)).toEqual(['bosta']);
      const refused = await outside.api.connect(outside.workspace.id, 'fakepoll');
      expect(refused.status).toBe(404);
      expect(await db.CarrierAccount.count({ where: { workspaceId: outside.workspace.id } })).toBe(0);
    });

    it('everything else treats a beta carrier as absent: its code is a manual courier name', async () => {
      uninstall = fakes.installFakeCarriers({ beta: true });
      const outside = await workspace();
      env.carriers.betaWorkspaces = ['some-other-store'];
      const order = await outside.api.confirmedOrder(outside.workspace.id, outside.variant.id);
      const res = await outside.api.ship(outside.workspace.id, order.id, { carrierCode: 'fakepoll' });
      expect(res.status).toBe(201);
      expect(res.body.shipment).toMatchObject({ carrierCode: 'fakepoll', carrierResponse: null });
      expect(fakes.calls('createShipment')).toHaveLength(0);
    });

    it('a beta carrier\'s webhook stops resolving once the store leaves the beta', async () => {
      uninstall = fakes.installFakeCarriers({ beta: true });
      const ws = await workspace();
      env.carriers.betaWorkspaces = [String(ws.workspace.slug).toLowerCase()];
      const connected = await ws.api.connect(ws.workspace.id, 'fakepoll');
      const token = connected.body.webhook.url.split('/').pop();
      const { app, request } = require('../helpers/factories');
      const webhooks = require('../../src/modules/shipping/carrierWebhookService');

      expect((await request(app).post(`/api/v1/webhooks/carriers/fakepoll/${token}`).send({ ref: 'FP00001' })).status).toBe(200);
      await webhooks.whenIdle();
      env.carriers.betaWorkspaces = [];
      expect((await request(app).post(`/api/v1/webhooks/carriers/fakepoll/${token}`).send({ ref: 'FP00001' })).status).toBe(404);
    });
  });
});

describe('manual courier names of carriers other than Bosta', () => {
  it('stay free on a store that has not connected the carrier', async () => {
    uninstall = fakes.installFakeCarriers();
    const ws = await workspace();
    const order = await ws.api.confirmedOrder(ws.workspace.id, ws.variant.id);
    for (const name of ['FakePoll', 'fakepoll']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await ws.api.ship(ws.workspace.id, order.id, { carrierCode: name, waybillNumber: 'W-1' });
      expect([name, res.status]).toEqual([name, 201]);
      // eslint-disable-next-line no-await-in-loop
      await ws.api.patchShipment(ws.workspace.id, order.id, res.body.shipment.id, { status: 'cancelled' });
    }
    expect(fakes.calls('createShipment')).toHaveLength(0);
  });

  it('are reserved once the store connected it', async () => {
    uninstall = fakes.installFakeCarriers();
    const ws = await workspace();
    expect((await ws.api.connect(ws.workspace.id, 'fakepoll')).status).toBe(200);
    const order = await ws.api.confirmedOrder(ws.workspace.id, ws.variant.id);

    const typed = await ws.api.ship(ws.workspace.id, order.id, { carrierCode: 'Fake-Poll', waybillNumber: 'W-1' });
    expect(typed.status).toBe(422);
    expect(typed.body.error.code).toBe('CARRIER_NAME_RESERVED');
    expect(typed.body.error.details[0]).toMatchObject({ carrierCode: 'fakepoll', connected: true });
  });
});

describe('connecting', () => {
  it('two first-time connects at once: one connects, the other gets 409 CARRIER_CONNECT_CONFLICT', async () => {
    uninstall = fakes.installFakeCarriers();
    const ws = await workspace();
    let release;
    fakes.state.verifyGate = new Promise((resolve) => {
      release = resolve;
    });

    const both = [ws.api.connect(ws.workspace.id, 'fakepoll'), ws.api.connect(ws.workspace.id, 'fakepoll')].map((req) =>
      req.then((res) => res)
    );
    // Both requests have read "no existing connection" and are verifying.
    while (fakes.calls('verifyCredentials', 'fakepoll').length < 2) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    release();
    const results = await Promise.all(both);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409).body.error.code).toBe('CARRIER_CONNECT_CONFLICT');
    expect(await db.CarrierAccount.count({ where: { workspaceId: ws.workspace.id, carrierCode: 'fakepoll' } })).toBe(1);
  });
});

describe('a three-level address tree', () => {
  async function connected() {
    uninstall = fakes.installFakeCarriers();
    const ws = await workspace();
    const res = await ws.api.connect(ws.workspace.id, 'fakepoll');
    if (res.status !== 200) throw new Error(`connect failed: ${res.status} ${JSON.stringify(res.body)}`);
    return ws;
  }

  it('serves the tree with its level names', async () => {
    const ws = await connected();
    const res = await ws.api.cities(ws.workspace.id, 'fakepoll');
    expect(res.status).toBe(200);
    expect(res.body.levels).toEqual(['governorate', 'city', 'area']);
    expect(res.body.cities.map((c) => c.id)).toEqual(['G-CAI', 'G-GIZ']);
    expect(res.body.cities[0].children[0].children.map((a) => a.id)).toEqual(['A-NASR-1', 'A-NASR-7']);
  });

  it('matches an area two levels below the governorate and books the full path', async () => {
    const ws = await connected();
    const order = await ws.api.confirmedOrder(ws.workspace.id, ws.variant.id, { ...fakes.CAIRO_ADDRESS, city: 'الحي السابع' });
    const res = await ws.api.ship(ws.workspace.id, order.id, { carrierCode: 'fakepoll' });

    expect(res.status).toBe(201);
    expect(res.body.shipment.carrierResponse.address).toEqual({ path: ['G-CAI', 'C-NASR', 'A-NASR-7'] });
    const sent = fakes.calls('createShipment', 'fakepoll')[0].input.address;
    expect(sent.path.map((n) => [n.id, n.level])).toEqual([
      ['G-CAI', 'governorate'],
      ['C-NASR', 'city'],
      ['A-NASR-7', 'area'],
    ]);
    expect(sent.firstLine).toBe('12 Abbas El Akkad Street');
    expect(sent.cityId).toBeUndefined();
  });

  it('a middle-level match asks for the level below it', async () => {
    const ws = await connected();
    const order = await ws.api.confirmedOrder(ws.workspace.id, ws.variant.id, { ...fakes.CAIRO_ADDRESS, city: 'Nasr City' });
    const res = await ws.api.ship(ws.workspace.id, order.id, { carrierCode: 'fakepoll' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CARRIER_ADDRESS_UNMATCHED');
    expect(res.body.error.details).toMatchObject({
      carrierCode: 'fakepoll',
      level: 'area',
      levelIndex: 2,
      levels: ['governorate', 'city', 'area'],
      matchedCity: { id: 'G-CAI' },
      matchedPath: [{ id: 'G-CAI' }, { id: 'C-NASR' }],
    });
    expect(res.body.error.details.candidates.map((c) => [c.id, c.leaf, c.suggested])).toEqual([
      ['A-NASR-1', true, false],
      ['A-NASR-7', true, false],
    ]);
    expect(res.body.error.details.candidates[1].path.map((p) => p.id)).toEqual(['G-CAI', 'C-NASR', 'A-NASR-7']);
    expect(fakes.calls('createShipment')).toHaveLength(0);
  });

  it('an unknown area under a known governorate asks for the city, with partial matches first', async () => {
    const ws = await connected();
    const order = await ws.api.confirmedOrder(ws.workspace.id, ws.variant.id, { ...fakes.CAIRO_ADDRESS, city: 'New' });
    const res = await ws.api.ship(ws.workspace.id, order.id, { carrierCode: 'fakepoll' });
    expect(res.status).toBe(422);
    expect(res.body.error.details.level).toBe('city');
    expect(res.body.error.details.candidates.map((c) => [c.id, c.leaf, c.suggested])).toEqual([
      ['C-NEWCAI', false, true],
      ['C-NASR', false, false],
    ]);
  });

  it('books an explicit path, and names the bad level of a wrong one', async () => {
    const ws = await connected();
    const order = await ws.api.confirmedOrder(ws.workspace.id, ws.variant.id, { ...fakes.CAIRO_ADDRESS, city: 'Nowhere' });

    const short = await ws.api.ship(ws.workspace.id, order.id, { carrierCode: 'fakepoll', carrierAddress: { path: ['G-CAI', 'C-NASR'] } });
    expect(short.status).toBe(422);
    expect(short.body.error.details[0].field).toBe('carrierAddress.path');

    const wrong = await ws.api.ship(ws.workspace.id, order.id, {
      carrierCode: 'fakepoll',
      carrierAddress: { path: ['G-CAI', 'C-NASR', 'A-REHAB'] },
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.details[0]).toMatchObject({ field: 'carrierAddress.path.2' });

    const both = await ws.api.ship(ws.workspace.id, order.id, {
      carrierCode: 'fakepoll',
      carrierAddress: { path: ['G-CAI', 'C-NEWCAI', 'A-REHAB'], cityId: 'G-CAI' },
    });
    expect(both.status).toBe(422);

    const ok = await ws.api.ship(ws.workspace.id, order.id, {
      carrierCode: 'fakepoll',
      carrierAddress: { path: ['G-CAI', 'C-NEWCAI', 'A-REHAB'] },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.shipment.carrierResponse.address).toEqual({ path: ['G-CAI', 'C-NEWCAI', 'A-REHAB'] });
  });

  it('Bosta accepts carrierAddress.path as well as cityId/districtId', async () => {
    // Covered for the matcher only: the two forms resolve to the same result.
    const { buildIndex, citiesToTree, matchAddress } = require('../../src/modules/shipping/carrierAddressMatching');
    const bosta = require('../../src/modules/shipping/carriers/bosta');
    const index = await buildIndex(
      citiesToTree([
        { id: 'CAI', name: 'Cairo', nameAr: 'القاهرة', districts: [{ id: 'D-1', name: 'Maadi', nameAr: 'المعادي', zoneId: 'Z-1' }] },
      ])
    );
    const viaIds = await matchAddress(bosta, index, {}, { cityId: 'CAI', districtId: 'D-1' });
    const viaPath = await matchAddress(bosta, index, {}, { path: ['CAI', 'D-1'] });
    expect(viaPath).toEqual(viaIds);
    expect(viaIds).toMatchObject({ cityId: 'CAI', cityName: 'Cairo', districtId: 'D-1', zoneId: 'Z-1' });
  });
});
