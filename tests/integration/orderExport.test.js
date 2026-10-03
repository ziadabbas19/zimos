'use strict';

// GET /orders/export and /orders/export/columns — the orders list as a CSV
// file: its own permission, contact columns only with
// customers.reveal_sensitive, spreadsheet-safe cells, one store's orders
// only, the row ceiling, paging across pages, and the audit entry.

const {
  app,
  request,
  registerAndActivate,
  createWorkspace,
  createProductWithVariant,
  addMemberWithRole,
} = require('../helpers/factories');
const db = require('../../src/db/models');
const { MAX_EXPORT_ROWS, PAGE_SIZE } = require('../../src/modules/orders/orderExportService');

const DAY_MS = 24 * 60 * 60 * 1000;
let phoneSeq = 5300000000;
const nextPhone = () => `01${String(++phoneSeq).slice(-9)}`;

async function setup(name = 'Export Store') {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, name);
  await db.Workspace.update({ timezone: 'UTC' }, { where: { id: workspace.id } });
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const { variant } = await createProductWithVariant(auth.accessToken, workspace.id, { price: 12550, stock: 500 });
  const placeOrder = async ({ fullName = 'Buyer', phone = nextPhone(), quantity = 1, notes } = {}) => {
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders`)
      .set(H)
      .set('Idempotency-Key', `exp-${Math.random().toString(36).slice(2)}`)
      .send({
        items: [{ variantId: variant.id, quantity }],
        contact: { fullName, phone, email: 'buyer@example.com' },
        shippingAddress: { country: 'EG', province: 'Cairo', city: 'Nasr City', addressLine: '5 Export St, Block 2' },
        paymentMethod: 'cod',
        ...(notes ? { notes } : {}),
      });
    if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.order;
  };
  const exportCsv = (query = {}, token = auth.accessToken, wid = workspace.id) =>
    request(app)
      .get(`/api/v1/workspaces/${wid}/orders/export`)
      .set({ Authorization: `Bearer ${token}` })
      .query(query)
      .buffer(true)
      .parse((res, done) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => done(null, text));
      });
  const catalogue = (token = auth.accessToken) =>
    request(app).get(`/api/v1/workspaces/${workspace.id}/orders/export/columns`).set({ Authorization: `Bearer ${token}` });
  return { auth, workspace, H, placeOrder, exportCsv, catalogue };
}

/** A role made in the store's role editor, with exactly these permissions. */
async function memberWithPermissions(ctx, permissions, key) {
  const role = await request(app)
    .post(`/api/v1/workspaces/${ctx.workspace.id}/roles`)
    .set(ctx.H)
    .send({ name: `Role ${key}`, key, permissions });
  if (role.status !== 201) throw new Error(`role failed: ${role.status} ${JSON.stringify(role.body)}`);
  const member = await registerAndActivate({ fullName: key });
  const invite = await request(app)
    .post(`/api/v1/workspaces/${ctx.workspace.id}/members`)
    .set(ctx.H)
    .send({ email: member.email, roleId: role.body.role.id });
  if (invite.status !== 201) throw new Error(`invite failed: ${invite.status} ${JSON.stringify(invite.body)}`);
  return member;
}

/** Minimal CSV reader for the assertions: quoted fields, doubled quotes, CRLF rows. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else field += ch;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

/** Inserts `n` COD orders straight into the table (bulk data for the paging and ceiling tests). */
async function bulkOrders(workspaceId, n, { createdAt = new Date() } = {}) {
  const [[customer]] = await db.sequelize.query(
    `INSERT INTO customers (id, workspace_id, phone_normalized, phone_raw, full_name)
     VALUES (gen_random_uuid(), :workspaceId, :phone, :phone, 'Bulk Buyer') RETURNING id`,
    { replacements: { workspaceId, phone: `20${Date.now()}`.slice(0, 13) } }
  );
  await db.sequelize.query(
    `INSERT INTO orders (id, workspace_id, customer_id, order_number, payment_method, currency,
                         subtotal_amount, total_amount, contact_snapshot, created_at, updated_at)
     SELECT gen_random_uuid(), :workspaceId, :customerId, 'BULK-' || lpad(g::text, 6, '0'), 'cod', 'EGP',
            1000, 1000, jsonb_build_object('fullName', 'Bulk ' || g, 'phone', '01000' || lpad(g::text, 6, '0')),
            :createdAt, :createdAt
       FROM generate_series(1, :n) g`,
    { replacements: { workspaceId, customerId: customer.id, n, createdAt } }
  );
}

describe('GET /orders/export — the file', () => {
  it('writes the orders the list shows, with a BOM, labels and the store clock', async () => {
    const ctx = await setup();
    const first = await ctx.placeOrder({ fullName: 'Mona Adel', quantity: 2, notes: 'Ring before, please' });
    const second = await ctx.placeOrder({ fullName: 'Karim "K" Said' });

    const res = await ctx.exportCsv();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="orders-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-export-rows']).toBe('2');
    expect(res.body.startsWith('﻿')).toBe(true);

    const [header, ...rows] = parseCsv(res.body.slice(1));
    expect(header).toEqual([
      'Order number', 'Date', 'Stage', 'Customer', 'Phone', 'Governorate', 'City', 'Address', 'Products', 'Items',
      'Payment method', 'Subtotal', 'Discount', 'Shipping', 'Total', 'Currency', 'Courier', 'Waybill', 'Notes',
    ]);
    expect(rows).toHaveLength(2);
    // Newest first, as on the list.
    const [newest, oldest] = rows;
    expect(newest[0]).toBe(second.orderNumber);
    expect(newest[3]).toBe('Karim "K" Said');
    expect(oldest[0]).toBe(first.orderNumber);
    expect(oldest[2]).toBe('New');
    expect(oldest[4]).toBe(first.contactSnapshot.phone);
    expect(oldest[7]).toBe('5 Export St, Block 2');
    expect(oldest[8]).toBe('2 x Test Product');
    expect(oldest[9]).toBe('2');
    expect(oldest[10]).toBe('Cash on delivery');
    expect(oldest[11]).toBe('251.00');
    expect(oldest[18]).toBe('Ring before, please');
    // UTC store: the date is the order's own instant, to the second.
    expect(oldest[1]).toBe(new Date(first.createdAt).toISOString().slice(0, 19).replace('T', ' '));
  });

  it('writes Arabic headers and labels, and one row per line on request', async () => {
    const ctx = await setup();
    await ctx.placeOrder({ quantity: 3 });
    const res = await ctx.exportCsv({ lang: 'ar', rowPer: 'item', columns: 'orderNumber,stage,productName,quantity,unitPrice,lineTotal' });
    expect(res.status).toBe(200);
    const [header, row] = parseCsv(res.body.slice(1));
    expect(header).toEqual(['رقم الطلب', 'المرحلة', 'المنتج', 'الكمية', 'سعر القطعة', 'إجمالي السطر']);
    expect(row.slice(1)).toEqual(['جديد', 'Test Product', '3', '125.50', '376.50']);
  });

  it('writes a cell a spreadsheet would run as a formula as text', async () => {
    const ctx = await setup();
    await ctx.placeOrder({ fullName: '=HYPERLINK("http://evil.test","Click")' });
    await ctx.placeOrder({ fullName: '+cmd|calc' });
    await ctx.placeOrder({ fullName: '-2+3' });
    await ctx.placeOrder({ fullName: '@SUM(A1)' });
    const res = await ctx.exportCsv({ columns: 'customerName', sort: 'oldest' });
    const names = parseCsv(res.body.slice(1))
      .slice(1)
      .map((r) => r[0]);
    expect(names).toEqual(["'=HYPERLINK(\"http://evil.test\",\"Click\")", "'+cmd|calc", "'-2+3", "'@SUM(A1)"]);
    // Raw: the formula cell is quoted (it holds quotes and a comma) and starts with the apostrophe.
    expect(res.body).toContain('"\'=HYPERLINK(""http://evil.test"",""Click"")"');
  });

  it('applies the list filters: stage, dates and search', async () => {
    const ctx = await setup();
    const keep = await ctx.placeOrder({ fullName: 'Searchable Person' });
    const cancelled = await ctx.placeOrder();
    await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${cancelled.id}/cancel`)
      .set(ctx.H)
      .send({ reason: 'Duplicate' });

    const stage = parseCsv((await ctx.exportCsv({ stage: 'cancelled', columns: 'orderNumber' })).body.slice(1));
    expect(stage.slice(1)).toEqual([[cancelled.orderNumber]]);

    const search = parseCsv((await ctx.exportCsv({ q: 'searchable', columns: 'orderNumber' })).body.slice(1));
    expect(search.slice(1)).toEqual([[keep.orderNumber]]);

    const yesterday = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
    const none = await ctx.exportCsv({ from: yesterday, to: yesterday, columns: 'orderNumber' });
    expect(none.headers['x-export-rows']).toBe('0');
    expect(parseCsv(none.body.slice(1))).toEqual([['Order number']]);
  });

  it('pages through more than one page without losing or repeating an order', async () => {
    const ctx = await setup();
    // Every row on the same instant: only the id orders them.
    await bulkOrders(ctx.workspace.id, PAGE_SIZE * 2 + 7, { createdAt: new Date(Date.now() - 60 * 1000) });
    const res = await ctx.exportCsv({ columns: 'orderNumber' });
    expect(res.status).toBe(200);
    const numbers = parseCsv(res.body.slice(1))
      .slice(1)
      .map((r) => r[0]);
    expect(numbers).toHaveLength(PAGE_SIZE * 2 + 7);
    expect(new Set(numbers).size).toBe(PAGE_SIZE * 2 + 7);
  });
});

describe('GET /orders/export — limits', () => {
  it(`refuses more than ${MAX_EXPORT_ROWS} rows before writing anything`, async () => {
    const ctx = await setup();
    await bulkOrders(ctx.workspace.id, MAX_EXPORT_ROWS + 1);
    const res = await ctx.exportCsv();
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).error).toMatchObject({
      code: 'EXPORT_TOO_LARGE',
      details: { rows: MAX_EXPORT_ROWS + 1, maxRows: MAX_EXPORT_ROWS },
    });
  });

  it('refuses a date range longer than 366 days, and unknown columns', async () => {
    const ctx = await setup();
    const long = await ctx.exportCsv({ from: '2024-01-01', to: '2025-06-30' });
    expect(long.status).toBe(422);
    const unknown = await ctx.exportCsv({ columns: 'orderNumber,passwordHash' });
    expect(unknown.status).toBe(422);
    const paging = await ctx.exportCsv({ limit: 5 });
    expect(paging.status).toBe(422);
  });
});

describe('GET /orders/export — who may export what', () => {
  it('needs orders.export: the system roles without it are refused', async () => {
    const ctx = await setup();
    await ctx.placeOrder();
    for (const roleKey of ['workspace_manager', 'order_operator', 'confirmation_agent', 'accountant', 'editor']) {
      const member = await addMemberWithRole(ctx.auth.accessToken, ctx.workspace.id, roleKey, roleKey);
      const file = await ctx.exportCsv({}, member.accessToken);
      expect([roleKey, file.status]).toEqual([roleKey, 403]);
      expect([roleKey, (await ctx.catalogue(member.accessToken)).status]).toEqual([roleKey, 403]);
    }
  });

  it('leaves the contact columns out without customers.reveal_sensitive, and refuses them by name', async () => {
    const ctx = await setup();
    const order = await ctx.placeOrder();
    const exporter = await memberWithPermissions(ctx, ['orders.view', 'orders.export'], 'exporter');

    const cat = await ctx.catalogue(exporter.accessToken);
    expect(cat.status).toBe(200);
    expect(cat.body.canRevealSensitive).toBe(false);
    expect(cat.body.defaults.order).not.toContain('phone');
    expect(cat.body.columns.find((c) => c.key === 'phone')).toMatchObject({ sensitive: true, available: false });
    expect(cat.body.maxRows).toBe(MAX_EXPORT_ROWS);

    const file = await ctx.exportCsv({}, exporter.accessToken);
    expect(file.status).toBe(200);
    const [header, row] = parseCsv(file.body.slice(1));
    expect(header).not.toContain('Phone');
    expect(file.body).not.toContain(order.contactSnapshot.phone);
    expect(row[0]).toBe(order.orderNumber);

    for (const columns of ['orderNumber,phone', 'email', 'alternatePhone']) {
      const refused = await ctx.exportCsv({ columns }, exporter.accessToken);
      expect([columns, refused.status]).toEqual([columns, 403]);
    }

    const revealer = await memberWithPermissions(ctx, ['orders.view', 'orders.export', 'customers.reveal_sensitive'], 'revealer');
    const full = await ctx.exportCsv({ columns: 'orderNumber,phone,email' }, revealer.accessToken);
    expect(full.status).toBe(200);
    expect(parseCsv(full.body.slice(1))[1]).toEqual([order.orderNumber, order.contactSnapshot.phone, 'buyer@example.com']);
  });

  it('needs orders.view as well as orders.export', async () => {
    const ctx = await setup();
    const exportOnly = await memberWithPermissions(ctx, ['orders.export'], 'export_only');
    expect((await ctx.exportCsv({}, exportOnly.accessToken)).status).toBe(403);
  });

  it("only ever contains the store's own orders, and refuses a non-member", async () => {
    const a = await setup('Store A');
    const b = await setup('Store B');
    const mine = await a.placeOrder();
    const theirs = await b.placeOrder();
    const res = await a.exportCsv({ columns: 'orderNumber' });
    const numbers = parseCsv(res.body.slice(1))
      .slice(1)
      .map((r) => r[0]);
    expect(numbers).toEqual([mine.orderNumber]);
    expect(res.body).not.toContain(theirs.orderNumber);

    const cross = await a.exportCsv({}, a.auth.accessToken, b.workspace.id);
    expect(cross.status).toBe(404);
  });

  it('records each export in the audit log, without the search text', async () => {
    const ctx = await setup();
    await ctx.placeOrder({ fullName: 'Audit Person' });
    const res = await ctx.exportCsv({ q: 'Audit Person', columns: 'orderNumber,phone' });
    expect(res.status).toBe(200);
    const entry = await db.AuditLog.findOne({ where: { workspaceId: ctx.workspace.id, action: 'order.export' } });
    expect(entry).not.toBeNull();
    expect(entry.actorUserId).toBe(ctx.auth.userId);
    expect(entry.metadata).toMatchObject({
      rows: 1,
      rowPer: 'order',
      columns: ['orderNumber', 'phone'],
      contactColumns: ['phone'],
      filters: { search: true },
    });
    expect(JSON.stringify(entry.metadata)).not.toContain('Audit Person');
  });
});
