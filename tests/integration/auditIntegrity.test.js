'use strict';

// Two things:
//  (1) Audit logging: every new create / update / delete endpoint writes an
//      AuditLog row, with before/after state on updates and deletes.
//  (2) Order snapshot integrity: editing or archiving a product/variant/offer
//      after an order exists never changes that order's OrderItem snapshot.

const bwipjs = require('bwip-js');
const { app, request, setupWorkspaceWithProduct, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function placeOrder(token, workspaceId, variantId, phone = '01000012121', offerId) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `p12-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, ...(offerId ? { offerId } : {}), quantity: 2 }],
      contact: { fullName: 'Integrity Buyer', phone },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '12 Integrity St' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

const auditRow = (action, entityId) =>
  db.AuditLog.findOne({ where: { action, entityId: String(entityId) }, order: [['createdAt', 'DESC']] });

describe('audit logging on every new mutating endpoint', () => {
  it('catalog: delete product / update+delete offer / update+delete collection are all audited', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const H = bearer(auth.accessToken);
    const base = `/api/v1/workspaces/${workspace.id}/catalog`;

    const offer = (await request(app).post(`${base}/products/${product.id}/offers`).set(H)
      .send({ name: 'O', pricingMode: 'fixed', priceAmount: 1000, lines: [{ variantId: variant.id, quantity: 1 }] })).body.offer;
    await request(app).patch(`${base}/offers/${offer.id}`).set(H).send({ name: 'O2' }).expect(200);
    await request(app).delete(`${base}/offers/${offer.id}`).set(H).expect(200);

    const coll = (await request(app).post(`${base}/collections`).set(H).send({ name: 'C' })).body.collection;
    await request(app).post(`${base}/products/${product.id}/collections/${coll.id}`).set(H).expect(200);
    await request(app).patch(`${base}/collections/${coll.id}`).set(H).send({ name: 'C2' }).expect(200);
    await request(app).delete(`${base}/collections/${coll.id}`).set(H).expect(200);

    await request(app).delete(`${base}/products/${product.id}`).set(H).expect(200);

    const del = await auditRow('product.delete', product.id);
    expect(del).not.toBeNull();
    expect(del.beforeState).not.toBeNull();

    const offUpd = await auditRow('offer.update', offer.id);
    expect(offUpd.beforeState).not.toBeNull();
    expect(offUpd.afterState).not.toBeNull();
    expect(await auditRow('offer.delete', offer.id)).not.toBeNull();

    expect(await auditRow('collection.add_product', coll.id)).not.toBeNull();
    const colUpd = await auditRow('collection.update', coll.id);
    expect(colUpd.beforeState).not.toBeNull();
    expect(await auditRow('collection.delete', coll.id)).not.toBeNull();
  });

  it('domains / discounts / customers / team updates + deletes are audited with before/after', async () => {
    const auth = await registerAndActivate();
    const workspace = await createWorkspace(auth.accessToken, 'Audit Co');
    const H = bearer(auth.accessToken);

    // domain
    await request(app).post(`/api/v1/workspaces/${workspace.id}/quickstart`).set(H).type('form')
      .send({ productName: 'W', price: '10.00' });
    const dom = (await request(app).post(`/api/v1/workspaces/${workspace.id}/domains`).set(H).send({ hostname: 'audit-del.com' })).body.domain;
    await request(app).delete(`/api/v1/workspaces/${workspace.id}/domains/${dom.id}`).set(H).expect(200);
    const domDel = await auditRow('domain.delete', dom.id);
    expect(domDel.beforeState).not.toBeNull();

    // discount
    const disc = (await request(app).post(`/api/v1/workspaces/${workspace.id}/discounts`).set(H)
      .send({ code: 'AUD10', type: 'percentage', value: 1000 })).body.discount;
    await request(app).patch(`/api/v1/workspaces/${workspace.id}/discounts/${disc.id}`).set(H).send({ value: 1500 }).expect(200);
    await request(app).delete(`/api/v1/workspaces/${workspace.id}/discounts/${disc.id}`).set(H).expect(200);
    expect((await auditRow('discount.update', disc.id)).afterState).not.toBeNull();
    expect((await auditRow('discount.delete', disc.id)).beforeState).not.toBeNull();

    // team resend invite
    const role = await db.Role.findOne({ where: { workspaceId: workspace.id, key: 'order_operator' } });
    const inv = (await request(app).post(`/api/v1/workspaces/${workspace.id}/members`).set(H)
      .send({ email: 'audit-invite@example.com', roleId: role.id })).body.membership;
    await request(app).post(`/api/v1/workspaces/${workspace.id}/invites/${inv.id}/resend`).set(H).expect(200);
    expect(await auditRow('membership.invite_resend', inv.id)).not.toBeNull();
  });

  it('shipping / tax CRUD is audited', async () => {
    const auth = await registerAndActivate();
    const workspace = await createWorkspace(auth.accessToken, 'ShipTax Audit');
    const H = bearer(auth.accessToken);
    const s = `/api/v1/workspaces/${workspace.id}/shipping`;

    const zone = (await request(app).post(`${s}/zones`).set(H).send({ name: 'Z', countries: ['EG'] })).body.zone;
    await request(app).patch(`${s}/zones/${zone.id}`).set(H).send({ name: 'Z2' }).expect(200);
    const rate = (await request(app).post(`${s}/zones/${zone.id}/rates`).set(H).send({ name: 'R', rateType: 'flat', config: { amount: 100 } })).body.rate;
    await request(app).delete(`${s}/rates/${rate.id}`).set(H).expect(200);
    await request(app).delete(`${s}/zones/${zone.id}`).set(H).expect(200);
    expect(await auditRow('shipping_zone.create', zone.id)).not.toBeNull();
    expect((await auditRow('shipping_zone.update', zone.id)).afterState).not.toBeNull();
    expect(await auditRow('shipping_rate.create', rate.id)).not.toBeNull();
    expect(await auditRow('shipping_rate.delete', rate.id)).not.toBeNull();
    expect((await auditRow('shipping_zone.delete', zone.id)).beforeState).not.toBeNull();

    const t = `/api/v1/workspaces/${workspace.id}/tax-rates`;
    const tr = (await request(app).post(t).set(H).send({ name: 'VAT', rateBasisPoints: 1400 })).body.taxRate;
    await request(app).patch(`${t}/${tr.id}`).set(H).send({ rateBasisPoints: 1500 }).expect(200);
    await request(app).delete(`${t}/${tr.id}`).set(H).expect(200);
    expect(await auditRow('tax_rate.create', tr.id)).not.toBeNull();
    expect((await auditRow('tax_rate.update', tr.id)).afterState).not.toBeNull();
    expect((await auditRow('tax_rate.delete', tr.id)).beforeState).not.toBeNull();
  });

  it('orders (cancel / shipment) and returns are audited', async () => {
    const { auth, workspace, variant, product } = await setupWorkspaceWithProduct({ stock: 20 });
    const H = bearer(auth.accessToken);

    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await request(app).patch(`/api/v1/workspaces/${workspace.id}/orders/${order.id}`).set(H).send({ notes: 'x' }).expect(200);
    expect((await auditRow('order.update', order.id)).beforeState).not.toBeNull();

    const ship = (await request(app).post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments`).set(H).send({ carrierCode: 'bosta' })).body.shipment;
    expect(await auditRow('shipment.create', ship.id)).not.toBeNull();
    await request(app).patch(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments/${ship.id}`).set(H).send({ status: 'delivered' }).expect(200);
    expect((await auditRow('shipment.update', ship.id)).beforeState).not.toBeNull();

    // return on the delivered order
    const item = await db.OrderItem.findOne({ where: { orderId: order.id } });
    const ret = (await request(app).post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/returns`).set(H)
      .send({ reasonCode: 'damaged', items: [{ orderItemId: item.id, quantity: 1 }] })).body.return;
    expect(await auditRow('return.create', ret.id)).not.toBeNull();
    await request(app).patch(`/api/v1/workspaces/${workspace.id}/returns/${ret.id}`).set(H).send({ action: 'approve' }).expect(200);
    expect((await auditRow('return.approve', ret.id)).beforeState).not.toBeNull();
    await request(app).post(`/api/v1/workspaces/${workspace.id}/returns/${ret.id}/restock`).set(H).expect(200);
    expect(await auditRow('return.restock', ret.id)).not.toBeNull();

    // a second order we can cancel
    const order2 = await placeOrder(auth.accessToken, workspace.id, variant.id, '01000013131');
    await request(app).post(`/api/v1/workspaces/${workspace.id}/orders/${order2.id}/cancel`).set(H).send({ reason: 'audit' }).expect(200);
    expect((await auditRow('order.cancel', order2.id)).beforeState).not.toBeNull();

    // reviews
    await request(app).post(`/api/v1/store/${workspace.id}/products/${product.id}/reviews`)
      .send({ phone: '01000012121', rating: 5 }).expect(201);
    const review = await db.Review.findOne({ where: { workspaceId: workspace.id } });
    expect(await auditRow('review.submit', review.id)).not.toBeNull();
    await request(app).patch(`/api/v1/workspaces/${workspace.id}/reviews/${review.id}`).set(H).send({ action: 'approve' }).expect(200);
    expect((await auditRow('review.approve', review.id)).beforeState).not.toBeNull();
  });

  it('media upload is audited', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const png = await bwipjs.toBuffer({ bcid: 'code128', text: 'audit', scale: 1, height: 6 });
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/media`)
      .set(bearer(auth.accessToken))
      .attach('file', png, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    const row = await db.AuditLog.findOne({ where: { action: 'media.upload', workspaceId: workspace.id } });
    expect(row).not.toBeNull();
    expect(row.afterState).not.toBeNull();
  });
});

describe('order snapshot integrity', () => {
  it('editing or archiving a product/variant after an order never changes the OrderItem snapshot', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct({ price: 10000, sku: 'ORIG-SKU', stock: 20 });
    const H = bearer(auth.accessToken);
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

    const before = (await db.OrderItem.findOne({ where: { orderId: order.id } })).toJSON();
    expect(before.unitPriceAmount).toBe('10000');
    expect(before.skuSnapshot).toBe('ORIG-SKU');

    // mutate the live catalog every which way
    await request(app).patch(`/api/v1/workspaces/${workspace.id}/catalog/products/${product.id}`).set(H)
      .send({ name: 'COMPLETELY RENAMED', description: 'new copy' }).expect(200);
    await request(app).patch(`/api/v1/workspaces/${workspace.id}/catalog/variants/${variant.id}`).set(H)
      .send({ priceAmount: 999999, sku: 'CHANGED-SKU' }).expect(200);
    await request(app).delete(`/api/v1/workspaces/${workspace.id}/catalog/products/${product.id}`).set(H).expect(200);

    // live rows really did change
    expect((await db.Product.findByPk(product.id)).name).toBe('COMPLETELY RENAMED');
    expect((await db.Product.findByPk(product.id)).status).toBe('archived');
    expect(String((await db.ProductVariant.findByPk(variant.id)).priceAmount)).toBe('999999');

    // the order line snapshot is byte-for-byte unchanged
    const after = (await db.OrderItem.findOne({ where: { orderId: order.id } })).toJSON();
    expect(after.productNameSnapshot).toBe(before.productNameSnapshot);
    expect(after.productNameSnapshot).not.toBe('COMPLETELY RENAMED');
    expect(after.unitPriceAmount).toBe(before.unitPriceAmount);
    expect(after.unitPriceAmount).toBe('10000');
    expect(after.skuSnapshot).toBe('ORIG-SKU');
    expect(after.variantOptionsSnapshot).toEqual(before.variantOptionsSnapshot);
    expect(after.lineTotalAmount).toBe(before.lineTotalAmount);

    // and the API read of the order shows the frozen values too
    const read = await request(app).get(`/api/v1/workspaces/${workspace.id}/orders/${order.id}`).set(H);
    expect(read.body.order.items[0].productNameSnapshot).toBe(before.productNameSnapshot);
    expect(String(read.body.order.items[0].unitPriceAmount)).toBe('10000');
  });

  it('editing an offer after an order never changes the OrderItem offer snapshot', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct({ price: 5000, stock: 20 });
    const H = bearer(auth.accessToken);
    const offer = (await request(app).post(`/api/v1/workspaces/${workspace.id}/catalog/products/${product.id}/offers`).set(H)
      .send({ name: 'Launch Bundle', pricingMode: 'fixed', priceAmount: 8000, lines: [{ variantId: variant.id, quantity: 1 }] })).body.offer;

    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, '01000014141', offer.id);
    const before = (await db.OrderItem.findOne({ where: { orderId: order.id } })).toJSON();
    expect(before.offerNameSnapshot).toBe('Launch Bundle');
    expect(before.unitPriceAmount).toBe('8000');

    await request(app).patch(`/api/v1/workspaces/${workspace.id}/catalog/offers/${offer.id}`).set(H)
      .send({ name: 'Renamed Bundle', priceAmount: 1 }).expect(200);
    await request(app).delete(`/api/v1/workspaces/${workspace.id}/catalog/offers/${offer.id}`).set(H).expect(200);

    const after = (await db.OrderItem.findOne({ where: { orderId: order.id } })).toJSON();
    expect(after.offerNameSnapshot).toBe('Launch Bundle');
    expect(after.unitPriceAmount).toBe('8000');
  });
});
