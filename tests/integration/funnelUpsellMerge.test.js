'use strict';

// Funnel upsells joined to the checkout order (funnels/funnelOfferMerge.js),
// behind workspaces.settings.funnel_upsell_merge: the offer window that keeps
// a funnel order out of the confirmation queue, the merge itself (one order,
// priced again in full), its idempotency, the linked fallback once the window
// has closed, and the old behaviour with the flag off.

const { app, request, setupWorkspaceWithProduct, createProductWithVariant, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const { computeWaybillModel } = require('../../src/modules/waybill/waybillService');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
let seq = 0;
const nextPhone = () => `0102${String(2000000 + (seq += 1)).padStart(7, '0')}`;
const ADDRESS = { country: 'EG', province: 'Cairo', city: 'Nasr City', addressLine: '12 Abbas El Akkad Street' };

const tree = (text) => ({
  version: 1,
  sections: [
    {
      id: 's1',
      type: 'section',
      rows: [{ id: 'r1', type: 'row', columns: [{ id: 'c1', type: 'column', span: 12, elements: [{ id: 'e1', type: 'text', props: { text } }] }] }],
    },
  ],
});

/**
 * checkout → upsell (accept → thanks, decline → downsell) → downsell → thanks.
 * Main product 20000; the add-on product 10000, its upsell offer 7000 and
 * downsell offer 5000.
 */
async function setup({ merge = true, upsellStock = 10, mainPrice = 20000 } = {}) {
  const ctx = await setupWorkspaceWithProduct({ price: mainPrice, stock: 20 });
  const token = ctx.auth.accessToken;
  const ws = ctx.workspace.id;
  const api = (method, path) => request(app)[method](`/api/v1/workspaces/${ws}${path}`).set(bearer(token));
  const addOn = await createProductWithVariant(token, ws, { price: 10000, stock: upsellStock });
  const makeOffer = async (name, priceAmount) => {
    const res = await api('post', `/catalog/products/${addOn.product.id}/offers`).send({
      name,
      priceAmount,
      lines: [{ variantId: addOn.variant.id, quantity: 1 }],
    });
    if (res.status !== 201) throw new Error(`offer: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.offer;
  };
  const upsellOffer = await makeOffer('Upsell deal', 7000);
  const downsellOffer = await makeOffer('Downsell deal', 5000);

  const funnel = (await api('post', '/funnels').send({ name: 'Merge Funnel' })).body.funnel;
  const step = (body) => api('post', `/funnels/${funnel.id}/steps`).send(body);
  const edge = (from, to, type) => api('post', `/funnels/${funnel.id}/edges`).send({ fromStepKey: from, toStepKey: to, condition: { type } });
  await step({ key: 'checkout', stepType: 'checkout', name: 'Checkout', builderData: tree('c') });
  await step({ key: 'upsell', stepType: 'upsell', name: 'Upsell', builderData: tree('u'), offerId: upsellOffer.id });
  await step({ key: 'downsell', stepType: 'downsell', name: 'Downsell', builderData: tree('d'), offerId: downsellOffer.id });
  await step({ key: 'thanks', stepType: 'thank_you', name: 'Thanks', builderData: tree('t') });
  await edge('checkout', 'upsell', 'completed_checkout');
  await edge('upsell', 'thanks', 'accepted_offer');
  await edge('upsell', 'downsell', 'declined_offer');
  await edge('downsell', 'thanks', 'always');
  const pub = await api('post', `/funnels/${funnel.id}/publish`).send({});
  if (pub.status !== 201) throw new Error(`publish: ${pub.status} ${JSON.stringify(pub.body)}`);

  if (merge) {
    const res = await api('patch', '').send({ settings: { funnel_upsell_merge: true } });
    if (res.status !== 200) throw new Error(`flag: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { ...ctx, token, ws, api, addOn, upsellOffer, downsellOffer, funnel };
}

const storeApi = (ctx) => `/api/v1/store/${ctx.ws}`;

async function checkout(ctx, body = {}) {
  const res = await request(app)
    .post(`${storeApi(ctx)}/checkout`)
    .set('Idempotency-Key', `merge-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      item: { variantId: ctx.variant.id, quantity: 1 },
      contact: { fullName: 'Funnel Buyer', phone: nextPhone() },
      shippingAddress: ADDRESS,
      paymentMethod: 'cod',
      funnelId: ctx.funnel.id,
      ...body,
    });
  if (res.status !== 201) throw new Error(`checkout: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

async function session(ctx, orderId, visitorId = `v-${Math.random().toString(36).slice(2)}`) {
  const start = await request(app).post(`${storeApi(ctx)}/funnels/${ctx.funnel.id}/sessions`).send({ visitorId });
  const sid = start.body.session.id;
  const done = await advance(ctx, sid, 'checkout', { type: 'completed_checkout', orderId });
  expect(done.status).toBe(200);
  expect(done.body.step.key).toBe('upsell');
  return sid;
}

const advance = (ctx, sid, fromStepKey, outcome) =>
  request(app).post(`${storeApi(ctx)}/funnels/${ctx.funnel.id}/sessions/${sid}/advance`).send({ fromStepKey, outcome });

const task = (orderId) => db.ConfirmationTask.findOne({ where: { orderId } });
const reserved = async (variantId) => (await db.ProductVariant.findByPk(variantId)).reservedStock;

describe('funnel offer window', () => {
  it('keeps a funnel order out of reach until its window closes, and lists it as waiting', async () => {
    const ctx = await setup();
    const order = await checkout(ctx);
    const t = await task(order.id);
    const minutes = (new Date(t.availableAt) - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);

    const queue = await ctx.api('get', '/confirmation-tasks?status=pending');
    const row = queue.body.tasks.find((x) => x.orderId === order.id);
    expect(row.waitingForOffers).toBe(true);
    const counts = await ctx.api('get', '/confirmation-tasks/counts');
    expect(counts.body.counts).toMatchObject({ pending: 1, pendingDue: 0, waitingForOffers: 1 });

    const claim = await ctx.api('post', `/confirmation-tasks/${t.id}/claim`);
    expect(claim.status).toBe(409);
    expect(claim.body.error.code).toBe('TASK_WAITING_FOR_OFFERS');
    const fromOrder = await ctx.api('post', `/orders/${order.id}/confirmation`).send({});
    expect(fromOrder.status).toBe(409);
    expect(fromOrder.body.error.code).toBe('TASK_WAITING_FOR_OFFERS');

    const detail = await ctx.api('get', `/orders/${order.id}`);
    expect(detail.body.order.confirmationTask.waitingForOffers).toBe(true);
  });

  it('closes when the shopper is past the last offer', async () => {
    const ctx = await setup();
    const order = await checkout(ctx);
    const sid = await session(ctx, order.id);
    // Still on the upsell, then the downsell: open.
    expect((await advance(ctx, sid, 'upsell', { type: 'declined_offer' })).body.step.key).toBe('downsell');
    expect(new Date((await task(order.id)).availableAt) > new Date()).toBe(true);
    // Past the downsell: the thank-you page, the window closes.
    const end = await advance(ctx, sid, 'downsell', { type: 'declined_offer' });
    expect(end.body.step.key).toBe('thanks');
    expect(new Date((await task(order.id)).availableAt) <= new Date()).toBe(true);
    expect((await ctx.api('post', `/confirmation-tasks/${(await task(order.id)).id}/claim`)).status).toBe(200);
  });

  it('opens on its own after the timeout when the shopper never finishes the funnel', async () => {
    const ctx = await setup();
    await ctx.api('patch', '').send({ settings: { funnel_offer_window_minutes: 5 } });
    const order = await checkout(ctx);
    const t = await task(order.id);
    expect((new Date(t.availableAt) - Date.now()) / 60000).toBeLessThanOrEqual(5);
    // Five minutes later (the shopper closed the tab on the upsell).
    await t.update({ availableAt: new Date(Date.now() - 1000) });
    const counts = await ctx.api('get', '/confirmation-tasks/counts');
    expect(counts.body.counts).toMatchObject({ pendingDue: 1, waitingForOffers: 0 });
    expect((await ctx.api('post', `/confirmation-tasks/${t.id}/claim`)).status).toBe(200);
  });

  it('tells the offer step whether accepting joins the order', async () => {
    const ctx = await setup();
    const order = await checkout(ctx);
    const sid = await session(ctx, order.id);
    const step = await request(app).get(`${storeApi(ctx)}/funnels/${ctx.funnel.id}/sessions/${sid}/step`);
    expect(step.body.offerJoinsOrder).toBe(true);
    await db.ConfirmationTask.update({ availableAt: new Date(Date.now() - 1000) }, { where: { orderId: order.id } });
    const later = await request(app).get(`${storeApi(ctx)}/funnels/${ctx.funnel.id}/sessions/${sid}/step`);
    expect(later.body.offerJoinsOrder).toBe(false);
  });

  it('leaves an order placed outside a funnel as it was, flag or not', async () => {
    const ctx = await setup();
    const order = await checkout(ctx, { funnelId: undefined });
    expect((await task(order.id)).availableAt).toBeNull();
    expect((await ctx.api('post', `/confirmation-tasks/${(await task(order.id)).id}/claim`)).status).toBe(200);
  });

  it('needs orders.manage to change', async () => {
    const ctx = await setup({ merge: false });
    const editor = await addMemberWithRole(ctx.token, ctx.ws, 'editor', 'Editor');
    const token = editor.accessToken;
    const res = await request(app)
      .patch(`/api/v1/workspaces/${ctx.ws}`)
      .set(bearer(token))
      .send({ settings: { funnel_upsell_merge: true } });
    expect(res.status).toBe(403);
    expect((await db.Workspace.findByPk(ctx.ws)).settings.funnel_upsell_merge).toBeUndefined();
  });
});

describe('funnel offer merge', () => {
  it('adds an accepted upsell to the same order, priced again in full', async () => {
    const ctx = await setup();
    await ctx.api('patch', '').send({ settings: { default_shipping_rate_amount: 5000 } });
    const order = await checkout(ctx);
    expect(Number(order.totalAmount)).toBe(25000);
    const sid = await session(ctx, order.id);

    const res = await advance(ctx, sid, 'upsell', { type: 'accepted_offer' });
    expect(res.status).toBe(200);
    expect(res.body.step.key).toBe('thanks');
    expect(res.body.followOnOrder).toBeUndefined();
    expect(res.body.mergedOrder).toMatchObject({ id: order.id, orderNumber: order.orderNumber });
    expect(Number(res.body.mergedOrder.totalAmount)).toBe(20000 + 7000 + 5000);

    const stored = await db.Order.findByPk(order.id);
    expect(Number(stored.subtotalAmount)).toBe(27000);
    expect(Number(stored.shippingAmount)).toBe(5000);
    expect(Number(stored.totalAmount)).toBe(32000);
    const items = await db.OrderItem.findAll({ where: { orderId: order.id } });
    expect(items).toHaveLength(2);
    const upsell = items.find((i) => i.isUpsell);
    expect(upsell.offerId).toBe(ctx.upsellOffer.id);
    expect(Number(upsell.unitPriceAmount)).toBe(7000);
    expect(await db.Order.count({ where: { workspaceId: ctx.ws } })).toBe(1);
    expect(await reserved(ctx.addOn.variant.id)).toBe(1);

    // The invoice follows the order; the thank-you page closed the window.
    const invoice = await db.Invoice.findOne({ where: { orderId: order.id } });
    expect(Number(invoice.totalAmount)).toBe(32000);
    expect(invoice.lineItems).toHaveLength(2);
    expect(await db.Invoice.count({ where: { orderId: order.id } })).toBe(1);

    // One task, the final total, and the courier collects exactly that.
    const t = await task(order.id);
    expect(new Date(t.availableAt) <= new Date()).toBe(true);
    expect(await db.ConfirmationTask.count({ where: { orderId: order.id } })).toBe(1);
    const confirmed = await ctx.api('post', `/orders/${order.id}/confirmation`).send({});
    expect(confirmed.status).toBe(200);
    const waybill = await computeWaybillModel(ctx.ws, order.id);
    expect(Number(waybill.amountToCollect)).toBe(32000);

    const detail = await ctx.api('get', `/orders/${order.id}`);
    expect(detail.body.order.items.filter((i) => i.isUpsell)).toHaveLength(1);

    // Funnel analytics still count the accepted offer and its amount.
    const stats = await ctx.api('get', `/analytics/funnels/${ctx.funnel.id}`);
    expect(stats.status).toBe(200);
    expect(stats.body.upsellOrders).toBe(1);
    expect(stats.body.upsellRevenue).toBe(7000);
    expect(stats.body.revenue).toBe(32000);
  });

  it('reaches free shipping when the upsell lifts the subtotal over the threshold', async () => {
    const ctx = await setup();
    await ctx.api('patch', '').send({ settings: { default_shipping_rate_amount: 5000, free_shipping_threshold_amount: 25000 } });
    const order = await checkout(ctx);
    expect(Number(order.shippingAmount)).toBe(5000);
    const sid = await session(ctx, order.id);
    await advance(ctx, sid, 'upsell', { type: 'accepted_offer' });
    const stored = await db.Order.findByPk(order.id);
    expect(Number(stored.subtotalAmount)).toBe(27000);
    expect(Number(stored.shippingAmount)).toBe(0);
    expect(Number(stored.totalAmount)).toBe(27000);
    expect(stored.shippingSnapshot.rule).toBe('free_threshold');
  });

  it('keeps what the order was placed with in its shipping record', async () => {
    const ctx = await setup();
    await ctx.api('patch', '').send({ settings: { default_shipping_rate_amount: 5000, free_shipping_threshold_amount: 25000 } });
    const order = await checkout(ctx);
    const placedWith = {
      option: { key: 'express', name: 'Express', amount: 5000 },
      zone: { id: 'zone-1', name: 'Nasr City', feeAmount: 0, etaMinutes: 40 },
      etaMinutes: 40,
      holiday: { shipsFrom: '2026-11-01T00:00:00.000Z', message: 'Back soon' },
    };
    const row = await db.Order.findByPk(order.id);
    await row.update({ shippingSnapshot: { ...row.shippingSnapshot, ...placedWith } });

    const sid = await session(ctx, order.id);
    await advance(ctx, sid, 'upsell', { type: 'accepted_offer' });
    const stored = await db.Order.findByPk(order.id);
    expect(stored.shippingSnapshot).toMatchObject(placedWith);
    // What the new line changed is recorded over it.
    expect(stored.shippingSnapshot.rule).toBe('free_threshold');
  });

  it('keeps free shipping a code granted on the record, for the change after this one', async () => {
    const ctx = await setup();
    await ctx.api('patch', '').send({ settings: { default_shipping_rate_amount: 5000 } });
    const order = await checkout(ctx);
    const row = await db.Order.findByPk(order.id);
    await row.update({ shippingSnapshot: { ...row.shippingSnapshot, freeShippingGranted: true } });

    const sid = await session(ctx, order.id);
    await advance(ctx, sid, 'upsell', { type: 'accepted_offer' });
    const stored = await db.Order.findByPk(order.id);
    expect(stored.shippingSnapshot.freeShippingGranted).toBe(true);
  });

  it('moves the parcel to the next weight tier', async () => {
    const ctx = await setup();
    const tiers = (await ctx.api('put', '/shipping/weight-tiers').send({ tiers: [{ upToGrams: 1000 }, { upToGrams: 3000 }] })).body.tiers;
    const zone = (await ctx.api('post', '/shipping/zones').send({ name: 'Egypt', countries: ['EG'] })).body.zone;
    await ctx
      .api('put', `/shipping/zones/${zone.id}/tier-prices`)
      .send({ prices: [{ tierId: tiers[0].id, amount: 3000 }, { tierId: tiers[1].id, amount: 5000 }] });
    await ctx.api('post', '/shipping/pricing-mode').send({ mode: 'weight_tiers', defaultItemWeightGrams: 500, prefill: false });
    await ctx.api('patch', `/catalog/variants/${ctx.variant.id}`).send({ weightGrams: 800 });
    await ctx.api('patch', `/catalog/variants/${ctx.addOn.variant.id}`).send({ weightGrams: 600 });

    const order = await checkout(ctx);
    expect(Number(order.shippingAmount)).toBe(3000);
    const sid = await session(ctx, order.id);
    await advance(ctx, sid, 'upsell', { type: 'accepted_offer' });
    const stored = await db.Order.findByPk(order.id);
    expect(stored.totalWeightGrams).toBe(1400);
    expect(Number(stored.shippingAmount)).toBe(5000);
    expect(Number(stored.totalAmount)).toBe(20000 + 7000 + 5000);
  });

  it('applies the order discount to the new subtotal', async () => {
    const ctx = await setup();
    await db.Discount.create({
      workspaceId: ctx.ws,
      code: 'TEN',
      type: 'percentage',
      value: 1000,
      status: 'active',
      productRestrictions: [],
      collectionRestrictions: [],
      customerRestrictions: [],
      funnelRestrictions: [],
    });
    const order = await checkout(ctx, { discountCode: 'TEN' });
    expect(Number(order.discountAmount)).toBe(2000);
    const sid = await session(ctx, order.id);
    await advance(ctx, sid, 'upsell', { type: 'accepted_offer' });
    const stored = await db.Order.findByPk(order.id);
    expect(Number(stored.discountAmount)).toBe(2700);
    expect(stored.discountsSnapshot[0].amount).toBe(2700);
    expect(Number(stored.totalAmount)).toBe(27000 - 2700 + Number(stored.shippingAmount) + Number(stored.taxAmount));
    const redemption = await db.DiscountRedemption.findOne({ where: { orderId: order.id } });
    expect(Number(redemption.amountAllocated)).toBe(2700);
    expect(await db.DiscountRedemption.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('merges a downsell accepted after the upsell was declined', async () => {
    const ctx = await setup();
    const order = await checkout(ctx);
    const sid = await session(ctx, order.id);
    await advance(ctx, sid, 'upsell', { type: 'declined_offer' });
    const res = await advance(ctx, sid, 'downsell', { type: 'accepted_offer' });
    expect(res.status).toBe(200);
    const items = await db.OrderItem.findAll({ where: { orderId: order.id } });
    expect(items.map((i) => [i.isUpsell, i.offerId])).toEqual(expect.arrayContaining([[true, ctx.downsellOffer.id]]));
    expect(Number((await db.Order.findByPk(order.id)).subtotalAmount)).toBe(25000);
  });

  it('adds the line once for two simultaneous taps, and once per step across sessions', async () => {
    const ctx = await setup();
    const order = await checkout(ctx);
    const sid = await session(ctx, order.id);

    const [a, b] = await Promise.all([
      advance(ctx, sid, 'upsell', { type: 'accepted_offer' }),
      advance(ctx, sid, 'upsell', { type: 'accepted_offer' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await db.OrderItem.count({ where: { orderId: order.id, isUpsell: true } })).toBe(1);

    // A second session reporting the same order and accepting the same step.
    await db.ConfirmationTask.update({ availableAt: new Date(Date.now() + 600000) }, { where: { orderId: order.id } });
    const sid2 = await session(ctx, order.id);
    const again = await advance(ctx, sid2, 'upsell', { type: 'accepted_offer' });
    expect(again.status).toBe(200);
    expect(again.body.mergedOrder.id).toBe(order.id);
    expect(await db.OrderItem.count({ where: { orderId: order.id, isUpsell: true } })).toBe(1);
    expect(await db.FunnelOfferAcceptance.count({ where: { orderId: order.id } })).toBe(1);
    expect(await reserved(ctx.addOn.variant.id)).toBe(1);
  });

  it('refuses a sold-out upsell and leaves the order and session as they were', async () => {
    const ctx = await setup({ upsellStock: 0 });
    const order = await checkout(ctx);
    const sid = await session(ctx, order.id);
    const res = await advance(ctx, sid, 'upsell', { type: 'accepted_offer' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await db.OrderItem.count({ where: { orderId: order.id } })).toBe(1);
    expect(Number((await db.Order.findByPk(order.id)).totalAmount)).toBe(Number(order.totalAmount));
    expect((await db.FunnelSession.findByPk(sid)).currentStepKey).toBe('upsell');
    expect(await db.FunnelOfferAcceptance.count()).toBe(0);
  });
});

describe('funnel offer fallback', () => {
  it('places a late upsell as its own linked order with free shipping, noted on the original', async () => {
    const ctx = await setup();
    await ctx.api('patch', '').send({ settings: { default_shipping_rate_amount: 5000 } });
    const order = await checkout(ctx);
    const sid = await session(ctx, order.id);
    // The window timed out while the shopper looked at the offer.
    await db.ConfirmationTask.update({ availableAt: new Date(Date.now() - 1000) }, { where: { orderId: order.id } });

    const res = await advance(ctx, sid, 'upsell', { type: 'accepted_offer' });
    expect(res.status).toBe(200);
    expect(res.body.mergedOrder).toBeUndefined();
    expect(res.body.followOnOrder.linkedFromOrderId).toBe(order.id);
    const followOn = await db.Order.findByPk(res.body.followOnOrder.id);
    expect(Number(followOn.shippingAmount)).toBe(0);
    expect(Number(followOn.totalAmount)).toBe(7000);
    expect(followOn.linkedFromOrderId).toBe(order.id);
    // The original is untouched and names its linked order.
    expect(Number((await db.Order.findByPk(order.id)).totalAmount)).toBe(25000);
    const detail = await ctx.api('get', `/orders/${order.id}`);
    expect(detail.body.order.linkedOrders.map((o) => o.id)).toEqual([followOn.id]);
    const acceptance = await db.FunnelOfferAcceptance.findOne({ where: { orderId: order.id } });
    expect(acceptance.result).toBe('separate');
  });

  it('falls back when staff confirmed the order in the meantime', async () => {
    const ctx = await setup();
    const order = await checkout(ctx);
    const sid = await session(ctx, order.id);
    await db.ConfirmationTask.update({ availableAt: new Date(Date.now() - 1000) }, { where: { orderId: order.id } });
    expect((await ctx.api('post', `/orders/${order.id}/confirmation`).send({})).status).toBe(200);

    const res = await advance(ctx, sid, 'upsell', { type: 'accepted_offer' });
    expect(res.status).toBe(200);
    expect(res.body.followOnOrder).toBeDefined();
    expect(await db.OrderItem.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('keeps the old behaviour exactly with the flag off', async () => {
    const ctx = await setup({ merge: false });
    await ctx.api('patch', '').send({ settings: { default_shipping_rate_amount: 5000 } });
    const order = await checkout(ctx);
    expect((await task(order.id)).availableAt).toBeNull();
    const sid = await session(ctx, order.id);
    const res = await advance(ctx, sid, 'upsell', { type: 'accepted_offer' });
    expect(res.status).toBe(200);
    expect(res.body.mergedOrder).toBeUndefined();
    const followOn = await db.Order.findByPk(res.body.followOnOrder.id);
    // Charged shipping like any order, as before.
    expect(Number(followOn.shippingAmount)).toBe(5000);
    expect(await db.FunnelOfferAcceptance.count()).toBe(0);
    expect(await db.OrderItem.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('gives back the joined upsell with the order when the order is cancelled', async () => {
    const ctx = await setup();
    const before = { main: await reserved(ctx.variant.id), addOn: await reserved(ctx.addOn.variant.id) };
    const order = await checkout(ctx);
    const sid = await session(ctx, order.id);
    expect((await advance(ctx, sid, 'upsell', { type: 'accepted_offer' })).status).toBe(200);
    expect(await reserved(ctx.addOn.variant.id)).toBe(before.addOn + 1);

    const res = await ctx.api('post', `/orders/${order.id}/cancel`).send({ reason: 'Changed their mind' });
    expect(res.status).toBe(200);
    expect(await reserved(ctx.variant.id)).toBe(before.main);
    expect(await reserved(ctx.addOn.variant.id)).toBe(before.addOn);
    const released = await db.InventoryMovement.findAll({ where: { referenceId: order.id, type: 'release' } });
    expect(released.map((m) => [m.variantId, m.reservedDelta]).sort()).toEqual(
      [
        [ctx.variant.id, -1],
        [ctx.addOn.variant.id, -1],
      ].sort()
    );
  });
});
