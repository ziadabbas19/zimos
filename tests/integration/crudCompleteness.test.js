'use strict';

// CRUD completeness across catalog, domains, team, discounts, shipping, tax
// and customers. Each area checks: a happy-path update and delete work;
// DELETE soft-deletes (archives) when order/financial history could reference
// the row, or hard-deletes when nothing does; cross-workspace access 404s.

const { app, request, registerAndActivate, createWorkspace, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function placeOrder(token, workspaceId, variantId) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `ord-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: 1 }],
      contact: { fullName: 'Snapshot Buyer', phone: '01000000001' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

describe('catalog CRUD', () => {
  it('archives a product (and its variants/offers) on DELETE, leaving order snapshots untouched', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct({ price: 12345 });
    const H = bearer(auth.accessToken);

    // An offer on the product, so we can prove it archives too.
    const offerRes = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/catalog/products/${product.id}/offers`)
      .set(H)
      .send({ name: 'Single', pricingMode: 'fixed', priceAmount: 12345, lines: [{ variantId: variant.id, quantity: 1 }] });
    expect(offerRes.status).toBe(201);

    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    const itemBefore = await db.OrderItem.findOne({ where: { orderId: order.id } });

    const del = await request(app)
      .delete(`/api/v1/workspaces/${workspace.id}/catalog/products/${product.id}`)
      .set(H);
    expect(del.status).toBe(200);
    expect(del.body.archived).toBe(true);

    expect((await db.Product.findByPk(product.id)).status).toBe('archived');
    expect((await db.ProductVariant.findByPk(variant.id)).status).toBe('archived');
    expect((await db.Offer.findByPk(offerRes.body.offer.id)).status).toBe('archived');

    // The row is archived, not gone, and the order line snapshot is identical.
    const itemAfter = await db.OrderItem.findOne({ where: { orderId: order.id } });
    expect(itemAfter.productNameSnapshot).toBe(itemBefore.productNameSnapshot);
    expect(String(itemAfter.unitPriceAmount)).toBe(String(itemBefore.unitPriceAmount));
    expect(itemAfter.skuSnapshot).toBe(itemBefore.skuSnapshot);
  });

  it('GET, PATCH and DELETE a single variant; DELETE archives it', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const H = bearer(auth.accessToken);

    const get = await request(app).get(`/api/v1/workspaces/${workspace.id}/catalog/variants/${variant.id}`).set(H);
    expect(get.status).toBe(200);
    expect(get.body.variant.id).toBe(variant.id);

    const patch = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/catalog/variants/${variant.id}`)
      .set(H)
      .send({ priceAmount: 999 });
    expect(patch.status).toBe(200);
    expect(String(patch.body.variant.priceAmount)).toBe('999');

    const del = await request(app).delete(`/api/v1/workspaces/${workspace.id}/catalog/variants/${variant.id}`).set(H);
    expect(del.status).toBe(200);
    expect((await db.ProductVariant.findByPk(variant.id)).status).toBe('archived');
  });

  it('lists, gets, updates and archives offers', async () => {
    const { auth, workspace, product, variant } = await setupWorkspaceWithProduct();
    const H = bearer(auth.accessToken);

    const created = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/catalog/products/${product.id}/offers`)
      .set(H)
      .send({ name: 'Pair', pricingMode: 'fixed', priceAmount: 5000, lines: [{ variantId: variant.id, quantity: 2 }] });
    expect(created.status).toBe(201);
    const offerId = created.body.offer.id;

    const list = await request(app)
      .get(`/api/v1/workspaces/${workspace.id}/catalog/products/${product.id}/offers`)
      .set(H);
    expect(list.status).toBe(200);
    expect(list.body.offers).toHaveLength(1);

    const patch = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/catalog/offers/${offerId}`)
      .set(H)
      .send({ name: 'Pair Deal', priceAmount: 4500, lines: [{ variantId: variant.id, quantity: 3 }] });
    expect(patch.status).toBe(200);
    expect(patch.body.offer.name).toBe('Pair Deal');
    expect(patch.body.offer.lines[0].quantity).toBe(3);

    const del = await request(app).delete(`/api/v1/workspaces/${workspace.id}/catalog/offers/${offerId}`).set(H);
    expect(del.status).toBe(200);
    expect((await db.Offer.findByPk(offerId)).status).toBe('archived');
  });

  it('lists, gets, updates and hard-deletes a collection (nothing in order history points at it)', async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const H = bearer(auth.accessToken);

    const created = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/catalog/collections`)
      .set(H)
      .send({ name: 'Summer' });
    const collectionId = created.body.collection.id;

    await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/catalog/products/${product.id}/collections/${collectionId}`)
      .set(H)
      .expect(200);

    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/catalog/collections`).set(H);
    expect(list.status).toBe(200);
    expect(list.body.collections).toHaveLength(1);

    const get = await request(app).get(`/api/v1/workspaces/${workspace.id}/catalog/collections/${collectionId}`).set(H);
    expect(get.body.collection.products).toHaveLength(1);

    const patch = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/catalog/collections/${collectionId}`)
      .set(H)
      .send({ name: 'Summer 2026' });
    expect(patch.status).toBe(200);
    expect(patch.body.collection.name).toBe('Summer 2026');

    // remove a product from the collection
    await request(app)
      .delete(`/api/v1/workspaces/${workspace.id}/catalog/products/${product.id}/collections/${collectionId}`)
      .set(H)
      .expect(200);
    expect(await db.ProductCollection.count({ where: { collectionId } })).toBe(0);

    const del = await request(app).delete(`/api/v1/workspaces/${workspace.id}/catalog/collections/${collectionId}`).set(H);
    expect(del.status).toBe(200);
    expect(await db.Collection.findByPk(collectionId)).toBeNull();
  });
});

describe('domains DELETE', () => {
  it('hard-deletes a custom domain (host routing config only)', async () => {
    const auth = await registerAndActivate();
    const workspace = await createWorkspace(auth.accessToken, 'Domain Del Co');
    const H = bearer(auth.accessToken);
    await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/quickstart`)
      .set(H)
      .type('form')
      .send({ productName: 'Widget', price: '10.00' });

    const add = await request(app).post(`/api/v1/workspaces/${workspace.id}/domains`).set(H).send({ hostname: 'delme.com' });
    expect(add.status).toBe(201);
    const domainId = add.body.domain.id;

    const del = await request(app).delete(`/api/v1/workspaces/${workspace.id}/domains/${domainId}`).set(H);
    expect(del.status).toBe(200);
    expect(await db.Domain.findByPk(domainId)).toBeNull();
  });
});

describe('team members / invites', () => {
  it('lists members, lists pending invites and resends an invite', async () => {
    const owner = await registerAndActivate({ fullName: 'Team Owner' });
    const workspace = await createWorkspace(owner.accessToken, 'Team Co');
    const H = bearer(owner.accessToken);

    const role = await db.Role.findOne({ where: { workspaceId: workspace.id, key: 'order_operator' } });

    const invite = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/members`)
      .set(H)
      .send({ email: 'pending@example.com', roleId: role.id });
    expect(invite.status).toBe(201);

    const members = await request(app).get(`/api/v1/workspaces/${workspace.id}/members`).set(H);
    expect(members.status).toBe(200);
    expect(members.body.members.length).toBe(2); // owner + pending invite

    const invites = await request(app).get(`/api/v1/workspaces/${workspace.id}/invites`).set(H);
    expect(invites.status).toBe(200);
    expect(invites.body.invites).toHaveLength(1);
    expect(invites.body.invites[0].invitedEmail).toBe('pending@example.com');

    const resend = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/invites/${invites.body.invites[0].id}/resend`)
      .set(H);
    expect(resend.status).toBe(200);
    expect(resend.body.resent).toBe(true);

    // an invite email was queued through the notification layer (console provider in tests)
    const logs = await db.NotificationLog.count({ where: { workspaceId: workspace.id, template: 'workspace_invite' } });
    expect(logs).toBeGreaterThanOrEqual(2);
  });
});

describe('discounts CRUD', () => {
  it('gets one, updates, and archives a discount on DELETE (redemptions are financial history)', async () => {
    const auth = await registerAndActivate();
    const workspace = await createWorkspace(auth.accessToken, 'Disc Co');
    const H = bearer(auth.accessToken);

    const created = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/discounts`)
      .set(H)
      .send({ code: 'SAVE10', type: 'percentage', value: 1000 });
    expect(created.status).toBe(201);
    const id = created.body.discount.id;

    const get = await request(app).get(`/api/v1/workspaces/${workspace.id}/discounts/${id}`).set(H);
    expect(get.status).toBe(200);
    expect(get.body.discount.code).toBe('SAVE10');

    const patch = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/discounts/${id}`)
      .set(H)
      .send({ value: 1500, minimumSubtotal: 20000 });
    expect(patch.status).toBe(200);
    expect(String(patch.body.discount.value)).toBe('1500');

    const del = await request(app).delete(`/api/v1/workspaces/${workspace.id}/discounts/${id}`).set(H);
    expect(del.status).toBe(200);
    expect((await db.Discount.findByPk(id)).status).toBe('archived');
  });
});

describe('shipping zones & rates CRUD', () => {
  it('full CRUD on zones and rates; deleting a zone cascades its rates', async () => {
    const auth = await registerAndActivate();
    const workspace = await createWorkspace(auth.accessToken, 'Ship Co');
    const H = bearer(auth.accessToken);
    const base = `/api/v1/workspaces/${workspace.id}/shipping`;

    const zone = await request(app).post(`${base}/zones`).set(H).send({ name: 'Cairo', countries: ['EG'] });
    expect(zone.status).toBe(201);
    const zoneId = zone.body.zone.id;

    expect((await request(app).get(`${base}/zones`).set(H)).body.zones).toHaveLength(1);
    expect((await request(app).get(`${base}/zones/${zoneId}`).set(H)).status).toBe(200);

    const zonePatch = await request(app).patch(`${base}/zones/${zoneId}`).set(H).send({ name: 'Greater Cairo' });
    expect(zonePatch.body.zone.name).toBe('Greater Cairo');

    const rate = await request(app)
      .post(`${base}/zones/${zoneId}/rates`)
      .set(H)
      .send({ name: 'Standard', rateType: 'flat', config: { amount: 5000 } });
    expect(rate.status).toBe(201);
    const rateId = rate.body.rate.id;

    expect((await request(app).get(`${base}/zones/${zoneId}/rates`).set(H)).body.rates).toHaveLength(1);
    const ratePatch = await request(app).patch(`${base}/rates/${rateId}`).set(H).send({ config: { amount: 7500 } });
    expect(ratePatch.body.rate.config.amount).toBe(7500);
    expect((await request(app).delete(`${base}/rates/${rateId}`).set(H)).status).toBe(200);

    // recreate a rate, then delete the whole zone and confirm the rate went too
    const rate2 = await request(app)
      .post(`${base}/zones/${zoneId}/rates`)
      .set(H)
      .send({ name: 'Express', rateType: 'flat', config: { amount: 12000 } });
    const del = await request(app).delete(`${base}/zones/${zoneId}`).set(H);
    expect(del.status).toBe(200);
    expect(await db.ShippingZone.findByPk(zoneId)).toBeNull();
    expect(await db.ShippingRate.findByPk(rate2.body.rate.id)).toBeNull();
  });
});

describe('tax rates CRUD', () => {
  it('full CRUD on tax rates (hard delete — amounts are snapshotted onto orders)', async () => {
    const auth = await registerAndActivate();
    const workspace = await createWorkspace(auth.accessToken, 'Tax Co');
    const H = bearer(auth.accessToken);
    const base = `/api/v1/workspaces/${workspace.id}/tax-rates`;

    const created = await request(app)
      .post(base)
      .set(H)
      .send({ name: 'VAT', country: 'EG', rateBasisPoints: 1400, appliesToShipping: true });
    expect(created.status).toBe(201);
    const id = created.body.taxRate.id;

    expect((await request(app).get(base).set(H)).body.taxRates).toHaveLength(1);
    expect((await request(app).get(`${base}/${id}`).set(H)).status).toBe(200);

    const patch = await request(app).patch(`${base}/${id}`).set(H).send({ rateBasisPoints: 1500 });
    expect(patch.body.taxRate.rateBasisPoints).toBe(1500);

    const del = await request(app).delete(`${base}/${id}`).set(H);
    expect(del.status).toBe(200);
    expect(await db.TaxRate.findByPk(id)).toBeNull();
  });
});

describe('customer basic-info update', () => {
  it('updates a customer name/phone and an address', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const H = bearer(auth.accessToken);

    // create a customer by placing an order
    await placeOrder(auth.accessToken, workspace.id, variant.id);
    const customer = await db.Customer.findOne({ where: { workspaceId: workspace.id } });

    const patch = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/customers/${customer.id}`)
      .set(H)
      .send({ fullName: 'Renamed Buyer', phone: '01099998888', marketingConsent: true });
    expect(patch.status).toBe(200);
    expect(patch.body.customer.fullName).toBe('Renamed Buyer');
    expect(patch.body.customer.marketingConsent).toBe(true);
    const reloaded = await db.Customer.findByPk(customer.id);
    expect(reloaded.phoneNormalized).not.toBe(customer.phoneNormalized); // re-normalized

    const addr = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/customers/${customer.id}/addresses`)
      .set(H)
      .send({ country: 'EG', city: 'Cairo', addressLine: '1 Main St' });
    expect(addr.status).toBe(201);

    const addrPatch = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/customers/${customer.id}/addresses/${addr.body.address.id}`)
      .set(H)
      .send({ city: 'Giza', addressLine: '2 Nile Rd' });
    expect(addrPatch.status).toBe(200);
    expect(addrPatch.body.address.city).toBe('Giza');
  });
});

describe('cross-workspace access is still refused', () => {
  let A;
  let B;
  beforeEach(async () => {
    A = await setupWorkspaceWithProduct({ workspaceName: 'Cross A' });
    B = await registerAndActivate({ fullName: 'Cross B Owner' });
  });

  const asB = (method, path) => request(app)[method](path).set(bearer(B.accessToken));

  it('refuses new catalog delete/update endpoints across workspaces (404)', async () => {
    expect((await asB('delete', `/api/v1/workspaces/${A.workspace.id}/catalog/products/${A.product.id}`)).status).toBe(404);
    expect((await asB('delete', `/api/v1/workspaces/${A.workspace.id}/catalog/variants/${A.variant.id}`)).status).toBe(404);
    expect((await asB('get', `/api/v1/workspaces/${A.workspace.id}/catalog/variants/${A.variant.id}`)).status).toBe(404);

    // and A's product is genuinely untouched
    expect((await db.Product.findByPk(A.product.id)).status).not.toBe('archived');
  });

  it('refuses new shipping / tax endpoints across workspaces (404)', async () => {
    const zone = await request(app)
      .post(`/api/v1/workspaces/${A.workspace.id}/shipping/zones`)
      .set(bearer(A.auth.accessToken))
      .send({ name: 'A Zone', countries: ['EG'] });
    expect(zone.status).toBe(201);
    expect((await asB('get', `/api/v1/workspaces/${A.workspace.id}/shipping/zones/${zone.body.zone.id}`)).status).toBe(404);
    expect((await asB('delete', `/api/v1/workspaces/${A.workspace.id}/shipping/zones/${zone.body.zone.id}`)).status).toBe(404);
    expect((await asB('get', `/api/v1/workspaces/${A.workspace.id}/tax-rates`)).status).toBe(404);
  });
});
