'use strict';

// The accepted-orders export (orders/orderExportService.js preset
// "accepted"): only accepted orders (confirmed COD, paid online; not
// cancelled), fixed columns, UTF-8 with a BOM, a value that would run as a
// formula escaped in the CSV and kept as text in the XLSX, the store's own
// orders only, the teammate's permissions and phone masking, and a direct
// download only for a short range — larger ones in the background.

const zlib = require('zlib');
const { app, request, setupWorkspaceWithProduct, confirmCodOrder, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const orderService = require('../../src/modules/orders/orderService');
const exportFiles = require('../../src/modules/orders/exportFiles');
const { parseXlsx } = require('../../src/modules/catalog/importExport/sheetReader');
const { parseCsv } = require('../../src/modules/catalog/importExport/sheetReader');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
let seq = 0;

async function store() {
  const ctx = await setupWorkspaceWithProduct({ price: 10000, stock: 100 });
  ctx.H = bearer(ctx.auth.accessToken);
  ctx.ws = ctx.workspace.id;
  return ctx;
}

async function placeOrder(ctx, { fullName = 'Plain Buyer', addressLine = '1 Tahrir Sq', paymentMethod = 'cod' } = {}) {
  seq += 1;
  const res = await request(app)
    .post(`/api/v1/workspaces/${ctx.ws}/orders`)
    .set(ctx.H)
    .set('Idempotency-Key', `exp-${Date.now()}-${seq}`)
    .send({
      items: [{ variantId: ctx.variant.id, quantity: 2 }],
      contact: { fullName, phone: `0102${String(1000000 + seq).padStart(7, '0')}` },
      shippingAddress: { country: 'EG', province: 'Cairo', city: 'Nasr City', addressLine },
      paymentMethod,
    });
  if (res.status !== 201) throw new Error(`order ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

const today = () => new Date().toISOString().slice(0, 10);
const exportUrl = (ctx, query) => `/api/v1/workspaces/${ctx.ws}/orders/export?preset=accepted&from=${today()}&to=${today()}${query || ''}`;

/** The XML of one file inside an .xlsx (a zip of deflated entries). */
function xlsxEntry(buffer, name) {
  let at = 0;
  while (at < buffer.length - 30 && buffer.readUInt32LE(at) === 0x04034b50) {
    const size = buffer.readUInt32LE(at + 18);
    const nameLength = buffer.readUInt16LE(at + 26);
    const extra = buffer.readUInt16LE(at + 28);
    const entry = buffer.slice(at + 30, at + 30 + nameLength).toString();
    const start = at + 30 + nameLength + extra;
    if (entry === name) return zlib.inflateRawSync(buffer.slice(start, start + size)).toString('utf8');
    at = start + size;
  }
  return null;
}

const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('accepted orders export', () => {
  it('CSV: a BOM, the fixed columns, accepted orders only, and formulas escaped', async () => {
    const ctx = await store();
    const evil = await placeOrder(ctx, { fullName: '=HYPERLINK("http://evil.example","click")' });
    const plus = await placeOrder(ctx, { fullName: '+cmd|/C calc!A0' });
    const minus = await placeOrder(ctx, { fullName: '-2+3' });
    const at = await placeOrder(ctx, { fullName: '@SUM(1+1)*cmd' });
    const pending = await placeOrder(ctx, { fullName: 'Not Confirmed Yet' });
    const cancelled = await placeOrder(ctx, { fullName: 'Confirmed Then Cancelled' });
    const online = await placeOrder(ctx, { fullName: 'Paid Online', paymentMethod: 'card' });
    for (const o of [evil, plus, minus, at, cancelled]) await confirmCodOrder(ctx.auth.accessToken, ctx.ws, o.id);
    await request(app).post(`/api/v1/workspaces/${ctx.ws}/orders/${cancelled.id}/cancel`).set(ctx.H).send({ reason: 'Customer changed their mind' });
    await db.Order.update({ financialState: 'paid', amountPaid: 20000, completedAt: new Date() }, { where: { id: online.id } });

    const res = await request(app).get(exportUrl(ctx, '&format=csv&lang=en')).set(ctx.H).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toMatch(/orders-accepted-/);
    const text = res.body.toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);

    const rows = parseCsv(res.body);
    expect(rows[0]).toEqual(['Order number', 'Date', 'Customer', 'Phone', 'Full address', 'Products, options and prices', 'Shipping', 'Discount', 'Total', 'Currency', 'Payment method', 'Payment state']);
    const numbers = rows.slice(1).map((r) => r[0]).sort();
    expect(numbers).toEqual([evil.orderNumber, plus.orderNumber, minus.orderNumber, at.orderNumber, online.orderNumber].sort());
    expect(text).not.toContain('Not Confirmed Yet');
    expect(text).not.toContain('Confirmed Then Cancelled');

    // Every cell that would run as a formula starts with an apostrophe.
    expect(text).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    expect(text).toContain("'-2+3");
    expect(text).toContain("'@SUM(1+1)*cmd");
    expect(text).toContain("'+cmd|/C calc!A0");
    // The customer column, where a shopper types anything: no cell there starts a formula.
    for (const row of rows.slice(1)) expect(row[2]).not.toMatch(/^[=+\-@]/);
    // Lines with quantities and prices.
    expect(text).toMatch(/2 x [^|]+ = 200\.00/);
  });

  it('XLSX: the same rows, Arabic headers, and every text a text cell — never a formula', async () => {
    const ctx = await store();
    const evil = await placeOrder(ctx, { fullName: '=1+1' });
    await confirmCodOrder(ctx.auth.accessToken, ctx.ws, evil.id);
    const res = await request(app).get(exportUrl(ctx, '&format=xlsx&lang=ar')).set(ctx.H).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const rows = parseXlsx(res.body);
    expect(rows[0][0]).toBe('رقم الطلب');
    expect(rows[1][2]).toBe('=1+1');
    const sheet = xlsxEntry(res.body, 'xl/worksheets/sheet1.xml');
    expect(sheet).toBeTruthy();
    expect(sheet).not.toMatch(/<f[ >]/);
    expect(sheet).toContain('t="inlineStr"');
  });

  it("only the store's own orders, and only for a teammate who may see orders; phones masked without the reveal permission", async () => {
    const a = await store();
    const b = await store();
    const mine = await placeOrder(a, { fullName: 'Store A Buyer' });
    const theirs = await placeOrder(b, { fullName: 'Store B Buyer' });
    await confirmCodOrder(a.auth.accessToken, a.ws, mine.id);
    await confirmCodOrder(b.auth.accessToken, b.ws, theirs.id);

    const own = await request(app).get(exportUrl(a, '&format=csv')).set(a.H).buffer(true).parse(binary);
    expect(own.body.toString()).toContain('Store A Buyer');
    expect(own.body.toString()).not.toContain('Store B Buyer');
    // B's owner asking for A's store is refused before anything is read.
    const foreign = await request(app).get(exportUrl(a, '&format=csv')).set(b.H);
    expect([403, 404]).toContain(foreign.status);

    const editor = await addMemberWithRole(a.auth.accessToken, a.ws, 'editor', 'No Orders');
    expect((await request(app).get(exportUrl(a, '&format=csv')).set(bearer(editor.accessToken))).status).toBe(403);

    const agent = await addMemberWithRole(a.auth.accessToken, a.ws, 'confirmation_agent', 'Agent');
    const masked = await request(app).get(exportUrl(a, '&format=csv')).set(bearer(agent.accessToken)).buffer(true).parse(binary);
    expect(masked.status).toBe(200);
    const phone = parseCsv(masked.body)[1][3];
    expect(phone).toMatch(/\*/);
  });

  it('downloads directly only a short range; larger ones are refused with 413 and prepared in the background', async () => {
    const ctx = await store();
    const order = await placeOrder(ctx, { fullName: 'Background Buyer' });
    await confirmCodOrder(ctx.auth.accessToken, ctx.ws, order.id);

    const long = await request(app).get(`/api/v1/workspaces/${ctx.ws}/orders/export?preset=accepted&format=csv&from=2026-01-01&to=${today()}`).set(ctx.H);
    expect(long.status).toBe(413);
    expect(long.body.error).toMatchObject({ code: 'EXPORT_TOO_LARGE', details: { reason: 'range', maxDays: 31 } });
    const open = await request(app).get(`/api/v1/workspaces/${ctx.ws}/orders/export?preset=accepted&format=csv`).set(ctx.H);
    expect(open.status).toBe(413);

    const spy = jest.spyOn(orderService, 'countOrders').mockResolvedValueOnce(2001);
    const many = await request(app).get(exportUrl(ctx, '&format=csv')).set(ctx.H);
    spy.mockRestore();
    expect(many.status).toBe(413);
    expect(many.body.error.details).toMatchObject({ reason: 'rows', count: 2001, maxOrders: 2000 });

    // A preset fixes its columns: asking for others is refused.
    expect((await request(app).get(exportUrl(ctx, '&format=csv&columns=email')).set(ctx.H)).status).toBe(422);

    const started = await request(app).post(`/api/v1/workspaces/${ctx.ws}/exports/orders`).set(ctx.H).send({ preset: 'accepted', format: 'csv', lang: 'en', from: '2026-01-01', to: today() });
    expect(started.status).toBe(202);
    expect(started.body.export.fileName).toMatch(/^orders-accepted-/);
    await exportFiles.processExport({ payload: { exportId: started.body.export.id } });
    const row = await db.ExportFile.findByPk(started.body.export.id);
    expect(row.status).toBe('done');
    expect(row.params).toMatchObject({ preset: 'accepted', filters: { accepted: true }, rowPer: 'order' });
    const file = await exportFiles.readExport(ctx.ws, row.userId, row.id);
    const csv = file.buffer.toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Background Buyer');
  });

  it('the custom export is unchanged: no preset, the columns asked for', async () => {
    const ctx = await store();
    const order = await placeOrder(ctx, { fullName: 'Custom Buyer' });
    const res = await request(app).get(`/api/v1/workspaces/${ctx.ws}/orders/export?format=csv&columns=orderNumber,customerName`).set(ctx.H).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/filename="orders-\d/);
    const rows = parseCsv(res.body);
    expect(rows[0]).toEqual(['Order number', 'Customer']);
    // Not confirmed, still exported: the custom export has no accepted filter.
    expect(rows[1]).toEqual([order.orderNumber, 'Custom Buyer']);
  });
});
