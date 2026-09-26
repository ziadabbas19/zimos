'use strict';

// A fake J&T Express Egypt open platform behind carrierHttp.request,
// answering in the shapes of the platform's documented samples
// (https://open.jtjms-eg.com, #/apiDoc/...). Nothing here reaches
// openapi.jtjms-eg.com.
//
//   jest.spyOn(carrierHttp, 'request').mockImplementation(fakeJt.handle)
//
// Both digests are checked with an independent port of J&T's own PHP
// signature example, so a wrong signing algorithm fails here the way it
// would at J&T (145003030 / 145003031).

const crypto = require('crypto');

const API_ACCOUNT = '565643854787645440';
const PRIVATE_KEY = 'jt-private-key-0123456789abcdef';
const CUSTOMER_CODE = 'J0086024138';
const PASSWORD = 'KO6w29g2';

// location/getLocation rows for EGY: flat province/city/area with codes.
const LOCATIONS = [
  { prov: 'القاهرة', provCode: '1', city: 'مدينة نصر', cityCode: '11', area: 'الحي السابع', areaCode: '111', postCode: '' },
  { prov: 'القاهرة', provCode: '1', city: 'مدينة نصر', cityCode: '11', area: 'الحي الاول', areaCode: '112', postCode: '' },
  { prov: 'القاهرة', provCode: '1', city: 'المعادي', cityCode: '12', area: 'دجلة', areaCode: '121', postCode: '' },
  { prov: 'الجيزة', provCode: '2', city: 'الدقي', cityCode: '21', area: 'المساحة', areaCode: '211', postCode: '' },
];

const SENDER = {
  senderName: 'Zimos Store',
  senderMobile: '01000000000',
  senderProv: 'القاهرة',
  senderCity: 'المعادي',
  senderArea: 'دجلة',
  senderStreet: '9 Road 233',
};

const PDF_BYTES = Buffer.from('%PDF-1.4\n% fake jt label\n');

// PHP: base64_encode(pack('H*', strtoupper(md5($x))))
const phpDigest = (text) => Buffer.from(crypto.createHash('md5').update(text, 'utf8').digest('hex').toUpperCase(), 'hex').toString('base64');
const expectedBusinessDigest = (customerCode, password, key) =>
  phpDigest(`${customerCode}${crypto.createHash('md5').update(`${password}jadada236t2`).digest('hex')}`.toUpperCase() + key);

let fake;

function reset() {
  fake = {
    calls: [],
    orders: new Map(), // txlogisticId -> order
    byBill: new Map(), // billCode -> order
    nextBill: 1,
    refuseCancel: null, // null | message
    refuseCreate: null, // null | { code, msg }
    awbNotPdf: false,
  };
}
reset();

const reply = (json, status = 200) => ({ status, ok: status >= 200 && status < 300, json, text: JSON.stringify(json), headers: new Map() });
const ok = (data) => reply({ code: '1', msg: 'success', ...(data !== undefined ? { data } : {}) });
const fail = (code, msg) => reply({ code, msg });

const ORDER_PATHS = ['order/addOrder', 'order/cancelOrder', 'order/printOrder', 'vip/checkCusPwd'];

async function handle({ method = 'GET', url, headers = {}, form }) {
  const path = new URL(url).pathname.replace(/^\/webopenplatformapi\/api\//, '');
  const bizContent = form && form.bizContent;
  const biz = bizContent ? JSON.parse(bizContent) : {};
  fake.calls.push({ method, url, path, headers, biz });

  if (method !== 'POST' || !bizContent) return fail('145003050', 'illegal parameter');
  if (headers.apiAccount !== API_ACCOUNT || headers.digest !== phpDigest(bizContent + PRIVATE_KEY) || !/^\d{13}$/.test(headers.timestamp || '')) {
    return fail('145003030', 'headers signature verification failed');
  }
  if (ORDER_PATHS.includes(path) && (biz.customerCode !== CUSTOMER_CODE || biz.digest !== expectedBusinessDigest(CUSTOMER_CODE, PASSWORD, PRIVATE_KEY))) {
    return fail('145003031', 'Business parameter signature verification failed');
  }

  if (path === 'vip/checkCusPwd') return reply({ code: '1', msg: 'success' });
  if (path === 'location/getLocation') {
    if (biz.countryCode !== 'EGY') return fail('145003090', 'three-letter code incomplete');
    return ok(LOCATIONS.map((r, i) => ({ parentId: i, ...r })));
  }
  if (path === 'order/addOrder') {
    if (fake.refuseCreate) return fail(fake.refuseCreate.code, fake.refuseCreate.msg);
    if (fake.orders.has(biz.txlogisticId)) return fail('145003101', 'Customer order number already exists, cannot place an order!');
    const billCode = `UEG${String(fake.nextBill++).padStart(12, '0')}`;
    const order = { txlogisticId: biz.txlogisticId, billCode, details: [], cancelled: false };
    fake.orders.set(biz.txlogisticId, order);
    fake.byBill.set(billCode, order);
    return ok({ txlogisticId: biz.txlogisticId, billCode, sortingCode: '20,J01-01,000', createOrderTime: '2026-09-26 12:00:00', lastCenterName: '10thRamadanCityHub' });
  }
  if (path === 'logistics/trace') {
    const codes = String(biz.billCodes || '').split(',').filter(Boolean);
    if (codes.length > 30) return fail('145003502', 'Waybill numbers exceed 30');
    return ok(codes.filter((c) => fake.byBill.has(c)).map((c) => ({ billCode: c, details: fake.byBill.get(c).details })));
  }
  if (path === 'order/cancelOrder') {
    if (!biz.reason) return fail('145003089', 'Cancellation reason cannot be empty');
    const order = fake.orders.get(biz.txlogisticId);
    if (!order) return fail('145003064', 'No data found');
    if (fake.refuseCancel) return fail('0', fake.refuseCancel);
    order.cancelled = true;
    return ok({ txlogisticId: order.txlogisticId, billCode: order.billCode });
  }
  if (path === 'order/printOrder') {
    if (!fake.byBill.has(biz.billCode)) return fail('145003100', 'Illegal waybill number');
    return ok({ billCode: biz.billCode, base64EncodeContent: (fake.awbNotPdf ? Buffer.from('<html/>') : PDF_BYTES).toString('base64') });
  }
  return fail('145003050', `fake jt: no route ${path}`);
}

/**
 * Adds a scan to a waybill, newest last, as the trace sample's fields:
 * `scanType` label, optional `scanTypeCode`, `problemReason`, and personal
 * data (desc with a courier phone, staffContact) the adapter must not keep.
 */
function addScan(billCode, { scanType, scanTypeCode, problemReason, scanTime }) {
  const order = fake.byBill.get(String(billCode));
  const n = order.details.length;
  order.details.unshift({
    scanTime: scanTime || `2026-09-26 1${n}:00:00`,
    desc: `【Cairo】courier Ahmed(01099999999) scan ${n}`,
    scanType,
    ...(scanTypeCode != null ? { scanTypeCode: String(scanTypeCode) } : {}),
    ...(problemReason ? { problemReason } : {}),
    scanNetworkName: 'Maadi BR',
    staffName: 'Ahmed',
    staffContact: '01099999999',
  });
}

const callsTo = (path) => fake.calls.filter((c) => c.path === path);

module.exports = {
  handle,
  reset,
  addScan,
  callsTo,
  state: () => fake,
  phpDigest,
  expectedBusinessDigest,
  API_ACCOUNT,
  PRIVATE_KEY,
  CUSTOMER_CODE,
  PASSWORD,
  LOCATIONS,
  SENDER,
  PDF_BYTES,
};
