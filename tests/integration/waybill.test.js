'use strict';

// The order waybill PDF: the endpoint returns a real PDF, survives a broken
// logo URL, and the computed model shows the COD amount to collect for a COD
// order but not for a prepaid one.

const zlib = require('zlib');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const waybillService = require('../../src/modules/waybill/waybillService');
const { generateTrackingCode } = require('../../src/modules/orders/shipmentLifecycle');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

const ENGLISH = {
  contact: { fullName: 'Waybill Buyer', phone: '01000007777' },
  shippingAddress: { country: 'EG', province: 'Cairo', city: 'Cairo', addressLine: '7 Waybill St', postalCode: '11311' },
};
const ARABIC = {
  contact: { fullName: 'زياد عباس', phone: '01012345678' },
  shippingAddress: { country: 'EG', province: 'الغربية', city: 'كفر الزيات', addressLine: 'شارع التحرير، عمارة ١٥، شقة 7' },
};
const MIXED = {
  contact: { fullName: 'زياد Abbas', phone: '+20 101 234 5678' },
  shippingAddress: { country: 'EG', province: 'الغربية (Gharbia)', city: 'Kafr Elzayat', addressLine: 'السلخانة' },
};

async function placeOrder(token, workspaceId, variantId, paymentMethod = 'cod', who = ENGLISH) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `w-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({ items: [{ variantId, quantity: 2 }], ...who, paymentMethod });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

// A shipment row as-is; `booked` makes it look like a Bosta booking we made.
function addShipment(workspaceId, order, { carrierCode, waybillNumber = null, booked = false, status = 'created' }) {
  return db.Shipment.create({
    workspaceId,
    orderId: order.id,
    carrierCode,
    waybillNumber,
    status,
    trackingCode: generateTrackingCode(),
    carrierResponse: booked ? { carrierShipmentId: `DLV-${waybillNumber}`, trackingNumber: waybillNumber } : null,
  });
}

// The names of the fonts embedded in a PDF (subset prefix stripped).
const embeddedFonts = (pdf) =>
  [...pdf.toString('latin1').matchAll(/\/BaseFont \/(?:[A-Z]{6}\+)?([A-Za-z0-9-]+)/g)].map((m) => m[1]);

// The text drawn in the standard (Helvetica) fonts: pdfkit writes it as hex
// WinAnsi strings inside Flate-compressed content streams. Arabic runs are
// glyph ids in the embedded font and don't show up here.
function latinText(pdf) {
  const raw = pdf.toString('latin1');
  let out = '';
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content;
    try {
      content = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch (err) {
      continue;
    }
    for (const t of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      out += [...t[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1], 'hex').toString('latin1')).join('');
      out += '\n';
    }
  }
  return out;
}

describe('waybill PDF', () => {
  it('returns application/pdf with a real PDF body', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10, price: 25000 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

    const res = await request(app)
      .get(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/waybill`)
      .set(bearer(auth.accessToken))
      .buffer(true)
      .parse((r, cb) => {
        const data = [];
        r.on('data', (c) => data.push(c));
        r.on('end', () => cb(null, Buffer.concat(data)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toContain(`waybill-${order.orderNumber}.pdf`);
    expect(res.body.slice(0, 5).toString('latin1')).toBe('%PDF-');
    expect(res.body.length).toBeGreaterThan(1000);
  });

  it('a broken logo URL degrades to text and still produces a PDF', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    await db.Workspace.update(
      { logoUrl: 'http://127.0.0.1:9/definitely-not-here.png', name: 'Logoless Store' },
      { where: { id: workspace.id } }
    );
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

    const buf = await waybillService.generateWaybillPdf(workspace.id, order.id);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('COD order model shows the amount to collect; a card order does not', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 20, price: 30000 });

    const cod = await placeOrder(auth.accessToken, workspace.id, variant.id, 'cod');
    const codModel = await waybillService.computeWaybillModel(workspace.id, cod.id);
    expect(codModel.isCod).toBe(true);
    expect(codModel.amountToCollect).toBe(String(cod.totalAmount));
    expect(Number(codModel.amountToCollect)).toBeGreaterThan(0);
    expect(codModel.trackingValue).toBe(cod.orderNumber); // no shipment tracking code yet
    expect(codModel.shipTo.fullName).toBe('Waybill Buyer');

    const card = await placeOrder(auth.accessToken, workspace.id, variant.id, 'card');
    const cardModel = await waybillService.computeWaybillModel(workspace.id, card.id);
    expect(cardModel.isCod).toBe(false);
    expect(cardModel.amountToCollect).toBeNull();
  });

  it('the amount to collect is what is still unpaid, the same figure a courier booking sends', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 20, price: 30000 });
    const cod = await placeOrder(auth.accessToken, workspace.id, variant.id, 'cod');
    await db.Order.update({ amountPaid: 10000 }, { where: { id: cod.id } });

    const model = await waybillService.computeWaybillModel(workspace.id, cod.id);
    expect(model.amountToCollect).toBe(String(Number(cod.totalAmount) - 10000));
  });

  it('is gated by workspace membership (404 cross-workspace)', async () => {
    const A = await setupWorkspaceWithProduct({ workspaceName: 'WB A', stock: 5 });
    const orderA = await placeOrder(A.auth.accessToken, A.workspace.id, A.variant.id);
    const B = await setupWorkspaceWithProduct({ workspaceName: 'WB B', stock: 5 });

    const res = await request(app)
      .get(`/api/v1/workspaces/${A.workspace.id}/orders/${orderA.id}/waybill`)
      .set(bearer(B.auth.accessToken));
    expect(res.status).toBe(404);
  });
});

describe('waybill PDF: Arabic text', () => {
  it('embeds the Arabic font for an Arabic name and address', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, 'cod', ARABIC);

    const pdf = await waybillService.generateWaybillPdf(workspace.id, order.id);
    expect(pdf.slice(0, 5).toString('latin1')).toBe('%PDF-');
    const fonts = embeddedFonts(pdf);
    expect(fonts).toContain('NotoSansArabic-Regular');
    expect(fonts).toContain('NotoSansArabic-Bold'); // the name is bold
    expect(pdf.toString('latin1')).toContain('/FontFile2');
    // The phone is Latin digits and stays in Helvetica.
    expect(latinText(pdf)).toContain('01012345678');
  });

  it('renders a mixed Arabic/English address and keeps it intact in the QR text', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, 'cod', MIXED);

    const pdf = await waybillService.generateWaybillPdf(workspace.id, order.id);
    expect(embeddedFonts(pdf)).toContain('NotoSansArabic-Regular');
    const text = latinText(pdf);
    expect(text).toContain('Kafr Elzayat');
    expect(text).toContain('Gharbia');
    expect(text).toContain('+20 101 234 5678');

    const model = await waybillService.computeWaybillModel(workspace.id, order.id);
    expect(model.qrPayload).toContain('Name: زياد Abbas');
    expect(model.qrPayload).toContain('Address: السلخانة, Kafr Elzayat, الغربية (Gharbia), EG');
  });

  it('an English-only order needs no Arabic font', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

    const pdf = await waybillService.generateWaybillPdf(workspace.id, order.id);
    expect(embeddedFonts(pdf).some((f) => f.startsWith('NotoSansArabic'))).toBe(false);
    const text = latinText(pdf);
    expect(text).toContain('Waybill Buyer');
    expect(text).toContain('7 Waybill St');
    // No shipment: no carrier block at all.
    expect(text).not.toContain('CARRIER');
  });
});

describe('waybill PDF: carrier tracking number', () => {
  async function ready(who) {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10, price: 25000 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, 'cod', who);
    return { workspace, order };
  }

  it('a manual shipment with a waybill number shows the courier and its number', async () => {
    const { workspace, order } = await ready();
    const ship = await addShipment(workspace.id, order, { carrierCode: 'Aramex', waybillNumber: 'ARX-99812' });

    const model = await waybillService.computeWaybillModel(workspace.id, order.id);
    expect(model.carrier).toEqual({ name: 'Aramex', trackingNumber: 'ARX-99812', booked: false });
    expect(model.trackingValue).toBe(ship.trackingCode);

    const text = latinText(await waybillService.generateWaybillPdf(workspace.id, order.id));
    expect(text).toContain('Aramex');
    expect(text).toContain('CARRIER TRACKING NO.');
    expect(text).toContain('ARX-99812');
    expect(text).toContain(ship.trackingCode);
    expect(text).not.toContain('own label');
  });

  it('a manual shipment without a waybill number shows the courier and no number label', async () => {
    const { workspace, order } = await ready();
    await addShipment(workspace.id, order, { carrierCode: 'manual' });

    const model = await waybillService.computeWaybillModel(workspace.id, order.id);
    expect(model.carrier).toEqual({ name: 'Manual', trackingNumber: null, booked: false });
    expect(model.qrPayload).toMatch(/^Carrier: Manual$/m);

    const text = latinText(await waybillService.generateWaybillPdf(workspace.id, order.id));
    expect(text).toContain('CARRIER');
    expect(text).toContain('Manual');
    expect(text).not.toContain('CARRIER TRACKING NO.');
  });

  it('a Bosta shipment shows Bosta\'s number, our zg code, and the print-their-label note', async () => {
    const { workspace, order } = await ready(ARABIC);
    const ship = await addShipment(workspace.id, order, { carrierCode: 'bosta', waybillNumber: '7234519', booked: true });

    const model = await waybillService.computeWaybillModel(workspace.id, order.id);
    expect(model.carrier).toEqual({ name: 'Bosta', trackingNumber: '7234519', booked: true });
    expect(model.trackingValue).toBe('7234519'); // the barcode still carries Bosta's number

    const pdf = await waybillService.generateWaybillPdf(workspace.id, order.id);
    expect(embeddedFonts(pdf)).toContain('NotoSansArabic-Regular');
    const text = latinText(pdf);
    expect(text).toContain('Bosta');
    expect(text).toContain('7234519');
    expect(text).toContain(ship.trackingCode);
    expect(text).toContain("The courier scans Bosta's own label");
  });

  it('ignores a cancelled shipment', async () => {
    const { workspace, order } = await ready();
    await addShipment(workspace.id, order, { carrierCode: 'Aramex', waybillNumber: 'OLD-1', status: 'cancelled' });

    const model = await waybillService.computeWaybillModel(workspace.id, order.id);
    expect(model.shipment).toBeNull();
    expect(model.carrier).toBeNull();
    expect(model.trackingValue).toBe(order.orderNumber);
    expect(latinText(await waybillService.generateWaybillPdf(workspace.id, order.id))).not.toContain('OLD-1');
  });
});

describe('waybill QR code', () => {
  it('carries every field, in UTF-8, and decodes back to the same text', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10, price: 25000 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, 'cod', ARABIC);
    const ship = await addShipment(workspace.id, order, { carrierCode: 'bosta', waybillNumber: '7234519', booked: true });
    const saved = await db.Order.findByPk(order.id);

    const { qrPayload } = await waybillService.computeWaybillModel(workspace.id, order.id);
    expect(qrPayload.split('\n')).toEqual([
      `Order: ${order.orderNumber}`,
      `Tracking: ${ship.trackingCode}`,
      'Carrier: Bosta 7234519',
      'Name: زياد عباس',
      'Phone: 01012345678',
      'Address: شارع التحرير، عمارة ١٥، شقة 7, كفر الزيات, الغربية, EG',
      `COD: ${(Number(saved.totalAmount) / 100).toFixed(2)} ${saved.currency}`,
      `Date: ${new Date(saved.createdAt).toISOString().slice(0, 10)}`,
    ]);

    const png = PNG.sync.read(await waybillService.qrPng(qrPayload));
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(decoded).not.toBeNull();
    expect(Buffer.from(decoded.binaryData).toString('utf8')).toBe(qrPayload);
  });

  it('leaves out what an order does not have and marks a prepaid order', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, 'card');

    const { qrPayload } = await waybillService.computeWaybillModel(workspace.id, order.id);
    expect(qrPayload).not.toMatch(/^Tracking:/m);
    expect(qrPayload).not.toMatch(/^Carrier:/m);
    expect(qrPayload).toMatch(/^COD: 0\.00 \w+ \(prepaid\)$/m);
    expect(qrPayload).toContain('Name: Waybill Buyer');
  });
});
