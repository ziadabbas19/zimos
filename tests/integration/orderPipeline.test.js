'use strict';

// The merchant orders screen: chronological paging, the derived pipeline
// stage, and the stage/search/date filters behind the tabs and their counts.
//
// Orders are driven into each stage through the real endpoints — the COD
// confirmation queue, shipment status updates, cancellation, payment capture
// — so the stage expression is checked against the state the system actually
// produces, not against hand-written rows.

const { app, request, setupWorkspaceWithProduct, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const { generateTrackingCode } = require('../../src/modules/orders/shipmentLifecycle');
const { STAGES } = require('../../src/modules/orders/orderStage');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

let seq = 0;
const nextKey = () => `pipe-${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2)}`;

async function placeOrder(token, workspaceId, variantId, overrides = {}) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', nextKey())
    .send({
      items: [{ variantId, quantity: 1 }],
      contact: { fullName: 'Pipeline Buyer', phone: '01000003333', ...(overrides.contact || {}) },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Pipeline St' },
      paymentMethod: overrides.paymentMethod || 'cod',
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

/** Works the COD confirmation queue the way an agent would: claim, then record. */
async function recordConfirmation(token, workspaceId, orderId, outcome) {
  const task = await db.ConfirmationTask.findOne({ where: { orderId } });
  if (!task) throw new Error(`no confirmation task for order ${orderId}`);
  const claim = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/confirmation-tasks/${task.id}/claim`)
    .set(bearer(token))
    .send({});
  if (claim.status !== 200) throw new Error(`claim failed: ${claim.status} ${JSON.stringify(claim.body)}`);

  const body = { outcome };
  if (outcome === 'rejected') body.rejectionReason = 'Customer declined on the call';
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/confirmation-tasks/${task.id}/outcome`)
    .set(bearer(token))
    .send(body);
  if (res.status !== 200) throw new Error(`outcome failed: ${res.status} ${JSON.stringify(res.body)}`);
}

async function createShipment(token, workspaceId, orderId) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/shipments`)
    .set(bearer(token))
    .send({ carrierCode: 'manual' });
  if (res.status !== 201) throw new Error(`createShipment failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.shipment;
}

async function setShipmentStatus(token, workspaceId, orderId, shipmentId, status) {
  const res = await request(app)
    .patch(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/shipments/${shipmentId}`)
    .set(bearer(token))
    .send({ status });
  if (res.status !== 200) throw new Error(`updateShipment failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.shipment;
}

async function payOrder(token, workspaceId, orderId) {
  const init = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/payments`)
    .set(bearer(token))
    .send({});
  if (init.status !== 201) throw new Error(`payment init failed: ${init.status} ${JSON.stringify(init.body)}`);
  const captured = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/payments/${init.body.payment.id}/capture`)
    .set(bearer(token))
    .send({});
  if (captured.status !== 200) throw new Error(`capture failed: ${captured.status} ${JSON.stringify(captured.body)}`);
}

/** Stamps an order's created_at, so a test can build a deliberate timeline. */
async function setCreatedAt(orderId, date) {
  await db.Order.update({ createdAt: date }, { where: { id: orderId }, silent: true });
}

const listOrders = (token, workspaceId, query = '') =>
  request(app).get(`/api/v1/workspaces/${workspaceId}/orders${query}`).set(bearer(token));

const pipeline = (token, workspaceId, query = '') =>
  request(app).get(`/api/v1/workspaces/${workspaceId}/orders/pipeline${query}`).set(bearer(token));

const getOrder = (token, workspaceId, orderId) =>
  request(app).get(`/api/v1/workspaces/${workspaceId}/orders/${orderId}`).set(bearer(token));

/** One order per stage, built through the real endpoints. */
async function buildEveryStage(auth, workspace, variant) {
  const token = auth.accessToken;
  const ws = workspace.id;
  const built = {};

  // New: a COD order nobody has called yet.
  built.pending_confirmation = await placeOrder(token, ws, variant.id);

  // Awaiting payment: a prepaid order the shopper has not paid.
  built.awaiting_payment = await placeOrder(token, ws, variant.id, { paymentMethod: 'card' });

  // Needs follow-up: the call went unanswered.
  built.needs_follow_up = await placeOrder(token, ws, variant.id);
  await recordConfirmation(token, ws, built.needs_follow_up.id, 'unreachable');

  // Ready to ship: confirmed on the call, nothing shipped yet.
  built.ready_to_ship = await placeOrder(token, ws, variant.id);
  await recordConfirmation(token, ws, built.ready_to_ship.id, 'confirmed');

  // Shipped / out for delivery / failed / delivered / returned: one confirmed
  // order each, moved along the shipment lifecycle.
  const viaShipment = async (status) => {
    const order = await placeOrder(token, ws, variant.id);
    await recordConfirmation(token, ws, order.id, 'confirmed');
    const shipment = await createShipment(token, ws, order.id);
    await setShipmentStatus(token, ws, order.id, shipment.id, status);
    return order;
  };
  built.shipped = await viaShipment('in_transit');
  built.out_for_delivery = await viaShipment('out_for_delivery');
  built.delivery_failed = await viaShipment('failed');
  built.delivered = await viaShipment('delivered');
  built.returned = await viaShipment('returned');

  // Cancelled: the merchant called it off.
  built.cancelled = await placeOrder(token, ws, variant.id);
  const cancelled = await request(app)
    .post(`/api/v1/workspaces/${ws}/orders/${built.cancelled.id}/cancel`)
    .set(bearer(token))
    .send({ reason: 'Duplicate order' });
  if (cancelled.status !== 200) throw new Error(`cancel failed: ${cancelled.status}`);

  return built;
}

describe('orders list ordering and paging', () => {
  it('returns newest first, not in id order', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 50 });

    const orders = [];
    for (let i = 0; i < 5; i += 1) {
      orders.push(await placeOrder(auth.accessToken, workspace.id, variant.id));
    }
    // Deliberately unrelated to insertion order, so an id- or insert-ordered
    // list cannot pass by accident.
    const minutes = [30, 10, 50, 20, 40];
    for (let i = 0; i < orders.length; i += 1) {
      await setCreatedAt(orders[i].id, new Date(Date.UTC(2026, 0, 1, 12, minutes[i], 0)));
    }

    const res = await listOrders(auth.accessToken, workspace.id);
    expect(res.status).toBe(200);

    const expected = [orders[2].id, orders[4].id, orders[0].id, orders[3].id, orders[1].id];
    expect(res.body.orders.map((o) => o.id)).toEqual(expected);
  });

  it('pages stably through orders that share a created_at, with no duplicates or skips', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 50 });

    const placed = [];
    for (let i = 0; i < 6; i += 1) {
      placed.push(await placeOrder(auth.accessToken, workspace.id, variant.id));
    }
    // Every order at the very same instant: the id tie-breaker is the only
    // thing keeping the keyset total.
    const sameInstant = new Date(Date.UTC(2026, 0, 2, 9, 0, 0));
    for (const order of placed) await setCreatedAt(order.id, sameInstant);

    const seen = [];
    let cursor = null;
    for (let page = 0; page < 4; page += 1) {
      const query = `?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await listOrders(auth.accessToken, workspace.id, query);
      expect(res.status).toBe(200);
      seen.push(...res.body.orders.map((o) => o.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }

    expect(cursor).toBeNull();
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort()).toEqual(placed.map((o) => o.id).sort());
  });

  it('keeps the cursor opaque: it is the last order id of the previous page', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 50 });
    const placed = [];
    for (let i = 0; i < 3; i += 1) {
      placed.push(await placeOrder(auth.accessToken, workspace.id, variant.id));
      await setCreatedAt(placed[i].id, new Date(Date.UTC(2026, 0, 3, 8, i, 0)));
    }

    const first = await listOrders(auth.accessToken, workspace.id, '?limit=1');
    expect(first.body.orders).toHaveLength(1);
    expect(first.body.nextCursor).toBe(first.body.orders[0].id);

    const second = await listOrders(auth.accessToken, workspace.id, `?limit=1&cursor=${first.body.nextCursor}`);
    expect(second.body.orders[0].id).not.toBe(first.body.orders[0].id);
  });

  it('rejects an unknown cursor with 422', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await listOrders(auth.accessToken, workspace.id, '?cursor=00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d) => d.field)).toContain('cursor');
  });

  it("rejects another workspace's order id as a cursor with 422", async () => {
    const a = await setupWorkspaceWithProduct({ stock: 5 });
    const otherAuth = await registerAndActivate();
    const otherWorkspace = await createWorkspace(otherAuth.accessToken, 'Other Pipeline Workspace');
    const otherProduct = await request(app)
      .post(`/api/v1/workspaces/${otherWorkspace.id}/catalog/products`)
      .set(bearer(otherAuth.accessToken))
      .send({ name: 'Other Product', status: 'active' });
    const otherVariant = await request(app)
      .post(`/api/v1/workspaces/${otherWorkspace.id}/catalog/products/${otherProduct.body.product.id}/variants`)
      .set(bearer(otherAuth.accessToken))
      .send({ sku: `OTHER-${Date.now()}`, priceAmount: 5000, stockOnHand: 5 });
    const foreignOrder = await placeOrder(otherAuth.accessToken, otherWorkspace.id, otherVariant.body.variant.id);

    const res = await listOrders(a.auth.accessToken, a.workspace.id, `?cursor=${foreignOrder.id}`);
    expect(res.status).toBe(422);
    expect(res.body.error.details.map((d) => d.field)).toContain('cursor');
  });
});

describe('derived order stage', () => {
  it('maps every stage from the state the real endpoints produce', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 100 });
    const built = await buildEveryStage(auth, workspace, variant);

    const res = await listOrders(auth.accessToken, workspace.id, '?limit=200');
    expect(res.status).toBe(200);
    const stageById = new Map(res.body.orders.map((o) => [o.id, o.stage]));

    for (const [expectedStage, order] of Object.entries(built)) {
      expect(`${expectedStage}:${stageById.get(order.id)}`).toBe(`${expectedStage}:${expectedStage}`);
    }
    // Every stage key the module declares was actually reachable.
    expect(new Set(Object.keys(built))).toEqual(new Set(STAGES));
  });

  it('returns the stage on the order detail endpoint too', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

    const asNew = await getOrder(auth.accessToken, workspace.id, order.id);
    expect(asNew.status).toBe(200);
    expect(asNew.body.order.stage).toBe('pending_confirmation');
    expect(asNew.body.order.items).toHaveLength(1);

    await recordConfirmation(auth.accessToken, workspace.id, order.id, 'confirmed');
    const asReady = await getOrder(auth.accessToken, workspace.id, order.id);
    expect(asReady.body.order.stage).toBe('ready_to_ship');
  });

  it('treats a created shipment as still ready to ship — the waybill is printed, the parcel is not gone', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await recordConfirmation(auth.accessToken, workspace.id, order.id, 'confirmed');
    const shipment = await createShipment(auth.accessToken, workspace.id, order.id);

    const withWaybill = await getOrder(auth.accessToken, workspace.id, order.id);
    expect(withWaybill.body.order.stage).toBe('ready_to_ship');

    await setShipmentStatus(auth.accessToken, workspace.id, order.id, shipment.id, 'picked_up');
    const collected = await getOrder(auth.accessToken, workspace.id, order.id);
    expect(collected.body.order.stage).toBe('shipped');
  });

  it('follows the newest non-cancelled shipment when an order has several', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await recordConfirmation(auth.accessToken, workspace.id, order.id, 'confirmed');

    const first = await createShipment(auth.accessToken, workspace.id, order.id);
    await setShipmentStatus(auth.accessToken, workspace.id, order.id, first.id, 'failed');
    expect((await getOrder(auth.accessToken, workspace.id, order.id)).body.order.stage).toBe('delivery_failed');

    // A re-send: the newer parcel is where the order is now. POST /shipments
    // now refuses a second shipment while one is failed (one active shipment
    // per order), but orders from before that rule can hold both, so the row
    // is written directly.
    const second = await db.Shipment.create({
      workspaceId: workspace.id,
      orderId: order.id,
      carrierCode: 'manual',
      status: 'created',
      trackingCode: generateTrackingCode(),
    });
    await db.Shipment.update(
      { createdAt: new Date(Date.now() + 60000) },
      { where: { id: second.id }, silent: true }
    );
    await setShipmentStatus(auth.accessToken, workspace.id, order.id, second.id, 'out_for_delivery');
    expect((await getOrder(auth.accessToken, workspace.id, order.id)).body.order.stage).toBe('out_for_delivery');

    // Cancelling that parcel leaves the failed one as the latest that counts.
    await setShipmentStatus(auth.accessToken, workspace.id, order.id, second.id, 'cancelled');
    expect((await getOrder(auth.accessToken, workspace.id, order.id)).body.order.stage).toBe('delivery_failed');
  });

  it('does not park prepaid orders in New: an unpaid card order awaits payment, a paid one is ready to ship', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10, price: 15000 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, { paymentMethod: 'card' });

    // No confirmation task is ever created for a prepaid order, so its
    // confirmation_state stays 'pending' for life.
    expect(await db.ConfirmationTask.count({ where: { orderId: order.id } })).toBe(0);
    expect((await getOrder(auth.accessToken, workspace.id, order.id)).body.order.stage).toBe('awaiting_payment');

    await payOrder(auth.accessToken, workspace.id, order.id);
    expect((await db.Order.findByPk(order.id)).financialState).toBe('paid');
    expect((await getOrder(auth.accessToken, workspace.id, order.id)).body.order.stage).toBe('ready_to_ship');
  });

  it('reads a COD rejection as cancelled', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await recordConfirmation(auth.accessToken, workspace.id, order.id, 'rejected');
    expect((await getOrder(auth.accessToken, workspace.id, order.id)).body.order.stage).toBe('cancelled');
  });
});

describe('stage filter and pipeline counts', () => {
  it('counts every stage, with the count matching the rows the tab shows', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 100 });
    const built = await buildEveryStage(auth, workspace, variant);
    // A second order in one stage, so at least one count is not 1.
    const extraNew = await placeOrder(auth.accessToken, workspace.id, variant.id);

    const counts = await pipeline(auth.accessToken, workspace.id);
    expect(counts.status).toBe(200);
    expect(Object.keys(counts.body.stages).sort()).toEqual([...STAGES].sort());
    expect(counts.body.total).toBe(Object.keys(built).length + 1);
    expect(counts.body.stages.pending_confirmation).toBe(2);

    // Every tab's count equals the number of rows that tab lists.
    for (const stage of STAGES) {
      const rows = await listOrders(auth.accessToken, workspace.id, `?limit=200&stage=${stage}`);
      expect(rows.status).toBe(200);
      expect(`${stage}=${rows.body.orders.length}`).toBe(`${stage}=${counts.body.stages[stage]}`);
      for (const order of rows.body.orders) expect(order.stage).toBe(stage);
    }
    expect(counts.body.stages.pending_confirmation).toBe(2);
    expect(extraNew.id).toBeDefined();
  });

  it('zero-fills stages with no orders', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    await placeOrder(auth.accessToken, workspace.id, variant.id);

    const counts = await pipeline(auth.accessToken, workspace.id);
    expect(counts.body.total).toBe(1);
    expect(counts.body.stages.pending_confirmation).toBe(1);
    expect(counts.body.stages.delivered).toBe(0);
    expect(counts.body.stages.returned).toBe(0);
  });
});

describe('order search', () => {
  const contacts = {
    hoda: { fullName: 'Hoda El Sayed', phone: '01012345678', email: 'hoda@example.com' },
    karim: { fullName: 'Karim Fathy', phone: '01198765432', email: 'karim.fathy@shop.test' },
  };

  async function seedSearchable() {
    const setup = await setupWorkspaceWithProduct({ stock: 20 });
    const hoda = await placeOrder(setup.auth.accessToken, setup.workspace.id, setup.variant.id, { contact: contacts.hoda });
    const karim = await placeOrder(setup.auth.accessToken, setup.workspace.id, setup.variant.id, { contact: contacts.karim });
    return { ...setup, hoda, karim };
  }

  const idsFor = async (auth, workspace, q) => {
    const res = await listOrders(auth.accessToken, workspace.id, `?q=${encodeURIComponent(q)}`);
    expect(res.status).toBe(200);
    return res.body.orders.map((o) => o.id);
  };

  it('finds an order by its number, with or without the leading # and in any case', async () => {
    const { auth, workspace, hoda } = await seedSearchable();
    expect(await idsFor(auth, workspace, hoda.orderNumber)).toEqual([hoda.id]);
    expect(await idsFor(auth, workspace, `#${hoda.orderNumber}`)).toEqual([hoda.id]);
    expect(await idsFor(auth, workspace, hoda.orderNumber.toLowerCase())).toEqual([hoda.id]);
    // A tail of the number is enough.
    expect(await idsFor(auth, workspace, hoda.orderNumber.slice(-6))).toEqual([hoda.id]);
  });

  it('finds an order by customer name and email, case-insensitively and on a partial', async () => {
    const { auth, workspace, hoda, karim } = await seedSearchable();
    expect(await idsFor(auth, workspace, 'hoda el')).toEqual([hoda.id]);
    expect(await idsFor(auth, workspace, 'EL SAYED')).toEqual([hoda.id]);
    expect(await idsFor(auth, workspace, 'karim.fathy@shop.test')).toEqual([karim.id]);
    expect(await idsFor(auth, workspace, 'shop.test')).toEqual([karim.id]);
  });

  it('finds an order by phone in local, +country and bare-country form', async () => {
    const { auth, workspace, hoda } = await seedSearchable();
    for (const typed of ['01012345678', '+201012345678', '201012345678', '0101 234 5678']) {
      expect(await idsFor(auth, workspace, typed)).toEqual([hoda.id]);
    }
  });

  it('treats % and _ as literal characters, not wildcards', async () => {
    const { auth, workspace } = await seedSearchable();
    // Would match everything if the pattern were passed through unescaped.
    expect(await idsFor(auth, workspace, '%%')).toEqual([]);
    expect(await idsFor(auth, workspace, '_a')).toEqual([]);
    expect(await idsFor(auth, workspace, 'Hoda%Sayed')).toEqual([]);
  });

  // Arabic has no case, so lower() does nothing for it. What varies instead is
  // the spelling: the alef forms, taa marbuta vs haa, alef maqsura vs yaa, and
  // the short-vowel marks. The customer spells it one way, the merchant types
  // the other, and both must find the order — see zimos_normalize_search in
  // migration 088.
  describe('Arabic name search', () => {
    const arabic = {
      ahmed: { fullName: 'أحمد علي', phone: '01111100001' },
      fatma: { fullName: 'فاطمة السيد', phone: '01111100002' },
      mostafa: { fullName: 'مصطفى كامل', phone: '01111100003' },
      // Written with tashkeel, as a customer's own spelling sometimes is.
      samir: { fullName: 'سَمِير الشاذلي', phone: '01111100004' },
    };

    async function seedArabic() {
      const setup = await setupWorkspaceWithProduct({ stock: 30 });
      const placed = {};
      for (const [key, contact] of Object.entries(arabic)) {
        placed[key] = await placeOrder(setup.auth.accessToken, setup.workspace.id, setup.variant.id, { contact });
      }
      return { ...setup, placed };
    }

    it.each([
      ['احمد', 'ahmed', 'bare alef finds the hamza spelling'],
      ['أحمد', 'ahmed', 'and the hamza spelling finds itself'],
      ['فاطمه', 'fatma', 'haa finds taa marbuta'],
      ['فاطمة', 'fatma', 'and taa marbuta finds itself'],
      ['مصطفي', 'mostafa', 'yaa finds alef maqsura'],
      ['مصطفى', 'mostafa', 'and alef maqsura finds itself'],
      ['سمير', 'samir', 'plain spelling finds a name written with tashkeel'],
    ])('%s finds the right order (%s: %s)', async (typed, expectedKey) => {
      const { auth, workspace, placed } = await seedArabic();
      const found = await idsFor(auth, workspace, typed);
      expect(found).toEqual([placed[expectedKey].id]);
    });

    it('still counts the same orders on the pipeline endpoint', async () => {
      const { auth, workspace, placed } = await seedArabic();
      const counts = await pipeline(auth.accessToken, workspace.id, `?q=${encodeURIComponent('احمد')}`);
      expect(counts.status).toBe(200);
      expect(counts.body.total).toBe(1);
      expect(counts.body.stages.pending_confirmation).toBe(1);
      expect(placed.ahmed.id).toBeDefined();
    });

    it('does not fold unrelated names together', async () => {
      const { auth, workspace } = await seedArabic();
      // Folding must not become "everything matches everything".
      expect(await idsFor(auth, workspace, 'سعيد')).toEqual([]);
    });
  });

  it('combines q with stage and keeps paging', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 50 });
    const token = auth.accessToken;

    // Three confirmed orders for the same customer, plus one left unconfirmed
    // and one for somebody else.
    const wanted = [];
    for (let i = 0; i < 3; i += 1) {
      const order = await placeOrder(token, workspace.id, variant.id, { contact: contacts.hoda });
      await recordConfirmation(token, workspace.id, order.id, 'confirmed');
      await setCreatedAt(order.id, new Date(Date.UTC(2026, 1, 1, 10, i, 0)));
      wanted.push(order.id);
    }
    const stillNew = await placeOrder(token, workspace.id, variant.id, { contact: contacts.hoda });
    const someoneElse = await placeOrder(token, workspace.id, variant.id, { contact: contacts.karim });
    await recordConfirmation(token, workspace.id, someoneElse.id, 'confirmed');

    const counts = await pipeline(token, workspace.id, '?q=hoda');
    expect(counts.body.total).toBe(4);
    expect(counts.body.stages.ready_to_ship).toBe(3);
    expect(counts.body.stages.pending_confirmation).toBe(1);

    const seen = [];
    let cursor = null;
    for (let page = 0; page < 4; page += 1) {
      const query = `?limit=2&q=hoda&stage=ready_to_ship${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await listOrders(token, workspace.id, query);
      expect(res.status).toBe(200);
      seen.push(...res.body.orders.map((o) => o.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    // Newest first, no duplicates, and neither the unconfirmed order nor the
    // other customer's leaked in.
    expect(seen).toEqual([wanted[2], wanted[1], wanted[0]]);
    expect(seen).not.toContain(stillNew.id);
    expect(seen).not.toContain(someoneElse.id);
  });

  it('filters by created_at date range, with `to` covering the whole UTC day', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 20 });
    const token = auth.accessToken;

    const before = await placeOrder(token, workspace.id, variant.id);
    const onTheDay = await placeOrder(token, workspace.id, variant.id);
    const lateOnTheDay = await placeOrder(token, workspace.id, variant.id);
    const after = await placeOrder(token, workspace.id, variant.id);
    await setCreatedAt(before.id, new Date(Date.UTC(2026, 2, 9, 23, 59, 59)));
    await setCreatedAt(onTheDay.id, new Date(Date.UTC(2026, 2, 10, 0, 0, 1)));
    await setCreatedAt(lateOnTheDay.id, new Date(Date.UTC(2026, 2, 10, 23, 59, 59)));
    await setCreatedAt(after.id, new Date(Date.UTC(2026, 2, 11, 0, 0, 1)));

    const res = await listOrders(token, workspace.id, '?from=2026-03-10&to=2026-03-10');
    expect(res.body.orders.map((o) => o.id).sort()).toEqual([onTheDay.id, lateOnTheDay.id].sort());

    const counts = await pipeline(token, workspace.id, '?from=2026-03-10&to=2026-03-10');
    expect(counts.body.total).toBe(2);
    expect(counts.body.stages.pending_confirmation).toBe(2);
  });

  it('never matches or counts another workspace\'s orders', async () => {
    const mine = await seedSearchable();
    const otherAuth = await registerAndActivate();
    const otherWorkspace = await createWorkspace(otherAuth.accessToken, 'Rival Workspace');
    const otherProduct = await request(app)
      .post(`/api/v1/workspaces/${otherWorkspace.id}/catalog/products`)
      .set(bearer(otherAuth.accessToken))
      .send({ name: 'Rival Product', status: 'active' });
    const otherVariant = await request(app)
      .post(`/api/v1/workspaces/${otherWorkspace.id}/catalog/products/${otherProduct.body.product.id}/variants`)
      .set(bearer(otherAuth.accessToken))
      .send({ sku: `RIVAL-${Date.now()}`, priceAmount: 5000, stockOnHand: 5 });
    // Same name, same phone, in a different workspace.
    const theirs = await placeOrder(otherAuth.accessToken, otherWorkspace.id, otherVariant.body.variant.id, {
      contact: contacts.hoda,
    });

    const found = await idsFor(mine.auth, mine.workspace, '01012345678');
    expect(found).toEqual([mine.hoda.id]);
    expect(found).not.toContain(theirs.id);

    const counts = await pipeline(mine.auth.accessToken, mine.workspace.id);
    expect(counts.body.total).toBe(2);

    const theirCounts = await pipeline(otherAuth.accessToken, otherWorkspace.id);
    expect(theirCounts.body.total).toBe(1);
  });

  it('rejects an invalid stage and an out-of-range q with 422', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();

    const badStage = await listOrders(auth.accessToken, workspace.id, '?stage=in_the_van');
    expect(badStage.status).toBe(422);
    expect(badStage.body.error.details.map((d) => d.field)).toContain('stage');

    const shortQ = await listOrders(auth.accessToken, workspace.id, '?q=a');
    expect(shortQ.status).toBe(422);
    expect(shortQ.body.error.details.map((d) => d.field)).toContain('q');

    const longQ = await listOrders(auth.accessToken, workspace.id, `?q=${'x'.repeat(101)}`);
    expect(longQ.status).toBe(422);
    expect(longQ.body.error.details.map((d) => d.field)).toContain('q');

    // The counts endpoint validates q the same way.
    const badPipelineQ = await pipeline(auth.accessToken, workspace.id, '?q=a');
    expect(badPipelineQ.status).toBe(422);

    // It takes no `stage`: like every other endpoint here, validate() strips
    // unknown query params rather than rejecting them, so a stray stage is
    // ignored and the answer still covers every stage.
    const stageOnPipeline = await pipeline(auth.accessToken, workspace.id, '?stage=shipped');
    expect(stageOnPipeline.status).toBe(200);
    expect(Object.keys(stageOnPipeline.body.stages).sort()).toEqual([...STAGES].sort());
  });

  it('keeps /pipeline routed ahead of /:orderId', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await pipeline(auth.accessToken, workspace.id);
    expect(res.status).toBe(200);
    expect(res.body.stages).toBeDefined();
  });
});
