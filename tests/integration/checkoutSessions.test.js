'use strict';

// Abandoned-checkout capture and recovery: the public autosave
// (POST /store/:ws/checkout-sessions), conversion when a storefront order
// lands, the derived abandoned status, and the merchant list / recovery
// update under /workspaces/:ws/checkout-sessions.

const crypto = require('crypto');
const {
  app,
  request,
  registerAndActivate,
  createProductWithVariant,
  setupWorkspaceWithProduct,
} = require('../helpers/factories');
const db = require('../../src/db/models');
const orderService = require('../../src/modules/orders/orderService');
const checkoutSessionService = require('../../src/modules/checkoutSessions/checkoutSessionService');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const key = () => `cs-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const PHONE = '01066660001';
const address = { country: 'EG', city: 'Cairo', addressLine: '1 Recovery St' };

let visitorSeq = 0;
const nextVisitor = () => `visitor-${Date.now()}-${(visitorSeq += 1)}`;

function capture(workspaceId, body) {
  return request(app).post(`/api/v1/store/${workspaceId}/checkout-sessions`).send(body);
}

function sessionBody(variantId, overrides = {}) {
  return {
    contact: { fullName: 'Abandoned Buyer', phone: PHONE, email: 'buyer@example.com' },
    items: [{ variantId, quantity: 2 }],
    visitorId: 'visitor-0001',
    ...overrides,
  };
}

async function captureOk(workspaceId, body) {
  const res = await capture(workspaceId, body);
  if (res.status !== 200) throw new Error(`capture failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.session.id;
}

function checkout(workspaceId, variantId, { phone = PHONE, ...extra } = {}) {
  return request(app)
    .post(`/api/v1/store/${workspaceId}/checkout`)
    .set('Idempotency-Key', key())
    .send({
      item: { variantId, quantity: 1 },
      contact: { fullName: 'Abandoned Buyer', phone },
      shippingAddress: address,
      paymentMethod: 'cod',
      ...extra,
    });
}

function list(ctx, query = {}) {
  return request(app)
    .get(`/api/v1/workspaces/${ctx.workspace.id}/checkout-sessions`)
    .query(query)
    .set(bearer(ctx.auth.accessToken));
}

function patch(ctx, sessionId, body) {
  return request(app)
    .patch(`/api/v1/workspaces/${ctx.workspace.id}/checkout-sessions/${sessionId}`)
    .set(bearer(ctx.auth.accessToken))
    .send(body);
}

/** Moves a session's last activity `minutes` into the past. */
const age = (id, minutes) =>
  db.CheckoutSession.update({ lastActivityAt: new Date(Date.now() - minutes * 60 * 1000) }, { where: { id } });

const reload = (id) => db.CheckoutSession.findByPk(id);

describe('checkout sessions — public capture', () => {
  it('creates a session, then updates the same row when the same visitor saves again', async () => {
    const ctx = await setupWorkspaceWithProduct({ price: 15000 });

    const first = await capture(ctx.workspace.id, sessionBody(ctx.variant.id));
    expect(first.status).toBe(200);
    const id = first.body.session.id;
    const before = await reload(id);

    const second = await capture(
      ctx.workspace.id,
      sessionBody(ctx.variant.id, {
        contact: { fullName: 'Renamed Buyer', phone: '+20 106 666 0002' },
        items: [{ variantId: ctx.variant.id, quantity: 3 }],
        source: 'funnel',
      })
    );
    expect(second.status).toBe(200);
    expect(second.body.session.id).toBe(id);

    expect(await db.CheckoutSession.count({ where: { workspaceId: ctx.workspace.id } })).toBe(1);
    const after = await reload(id);
    expect(after.contactFields).toEqual({ fullName: 'Renamed Buyer', phone: '+20 106 666 0002', email: null });
    expect(after.phoneNormalized).toBe('201066660002');
    expect(after.items[0].quantity).toBe(3);
    expect(Number(after.subtotalAmount)).toBe(45000);
    expect(after.source).toBe('funnel');
    expect(after.lastActivityAt.getTime()).toBeGreaterThanOrEqual(before.lastActivityAt.getTime());
  });

  it('starts a second session for a different visitor', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const a = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id, { visitorId: 'visitor-aaaa' }));
    const b = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id, { visitorId: 'visitor-bbbb' }));
    expect(a).not.toBe(b);
    expect(await db.CheckoutSession.count({ where: { workspaceId: ctx.workspace.id } })).toBe(2);
  });

  it('never creates two rows for concurrent saves from one visitor', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const body = sessionBody(ctx.variant.id, { visitorId: 'visitor-race' });

    const results = await Promise.all([1, 2, 3, 4].map(() => capture(ctx.workspace.id, body)));
    for (const res of results) expect(res.status).toBe(200);
    expect(new Set(results.map((res) => res.body.session.id)).size).toBe(1);
    expect(await db.CheckoutSession.count({ where: { workspaceId: ctx.workspace.id } })).toBe(1);
  });

  it('prices every line from the catalogue and ignores any price the client sends', async () => {
    const ctx = await setupWorkspaceWithProduct({ price: 12500 });
    const { product: product2, variant: variant2 } = await createProductWithVariant(
      ctx.auth.accessToken,
      ctx.workspace.id,
      { price: 4000 }
    );

    const id = await captureOk(ctx.workspace.id, {
      ...sessionBody(ctx.variant.id),
      items: [
        { variantId: ctx.variant.id, quantity: 2, priceAmount: 1, lineTotalAmount: 1 },
        { variantId: variant2.id, quantity: 1 },
      ],
      subtotalAmount: 1,
      currency: 'USD',
    });

    const row = await reload(id);
    expect(Number(row.subtotalAmount)).toBe(29000);
    expect(row.currency).toBe('EGP');
    expect(row.items).toEqual([
      {
        productId: ctx.product.id,
        variantId: ctx.variant.id,
        productName: 'Test Product',
        options: expect.anything(),
        offerName: null,
        quantity: 2,
        lineTotalAmount: 25000,
      },
      {
        productId: product2.id,
        variantId: variant2.id,
        productName: 'Test Product',
        options: expect.anything(),
        offerName: null,
        quantity: 1,
        lineTotalAmount: 4000,
      },
    ]);
  });

  it('prices an offer line at the offer price and snapshots the offer name', async () => {
    const ctx = await setupWorkspaceWithProduct({ price: 10000 });
    const offer = await db.Offer.create({
      workspaceId: ctx.workspace.id,
      productId: ctx.product.id,
      name: 'Two for less',
      pricingMode: 'fixed',
      priceAmount: 17000,
      currency: 'EGP',
      status: 'active',
    });
    await db.OfferVariant.create({ offerId: offer.id, variantId: ctx.variant.id, quantity: 2 });

    const id = await captureOk(
      ctx.workspace.id,
      sessionBody(ctx.variant.id, { items: [{ variantId: ctx.variant.id, offerId: offer.id, quantity: 1 }] })
    );
    const row = await reload(id);
    expect(row.items[0]).toMatchObject({ offerName: 'Two for less', quantity: 1, lineTotalAmount: 17000 });
    expect(Number(row.subtotalAmount)).toBe(17000);
  });

  it('404s an unknown variant, a variant from another workspace, and an unknown offer', async () => {
    const A = await setupWorkspaceWithProduct({ workspaceName: 'CS A' });
    const B = await setupWorkspaceWithProduct({ workspaceName: 'CS B' });

    const unknown = await capture(
      A.workspace.id,
      sessionBody(A.variant.id, { items: [{ variantId: crypto.randomUUID(), quantity: 1 }] })
    );
    expect(unknown.status).toBe(404);

    const foreign = await capture(A.workspace.id, sessionBody(B.variant.id));
    expect(foreign.status).toBe(404);

    const badOffer = await capture(
      A.workspace.id,
      sessionBody(A.variant.id, { items: [{ variantId: A.variant.id, offerId: crypto.randomUUID(), quantity: 1 }] })
    );
    expect(badOffer.status).toBe(404);

    expect(await db.CheckoutSession.count()).toBe(0);
  });

  it('rejects a phone that cannot be normalized with 422 INVALID_PHONE', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const res = await capture(ctx.workspace.id, sessionBody(ctx.variant.id, { contact: { phone: '12345' } }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_PHONE');
  });

  it('rejects malformed bodies with 422', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const v = ctx.variant.id;
    const bad = [
      { ...sessionBody(v), visitorId: undefined },
      { ...sessionBody(v), visitorId: 'short' },
      { ...sessionBody(v), visitorId: 'x'.repeat(65) },
      { ...sessionBody(v), contact: { fullName: 'No Phone' } },
      { ...sessionBody(v), contact: undefined },
      { ...sessionBody(v), items: [] },
      { ...sessionBody(v), items: Array.from({ length: 21 }, () => ({ variantId: v, quantity: 1 })) },
      { ...sessionBody(v), items: [{ variantId: v, quantity: 0 }] },
      { ...sessionBody(v), items: [{ variantId: v, quantity: 101 }] },
      { ...sessionBody(v), items: [{ variantId: 'not-a-uuid', quantity: 1 }] },
      { ...sessionBody(v), source: 'email' },
      { ...sessionBody(v), contact: { phone: PHONE, email: 'not-an-email' } },
    ];
    for (const body of bad) {
      const res = await capture(ctx.workspace.id, body);
      expect(res.status).toBe(422);
    }
    expect(await db.CheckoutSession.count()).toBe(0);
  });

  it('creates no customer and reserves no inventory', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 10 });
    const movements = () => db.InventoryMovement.count({ where: { workspaceId: ctx.workspace.id } });
    const movementsBefore = await movements();

    await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id));

    expect(await db.Customer.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);
    expect((await db.ProductVariant.findByPk(ctx.variant.id)).reservedStock).toBe(0);
    expect(await movements()).toBe(movementsBefore);
  });

  it('answers with the session id and nothing else', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const res = await capture(ctx.workspace.id, sessionBody(ctx.variant.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ session: { id: expect.any(String) } });
  });
});

describe('checkout sessions — derived abandoned status', () => {
  it('lists a session idle for 61 minutes as abandoned, and one idle for 10 only under view=all', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const stale = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id, { visitorId: nextVisitor() }));
    const fresh = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id, { visitorId: nextVisitor() }));
    await age(stale, 61);
    await age(fresh, 10);

    const abandoned = await list(ctx);
    expect(abandoned.status).toBe(200);
    expect(abandoned.body.sessions.map((s) => s.id)).toEqual([stale]);
    expect(abandoned.body.sessions[0].status).toBe('abandoned');

    const all = await list(ctx, { view: 'all' });
    const byId = Object.fromEntries(all.body.sessions.map((s) => [s.id, s]));
    expect(Object.keys(byId).sort()).toEqual([stale, fresh].sort());
    expect(byId[fresh].status).toBe('in_progress');
    expect(byId[stale].status).toBe('abandoned');

    // Stored status is untouched: 'abandoned' is never written.
    expect((await reload(stale)).status).toBe('in_progress');
  });
});

describe('checkout sessions — conversion', () => {
  it('converts the session named by checkoutSessionId, even with a different phone', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const id = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id));

    const order = await checkout(ctx.workspace.id, ctx.variant.id, { phone: '01066669999', checkoutSessionId: id });
    expect(order.status).toBe(201);

    const row = await reload(id);
    expect(row.status).toBe('converted');
    expect(row.convertedOrderId).toBe(order.body.order.id);

    const converted = await list(ctx, { view: 'converted' });
    expect(converted.body.sessions).toHaveLength(1);
    expect(converted.body.sessions[0]).toMatchObject({
      id,
      status: 'converted',
      convertedOrder: { id: order.body.order.id, orderNumber: order.body.order.orderNumber },
    });
  });

  it('converts sessions with the same phone from another visitor, however it was formatted', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const phoneTab = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id, { visitorId: nextVisitor() }));
    const laptopTab = await captureOk(
      ctx.workspace.id,
      sessionBody(ctx.variant.id, { visitorId: nextVisitor(), contact: { phone: '+20 106 666 0001' } })
    );
    const someoneElse = await captureOk(
      ctx.workspace.id,
      sessionBody(ctx.variant.id, { visitorId: nextVisitor(), contact: { phone: '01066660077' } })
    );

    const order = await checkout(ctx.workspace.id, ctx.variant.id, { phone: '00201066660001' });
    expect(order.status).toBe(201);

    expect((await reload(phoneTab)).convertedOrderId).toBe(order.body.order.id);
    expect((await reload(laptopTab)).convertedOrderId).toBe(order.body.order.id);
    expect((await reload(someoneElse)).status).toBe('in_progress');
  });

  it("turns 'contacted' into 'recovered' on conversion and leaves other recovery states alone", async () => {
    const ctx = await setupWorkspaceWithProduct();
    const contacted = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id, { visitorId: nextVisitor() }));
    const lost = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id, { visitorId: nextVisitor() }));
    expect((await patch(ctx, contacted, { recoveryStatus: 'contacted' })).status).toBe(200);
    expect((await patch(ctx, lost, { recoveryStatus: 'lost' })).status).toBe(200);

    expect((await checkout(ctx.workspace.id, ctx.variant.id)).status).toBe(201);

    expect((await reload(contacted)).recoveryStatus).toBe('recovered');
    expect((await reload(lost)).recoveryStatus).toBe('lost');
    expect((await reload(lost)).status).toBe('converted');
  });

  it('does not convert a same-phone session last active more than 7 days ago', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const old = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id));
    await age(old, 8 * 24 * 60);

    expect((await checkout(ctx.workspace.id, ctx.variant.id)).status).toBe(201);
    const row = await reload(old);
    expect(row.status).toBe('in_progress');
    expect(row.convertedOrderId).toBeNull();
  });

  it('never updates a converted session: the same visitor saving again gets a new one', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const body = sessionBody(ctx.variant.id, { visitorId: 'visitor-returning' });
    const first = await captureOk(ctx.workspace.id, body);
    expect((await checkout(ctx.workspace.id, ctx.variant.id, { checkoutSessionId: first })).status).toBe(201);
    const convertedBefore = (await reload(first)).toJSON();

    const second = await captureOk(ctx.workspace.id, { ...body, items: [{ variantId: ctx.variant.id, quantity: 5 }] });
    expect(second).not.toBe(first);
    expect((await reload(first)).toJSON()).toEqual(convertedBefore);
    expect((await reload(second)).status).toBe('in_progress');
  });

  it('ignores a checkoutSessionId from another workspace', async () => {
    const A = await setupWorkspaceWithProduct({ workspaceName: 'Conv A' });
    const B = await setupWorkspaceWithProduct({ workspaceName: 'Conv B' });
    const bSession = await captureOk(B.workspace.id, sessionBody(B.variant.id, { contact: { phone: '01066664444' } }));

    const order = await checkout(A.workspace.id, A.variant.id, { checkoutSessionId: bSession });
    expect(order.status).toBe(201);
    expect((await reload(bSession)).status).toBe('in_progress');
  });

  it('never lets a malformed checkoutSessionId block the order, and still converts by phone', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const samePhone = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id));

    const res = await checkout(ctx.workspace.id, ctx.variant.id, { checkoutSessionId: 'not-a-uuid' });
    expect(res.status).toBe(201);
    expect(await db.Order.findByPk(res.body.order.id)).not.toBeNull();
    expect((await reload(samePhone)).convertedOrderId).toBe(res.body.order.id);

    // An unknown uuid is ignored the same way.
    const unknown = await checkout(ctx.workspace.id, ctx.variant.id, {
      phone: '01066668888',
      checkoutSessionId: crypto.randomUUID(),
    });
    expect(unknown.status).toBe(201);
  });

  it('still returns 201 for the order when conversion throws', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const id = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id));

    const spy = jest
      .spyOn(checkoutSessionService, 'convertForOrder')
      .mockRejectedValue(new Error('boom: conversion failed'));
    let res;
    let calls;
    try {
      res = await checkout(ctx.workspace.id, ctx.variant.id, { checkoutSessionId: id });
      calls = spy.mock.calls.length; // mockRestore() clears the record
    } finally {
      spy.mockRestore();
    }

    expect(calls).toBe(1);
    expect(res.status).toBe(201);
    expect(await db.Order.findByPk(res.body.order.id)).not.toBeNull();
    expect((await reload(id)).status).toBe('in_progress');
  });

  it('converts on the quickstart /shop checkout form by phone', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const id = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id));

    const placed = await request(app)
      .post(`/shop/${ctx.workspace.id}/checkout`)
      .type('form')
      .send({ fullName: 'Form Buyer', phone: PHONE, addressLine: '1 Main St', city: 'Cairo', country: 'EG' })
      .redirects(0);
    expect(placed.status).toBe(303);
    const orderId = placed.headers.location.split('/').pop();

    expect((await reload(id)).convertedOrderId).toBe(orderId);
  });

  it('does not convert anything on a funnel upsell (follow-on) order', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 20 });
    const H = bearer(ctx.auth.accessToken);
    const base = `/api/v1/workspaces/${ctx.workspace.id}/funnels`;
    const store = `/api/v1/store/${ctx.workspace.id}/funnels`;
    const tree = {
      version: 1,
      sections: [
        {
          id: 's1',
          type: 'section',
          rows: [
            {
              id: 'r1',
              type: 'row',
              columns: [{ id: 'c1', type: 'column', span: 12, elements: [{ id: 'e1', type: 'text', props: { text: 'x' } }] }],
            },
          ],
        },
      ],
    };

    const offer = await db.Offer.create({
      workspaceId: ctx.workspace.id,
      productId: ctx.product.id,
      name: 'Upsell',
      pricingMode: 'fixed',
      priceAmount: 6000,
      currency: 'EGP',
      status: 'active',
    });
    await db.OfferVariant.create({ offerId: offer.id, variantId: ctx.variant.id, quantity: 1 });
    const funnel = (await request(app).post(base).set(H).send({ name: 'Upsell Funnel' })).body.funnel;
    const step = (body) => request(app).post(`${base}/${funnel.id}/steps`).set(H).send(body);
    const edge = (body) => request(app).post(`${base}/${funnel.id}/edges`).set(H).send(body);
    await step({ key: 'checkout', stepType: 'checkout', name: 'C', builderData: tree });
    await step({ key: 'upsell', stepType: 'upsell', name: 'U', builderData: tree, offerId: offer.id });
    await step({ key: 'win', stepType: 'thank_you', name: 'W', builderData: tree });
    await edge({ fromStepKey: 'checkout', toStepKey: 'upsell', condition: { type: 'always' } });
    await edge({ fromStepKey: 'upsell', toStepKey: 'win', condition: { type: 'accepted_offer' } });
    expect((await request(app).post(`${base}/${funnel.id}/publish`).set(H).send({})).status).toBe(201);

    // The original order, placed directly so it converts nothing itself.
    const { order: original } = await orderService.createOrder(
      ctx.workspace.id,
      {
        items: [{ variantId: ctx.variant.id, quantity: 1 }],
        contact: { fullName: 'Funnel Buyer', phone: PHONE },
        shippingAddress: address,
        paymentMethod: 'cod',
        funnelId: funnel.id,
      },
      { user: null, headers: {}, ip: null }
    );
    // An open session with the very phone the follow-on order will carry.
    const id = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id, { source: 'funnel' }));

    const advance = (sid, body) => request(app).post(`${store}/${funnel.id}/sessions/${sid}/advance`).send(body);
    const sid = (await request(app).post(`${store}/${funnel.id}/sessions`).send({ visitorId: 'funnel-visitor' })).body
      .session.id;
    await advance(sid, { outcome: { type: 'completed_checkout', orderId: original.id } });
    const accepted = await advance(sid, { fromStepKey: 'upsell', outcome: { type: 'accepted_offer' } });
    expect(accepted.status).toBe(200);
    expect(accepted.body.followOnOrder.linkedFromOrderId).toBe(original.id);

    const row = await reload(id);
    expect(row.status).toBe('in_progress');
    expect(row.convertedOrderId).toBeNull();
  });
});

describe('checkout sessions — merchant list', () => {
  it('filters by view and recoveryStatus', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const a = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id, { visitorId: nextVisitor(), contact: { phone: '01066661111' } }));
    const b = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id, { visitorId: nextVisitor(), contact: { phone: '01066662222' } }));
    const c = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id, { visitorId: nextVisitor(), contact: { phone: '01066663333' } }));
    await age(a, 120);
    await age(b, 90);
    await patch(ctx, b, { recoveryStatus: 'contacted' });
    await checkout(ctx.workspace.id, ctx.variant.id, { phone: '01066663333' });

    expect((await list(ctx)).body.sessions.map((s) => s.id)).toEqual([b, a]);
    expect((await list(ctx, { view: 'converted' })).body.sessions.map((s) => s.id)).toEqual([c]);
    expect((await list(ctx, { view: 'all' })).body.sessions.map((s) => s.id)).toEqual([c, b, a]);
    expect((await list(ctx, { recoveryStatus: 'contacted' })).body.sessions.map((s) => s.id)).toEqual([b]);
    expect((await list(ctx, { view: 'all', recoveryStatus: 'not_contacted' })).body.sessions.map((s) => s.id)).toEqual([
      c,
      a,
    ]);
  });

  it('returns the documented shape', async () => {
    const ctx = await setupWorkspaceWithProduct({ price: 15000 });
    const id = await captureOk(
      ctx.workspace.id,
      sessionBody(ctx.variant.id, { contact: { fullName: 'Shape Buyer', phone: '010 6666 0001', email: 'shape@example.com' } })
    );
    await age(id, 61);

    const res = await list(ctx);
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    const [session] = res.body.sessions;
    expect(Object.keys(session).sort()).toEqual(
      [
        'id',
        'status',
        'recoveryStatus',
        'customerName',
        'phone',
        'email',
        'items',
        'subtotalAmount',
        'currency',
        'source',
        'lastActivityAt',
        'contactedAt',
        'createdAt',
        'convertedOrder',
      ].sort()
    );
    expect(session).toMatchObject({
      id,
      status: 'abandoned',
      recoveryStatus: 'not_contacted',
      customerName: 'Shape Buyer',
      phone: '010 6666 0001',
      email: 'shape@example.com',
      subtotalAmount: 30000,
      currency: 'EGP',
      source: 'store',
      contactedAt: null,
      convertedOrder: null,
    });
    expect(session.items).toHaveLength(1);
  });

  it('pages newest-first with `before`, without repeats or gaps', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id, { visitorId: nextVisitor() }));
      await age(id, 100 + i * 10); // ids[0] newest
      ids.push(id);
    }

    const seen = [];
    let before;
    const pageSizes = [];
    do {
      const res = await list(ctx, { limit: 2, ...(before ? { before } : {}) });
      expect(res.status).toBe(200);
      pageSizes.push(res.body.sessions.length);
      seen.push(...res.body.sessions.map((s) => s.id));
      before = res.body.nextCursor;
    } while (before);

    expect(pageSizes).toEqual([2, 2, 1]);
    expect(seen).toEqual(ids);
  });

  it('pages correctly across sessions sharing a last-activity instant', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const ids = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id, { visitorId: nextVisitor() })));
    }
    await db.sequelize.query(
      "UPDATE checkout_sessions SET last_activity_at = now() - interval '2 hours' WHERE workspace_id = $1",
      { bind: [ctx.workspace.id] }
    );

    const first = await list(ctx, { limit: 2 });
    const second = await list(ctx, { limit: 2, before: first.body.nextCursor });
    const seen = [...first.body.sessions, ...second.body.sessions].map((s) => s.id);
    expect(seen.sort()).toEqual([...ids].sort());
    expect(second.body.nextCursor).toBeNull();
  });

  it('keeps workspaces apart and 422s a cursor that is not a session in this workspace', async () => {
    const A = await setupWorkspaceWithProduct({ workspaceName: 'List A' });
    const B = await setupWorkspaceWithProduct({ workspaceName: 'List B' });
    const aId = await captureOk(A.workspace.id, sessionBody(A.variant.id));
    const bId = await captureOk(B.workspace.id, sessionBody(B.variant.id));
    await age(aId, 61);
    await age(bId, 61);

    expect((await list(A)).body.sessions.map((s) => s.id)).toEqual([aId]);
    expect((await list(B)).body.sessions.map((s) => s.id)).toEqual([bId]);

    const foreign = await list(A, { before: bId });
    expect(foreign.status).toBe(422);
    expect(foreign.body.error.code).toBe('VALIDATION_ERROR');

    expect((await list(A, { before: crypto.randomUUID() })).status).toBe(422);
    expect((await list(A, { before: 'not-a-uuid' })).status).toBe(422);
    expect((await list(A, { view: 'lost' })).status).toBe(422);
    expect((await list(A, { limit: 101 })).status).toBe(422);
  });
});

describe('checkout sessions — recovery status update', () => {
  it("stamps contactedAt once on 'contacted' and keeps it through later changes", async () => {
    const ctx = await setupWorkspaceWithProduct();
    const id = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id));

    const first = await patch(ctx, id, { recoveryStatus: 'contacted' });
    expect(first.status).toBe(200);
    expect(first.body.session.id).toBe(id);
    expect(first.body.session.recoveryStatus).toBe('contacted');
    expect(first.body.session.contactedAt).toEqual(expect.any(String));
    const stamped = first.body.session.contactedAt;

    const lost = await patch(ctx, id, { recoveryStatus: 'lost' });
    expect(lost.body.session.recoveryStatus).toBe('lost');
    expect(lost.body.session.contactedAt).toBe(stamped);

    const again = await patch(ctx, id, { recoveryStatus: 'contacted' });
    expect(again.body.session.contactedAt).toBe(stamped);

    // Recording the follow-up is not shopper activity.
    const untouched = await reload(id);
    expect(untouched.status).toBe('in_progress');
  });

  it('leaves contactedAt null for other values', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const id = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id));
    const res = await patch(ctx, id, { recoveryStatus: 'recovered' });
    expect(res.status).toBe(200);
    expect(res.body.session.contactedAt).toBeNull();
  });

  it('writes an audit row with the before and after status', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const id = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id));
    await patch(ctx, id, { recoveryStatus: 'contacted' });

    const audit = await db.AuditLog.findOne({
      where: { workspaceId: ctx.workspace.id, action: 'checkout_session.recovery_update', entityId: id },
    });
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).toBe(ctx.auth.userId);
    expect(audit.entityType).toBe('CheckoutSession');
    expect(audit.beforeState).toEqual({ recoveryStatus: 'not_contacted' });
    expect(audit.afterState).toEqual({ recoveryStatus: 'contacted' });
  });

  it('rejects a missing or unknown recoveryStatus with 422', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const id = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id));
    expect((await patch(ctx, id, {})).status).toBe(422);
    expect((await patch(ctx, id, { recoveryStatus: 'abandoned' })).status).toBe(422);
  });

  it('404s a session from another workspace, and changes nothing', async () => {
    const A = await setupWorkspaceWithProduct({ workspaceName: 'Patch A' });
    const B = await setupWorkspaceWithProduct({ workspaceName: 'Patch B' });
    const bId = await captureOk(B.workspace.id, sessionBody(B.variant.id));

    const res = await patch(A, bId, { recoveryStatus: 'lost' });
    expect(res.status).toBe(404);
    expect((await reload(bId)).recoveryStatus).toBe('not_contacted');
  });

  it('needs orders.manage: a Confirmation Agent can list but not update', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const id = await captureOk(ctx.workspace.id, sessionBody(ctx.variant.id));

    const agent = await registerAndActivate();
    const role = await db.Role.findOne({ where: { workspaceId: ctx.workspace.id, key: 'confirmation_agent' } });
    const invite = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/members`)
      .set(bearer(ctx.auth.accessToken))
      .send({ email: agent.email, roleId: role.id });
    expect(invite.status).toBe(201);
    const asAgent = { ...ctx, auth: agent };

    expect((await list(asAgent, { view: 'all' })).status).toBe(200);
    const res = await patch(asAgent, id, { recoveryStatus: 'contacted' });
    expect(res.status).toBe(403);
    expect((await reload(id)).recoveryStatus).toBe('not_contacted');
  });

  it('refuses a role without orders.view on the list', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const editor = await registerAndActivate();
    const role = await db.Role.findOne({ where: { workspaceId: ctx.workspace.id, key: 'editor' } });
    await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/members`)
      .set(bearer(ctx.auth.accessToken))
      .send({ email: editor.email, roleId: role.id });

    expect((await list({ ...ctx, auth: editor })).status).toBe(403);
  });
});
