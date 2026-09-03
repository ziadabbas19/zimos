'use strict';

// The order waybill PDF: the endpoint returns a real PDF, survives a broken
// logo URL, and the computed model shows the COD amount to collect for a COD
// order but not for a prepaid one.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const waybillService = require('../../src/modules/waybill/waybillService');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function placeOrder(token, workspaceId, variantId, paymentMethod = 'cod') {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `w-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: 2 }],
      contact: { fullName: 'Waybill Buyer', phone: '01000007777' },
      shippingAddress: { country: 'EG', province: 'Cairo', city: 'Cairo', addressLine: '7 Waybill St', postalCode: '11311' },
      paymentMethod,
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
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
