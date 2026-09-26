'use strict';

// Test-only courier adapters, registered through carriers.registerTestAdapter
// so the generic carrier paths can be exercised without Bosta:
//
//   fakepoll    three address levels (governorate > city > area), polled by
//               the carrier-sync cron with a bulk status call, cancelled
//               through its API, account-level webhook
//   fakemanual  two non-city/district levels (zone > area), no cancel API
//               (manual cancel + acknowledgement), polled one at a time,
//               account-level webhook
//
// Both keep their parcels in one shared in-memory `state`, which tests drive
// directly (setStatus, failReads, omitFromBulk, ...).

const Joi = require('joi');
const carriers = require('../../src/modules/shipping/carriers');
const { CarrierAuthError, CarrierError } = require('../../src/modules/shipping/carriers/carrierErrors');
const env = require('../../src/config/env');

const GOOD_TOKEN = 'fake-carrier-good-token';

const POLL_TREE = [
  {
    id: 'G-CAI',
    name: 'Cairo',
    nameAr: 'القاهرة',
    children: [
      {
        id: 'C-NASR',
        name: 'Nasr City',
        nameAr: 'مدينة نصر',
        children: [
          { id: 'A-NASR-1', name: 'First District', nameAr: 'الحي الاول' },
          { id: 'A-NASR-7', name: 'Seventh District', nameAr: 'الحي السابع' },
        ],
      },
      {
        id: 'C-NEWCAI',
        name: 'New Cairo',
        nameAr: 'القاهرة الجديدة',
        children: [
          { id: 'A-TAGAMOA-5', name: 'Fifth Settlement', nameAr: 'التجمع الخامس' },
          { id: 'A-REHAB', name: 'Rehab', nameAr: 'الرحاب' },
        ],
      },
    ],
  },
  {
    id: 'G-GIZ',
    name: 'Giza',
    nameAr: 'الجيزة',
    children: [
      {
        id: 'C-DOKKI',
        name: 'Dokki',
        nameAr: 'الدقي',
        children: [{ id: 'A-DOKKI-1', name: 'Mesaha', nameAr: 'المساحة' }],
      },
    ],
  },
];

const MANUAL_TREE = [
  {
    id: 'Z-CAI',
    name: 'Cairo',
    nameAr: 'القاهرة',
    children: [
      { id: 'AR-NASR', name: 'Nasr City', nameAr: 'مدينة نصر' },
      { id: 'AR-MAADI', name: 'Maadi', nameAr: 'المعادي' },
    ],
  },
];

const state = {
  calls: [],
  parcels: new Map(),
  next: 1,
  failReads: false,
  omitFromBulk: new Set(),
  refuseCancel: false,
  // A promise every verifyCredentials waits on (to line up concurrent connects).
  verifyGate: null,
};

function reset() {
  state.calls = [];
  state.parcels = new Map();
  state.next = 1;
  state.failReads = false;
  state.omitFromBulk = new Set();
  state.refuseCancel = false;
  state.verifyGate = null;
}

/** Moves a parcel at the fake carrier. `status` is OUR status (or null). */
function setStatus(ref, status, code = String(status).toUpperCase()) {
  const parcel = state.parcels.get(ref);
  if (!parcel) throw new Error(`fake carrier: no parcel ${ref}`);
  Object.assign(parcel, { status, code });
}

const calls = (fn, code) => state.calls.filter((c) => c.fn === fn && (!code || c.code === code));

function makeAdapter(code, name, { capabilities, tree, prefix }) {
  const credentialsSchema = Joi.object({ token: Joi.string().required() });
  const settingsSchema = Joi.object({}).unknown(false);

  const read = (ref) => {
    const parcel = state.parcels.get(ref);
    if (!parcel || parcel.carrier !== code) throw new CarrierError(`${name}: no such parcel ${ref}`);
    return { status: parcel.status, carrierStatus: { code: parcel.code, value: parcel.code }, raw: { ref } };
  };
  const auth = (creds) => {
    if (!creds || creds.token !== GOOD_TOKEN) throw new CarrierAuthError(name);
  };

  const adapter = {
    code,
    name,
    capabilities,
    pollIntervalMinutes: 30,
    credentialFields: [{ key: 'token', label: 'Token', secret: true }],
    settingFields: [],
    credentialsSchema,
    settingsSchema,
    async verifyCredentials(creds) {
      state.calls.push({ fn: 'verifyCredentials', code });
      auth(creds);
      if (state.verifyGate) await state.verifyGate;
      return {};
    },
    async listAddressTree(creds) {
      state.calls.push({ fn: 'listAddressTree', code });
      auth(creds);
      return tree;
    },
    async createShipment(creds, input) {
      auth(creds);
      const ref = `${prefix}${String(state.next++).padStart(5, '0')}`;
      state.parcels.set(ref, { carrier: code, status: 'created', code: 'CREATED' });
      state.calls.push({ fn: 'createShipment', code, ref, input });
      return { trackingNumber: ref, carrierShipmentId: `id-${ref}`, trackingUrl: null, raw: { ref } };
    },
    async getShipment(creds, ref) {
      state.calls.push({ fn: 'getShipment', code, ref });
      auth(creds);
      if (state.failReads) throw new CarrierError(`${name} did not respond (timed out)`);
      return read(ref);
    },
    parseWebhook(req) {
      const ref = req.body && typeof req.body.ref === 'string' ? req.body.ref : null;
      return ref ? { ref } : null;
    },
  };

  if (capabilities.bulkStatus) {
    adapter.getShipments = async (creds, refs) => {
      state.calls.push({ fn: 'getShipments', code, refs: [...refs] });
      auth(creds);
      if (state.failReads) throw new CarrierError(`${name} did not respond (timed out)`);
      const out = new Map();
      for (const ref of refs) if (!state.omitFromBulk.has(ref)) out.set(ref, read(ref));
      return out;
    };
  }
  if (capabilities.cancel === 'api') {
    adapter.cancelShipment = async (creds, ref) => {
      state.calls.push({ fn: 'cancelShipment', code, ref });
      auth(creds);
      if (state.refuseCancel) throw new CarrierError(`${name}: cannot cancel in this state`);
      setStatus(ref, 'cancelled');
    };
  }
  return adapter;
}

const SPECS = {
  fakepoll: () =>
    makeAdapter('fakepoll', 'FakePoll', {
      prefix: 'FP',
      tree: POLL_TREE,
      capabilities: {
        cancel: 'api',
        webhook: 'account',
        polling: true,
        bulkStatus: true,
        addressLevels: ['governorate', 'city', 'area'],
      },
    }),
  fakemanual: () =>
    makeAdapter('fakemanual', 'FakeManual', {
      prefix: 'FM',
      tree: MANUAL_TREE,
      capabilities: {
        cancel: 'manual',
        webhook: 'account',
        polling: true,
        bulkStatus: false,
        addressLevels: ['zone', 'area'],
      },
    }),
};

/**
 * Registers the fake carriers for this test file and enables them globally
 * (or as beta with { beta: true }). Call from beforeAll; returns the undo
 * for afterAll.
 */
function installFakeCarriers({ beta = false } = {}) {
  const originalEnabled = env.carriers.enabled;
  const originalBeta = env.carriers.beta;
  const unregister = Object.keys(SPECS).map((code) => carriers.registerTestAdapter(SPECS[code]()));
  if (beta) env.carriers.beta = [...originalBeta, ...Object.keys(SPECS)];
  else env.carriers.enabled = [...originalEnabled, ...Object.keys(SPECS)];
  return () => {
    unregister.forEach((undo) => undo());
    env.carriers.enabled = originalEnabled;
    env.carriers.beta = originalBeta;
  };
}

// --- request helpers --------------------------------------------------------------

let seq = 0;
const idempotencyKey = () => `fake-carrier-${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2)}`;
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

const CAIRO_ADDRESS = { country: 'EG', province: 'Cairo', city: 'Seventh District', addressLine: '12 Abbas El Akkad Street' };

function api(token) {
  // Required lazily: factories boots the app.
  const { app, request, confirmCodOrder } = require('./factories');
  return {
    connect: (workspaceId, code, body = { credentials: { token: GOOD_TOKEN } }) =>
      request(app).put(`/api/v1/workspaces/${workspaceId}/carriers/${code}`).set(bearer(token)).send(body),
    list: (workspaceId) => request(app).get(`/api/v1/workspaces/${workspaceId}/carriers`).set(bearer(token)),
    cities: (workspaceId, code) => request(app).get(`/api/v1/workspaces/${workspaceId}/carriers/${code}/cities`).set(bearer(token)),
    ship: (workspaceId, orderId, body) =>
      request(app).post(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/shipments`).set(bearer(token)).send(body),
    patchShipment: (workspaceId, orderId, shipmentId, body) =>
      request(app)
        .patch(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/shipments/${shipmentId}`)
        .set(bearer(token))
        .send(body),
    cancelOrder: (workspaceId, orderId, extra = {}) =>
      request(app)
        .post(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/cancel`)
        .set(bearer(token))
        .send({ reason: 'Customer changed their mind', ...extra }),
    getOrder: (workspaceId, orderId) =>
      request(app).get(`/api/v1/workspaces/${workspaceId}/orders/${orderId}`).set(bearer(token)),
    /** A confirmed COD order, ready to ship. */
    async confirmedOrder(workspaceId, variantId, address = CAIRO_ADDRESS) {
      const res = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/orders`)
        .set(bearer(token))
        .set('Idempotency-Key', idempotencyKey())
        .send({
          items: [{ variantId, quantity: 1 }],
          contact: { fullName: 'Mona Adel', phone: '+201012345678' },
          shippingAddress: address,
          paymentMethod: 'cod',
        });
      if (res.status !== 201) throw new Error(`order failed: ${res.status} ${JSON.stringify(res.body)}`);
      await confirmCodOrder(token, workspaceId, res.body.order.id);
      return res.body.order;
    },
  };
}

module.exports = {
  installFakeCarriers,
  reset,
  setStatus,
  calls,
  state,
  api,
  GOOD_TOKEN,
  CAIRO_ADDRESS,
  POLL_TREE,
  MANUAL_TREE,
};
