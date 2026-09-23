'use strict';

// Storefront fraud rules (settings.fraud_rules, evaluated in
// orderService.createOrder), the flagged-orders review queue and the
// phone blocklist under /workspaces/:id/fraud.

const {
  app,
  request,
  registerAndActivate,
  createWorkspace,
  createProductWithVariant,
  setupWorkspaceWithProduct,
} = require('../helpers/factories');
const db = require('../../src/db/models');
const { REJECTION_MESSAGE } = require('../../src/modules/fraud/fraudRules');
const { normalizePhone } = require('../../src/core/utils/phone');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const key = () => `fr-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const PHONE = '01077770001';
const contact = (phone = PHONE) => ({ fullName: 'Fraud Test Buyer', phone });
const address = { country: 'EG', city: 'Cairo', addressLine: '1 Rule St' };

function storefrontOrder(workspaceId, variantId, { phone = PHONE, quantity = 1 } = {}) {
  return request(app)
    .post(`/api/v1/store/${workspaceId}/checkout`)
    .set('Idempotency-Key', key())
    .send({ item: { variantId, quantity }, contact: contact(phone), shippingAddress: address, paymentMethod: 'cod' });
}

function staffOrder(ctx, variantId, { phone = PHONE } = {}) {
  return request(app)
    .post(`/api/v1/workspaces/${ctx.workspace.id}/orders`)
    .set(bearer(ctx.auth.accessToken))
    .set('Idempotency-Key', key())
    .send({ items: [{ variantId, quantity: 1 }], contact: contact(phone), shippingAddress: address, paymentMethod: 'cod' });
}

function patchSettings(ctx, settings) {
  return request(app)
    .patch(`/api/v1/workspaces/${ctx.workspace.id}`)
    .set(bearer(ctx.auth.accessToken))
    .send({ settings });
}

async function setRules(ctx, fraudRules) {
  const res = await patchSettings(ctx, { fraud_rules: fraudRules });
  if (res.status !== 200) throw new Error(`setRules failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.workspace.settings.fraud_rules;
}

const reserved = async (variantId) => (await db.ProductVariant.findByPk(variantId)).reservedStock;
const customerByPhone = (workspaceId, phone = PHONE) =>
  db.Customer.findOne({ where: { workspaceId, phoneNormalized: `20${phone.slice(1)}` } });

function expectRefused(res) {
  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe('ORDER_REJECTED');
  expect(res.body.error.message).toBe(REJECTION_MESSAGE);
  // Nothing in the response names a rule or hints at fraud screening.
  expect(JSON.stringify(res.body)).not.toMatch(/duplicate|limit|rejection_|blacklist|fraud|flag/i);
}

describe('fraud rules — unset', () => {
  it('leaves storefront orders exactly as before: no new flags, nothing refused', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 20 });

    const first = await storefrontOrder(ctx.workspace.id, ctx.variant.id);
    const second = await storefrontOrder(ctx.workspace.id, ctx.variant.id);
    const third = await storefrontOrder(ctx.workspace.id, ctx.variant.id);

    for (const res of [first, second, third]) {
      expect(res.status).toBe(201);
      expect(res.body.order.riskFlags).toEqual([]);
    }
  });
});

describe('fraud rules — duplicate_order', () => {
  it("flags a repeat of the same variant inside the window in 'flag' mode", async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 20 });
    await setRules(ctx, { duplicate_window_minutes: 60 });

    const first = await storefrontOrder(ctx.workspace.id, ctx.variant.id);
    expect(first.body.order.riskFlags).toEqual([]);

    const repeat = await storefrontOrder(ctx.workspace.id, ctx.variant.id);
    expect(repeat.status).toBe(201);
    expect(repeat.body.order.riskFlags).toEqual(['duplicate_order']);

    // Flagged orders still enter the COD confirmation queue.
    expect(await db.ConfirmationTask.count({ where: { orderId: repeat.body.order.id } })).toBe(1);
  });

  it('does not flag a different variant, another phone, a cancelled order, or an order outside the window', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 20 });
    const { variant: other } = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id, { stock: 20 });
    await setRules(ctx, { duplicate_window_minutes: 30 });

    const first = await storefrontOrder(ctx.workspace.id, ctx.variant.id);
    expect((await storefrontOrder(ctx.workspace.id, other.id)).body.order.riskFlags).toEqual([]);
    expect((await storefrontOrder(ctx.workspace.id, ctx.variant.id, { phone: '01077770002' })).body.order.riskFlags).toEqual([]);

    // Cancelled: the earlier order no longer counts.
    await db.Order.update({ cancelledAt: new Date() }, { where: { workspaceId: ctx.workspace.id } });
    expect((await storefrontOrder(ctx.workspace.id, ctx.variant.id)).body.order.riskFlags).toEqual([]);

    // Outside the window: age every order past 30 minutes.
    await db.sequelize.query(
      "UPDATE orders SET cancelled_at = NULL, created_at = created_at - interval '31 minutes' WHERE workspace_id = $ws",
      { bind: { ws: ctx.workspace.id } }
    );
    expect(first.status).toBe(201);
    expect((await storefrontOrder(ctx.workspace.id, ctx.variant.id)).body.order.riskFlags).toEqual([]);
  });

  it("refuses the repeat in 'block' mode: 422, generic message, nothing reserved, audited", async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 20 });
    await setRules(ctx, { action: 'block', duplicate_window_minutes: 60 });

    expect((await storefrontOrder(ctx.workspace.id, ctx.variant.id)).status).toBe(201);
    const reservedBefore = await reserved(ctx.variant.id);

    const repeat = await storefrontOrder(ctx.workspace.id, ctx.variant.id, { quantity: 2 });
    expectRefused(repeat);
    expect(await reserved(ctx.variant.id)).toBe(reservedBefore);
    expect(await db.Order.count({ where: { workspaceId: ctx.workspace.id } })).toBe(1);

    const customer = await customerByPhone(ctx.workspace.id);
    expect(customer.totalOrders).toBe(1);
    const audit = await db.AuditLog.findOne({ where: { workspaceId: ctx.workspace.id, action: 'order.blocked' } });
    expect(audit).not.toBeNull();
    expect(audit.entityType).toBe('Customer');
    expect(audit.entityId).toBe(customer.id);
    expect(audit.actorUserId).toBeNull();
    expect(audit.afterState).toEqual({ flags: ['duplicate_order'] });
  });

  it('lets exactly one of two simultaneous identical submissions through', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 20 });
    await setRules(ctx, { action: 'block', duplicate_window_minutes: 60 });
    // The customer row must exist first; two brand-new phones racing is the
    // customer-creation path, not the rule's.
    await db.Customer.create({ workspaceId: ctx.workspace.id, phoneNormalized: '201077770001', phoneRaw: PHONE, fullName: 'Fraud Test Buyer' });

    const results = await Promise.all([
      storefrontOrder(ctx.workspace.id, ctx.variant.id),
      storefrontOrder(ctx.workspace.id, ctx.variant.id),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(await db.Order.count({ where: { workspaceId: ctx.workspace.id } })).toBe(1);
    expect(await reserved(ctx.variant.id)).toBe(1);
  });
});

describe('fraud rules — phone_daily_limit', () => {
  it('flags the order that would exceed the daily limit', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 20 });
    await setRules(ctx, { max_orders_per_phone_per_day: 2 });

    expect((await storefrontOrder(ctx.workspace.id, ctx.variant.id)).body.order.riskFlags).toEqual([]);
    expect((await storefrontOrder(ctx.workspace.id, ctx.variant.id)).body.order.riskFlags).toEqual([]);
    const third = await storefrontOrder(ctx.workspace.id, ctx.variant.id);
    expect(third.status).toBe(201);
    expect(third.body.order.riskFlags).toEqual(['phone_daily_limit']);
  });

  it("refuses it in 'block' mode", async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 20 });
    await setRules(ctx, { action: 'block', max_orders_per_phone_per_day: 1 });

    expect((await storefrontOrder(ctx.workspace.id, ctx.variant.id)).status).toBe(201);
    const reservedBefore = await reserved(ctx.variant.id);
    expectRefused(await storefrontOrder(ctx.workspace.id, ctx.variant.id));
    expect(await reserved(ctx.variant.id)).toBe(reservedBefore);

    // Yesterday's orders no longer count.
    await db.sequelize.query("UPDATE orders SET created_at = created_at - interval '25 hours' WHERE workspace_id = $ws", {
      bind: { ws: ctx.workspace.id },
    });
    expect((await storefrontOrder(ctx.workspace.id, ctx.variant.id)).status).toBe(201);
  });
});

describe('fraud rules — high_rejection_customer', () => {
  it("flags a customer at the threshold in 'flag' mode and refuses in 'block' mode", async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 20 });
    await setRules(ctx, { high_rejection_threshold: 3 });

    expect((await storefrontOrder(ctx.workspace.id, ctx.variant.id)).body.order.riskFlags).toEqual([]);
    const customer = await customerByPhone(ctx.workspace.id);
    await customer.update({ totalRejectedOrders: 2 });
    expect((await storefrontOrder(ctx.workspace.id, ctx.variant.id)).body.order.riskFlags).toEqual([]);

    await customer.update({ totalRejectedOrders: 3 });
    const flagged = await storefrontOrder(ctx.workspace.id, ctx.variant.id);
    expect(flagged.body.order.riskFlags).toEqual(['high_rejection_customer']);

    await setRules(ctx, { action: 'block' });
    const reservedBefore = await reserved(ctx.variant.id);
    expectRefused(await storefrontOrder(ctx.workspace.id, ctx.variant.id));
    expect(await reserved(ctx.variant.id)).toBe(reservedBefore);
  });
});

describe('fraud rules — blacklisted customers', () => {
  async function blacklistedCtx() {
    const ctx = await setupWorkspaceWithProduct({ stock: 20 });
    expect((await storefrontOrder(ctx.workspace.id, ctx.variant.id)).status).toBe(201);
    await (await customerByPhone(ctx.workspace.id)).update({ isBlacklisted: true, blacklistReason: 'test' });
    return ctx;
  }

  it('without block_blacklisted, only adds the existing blacklisted_customer flag', async () => {
    const ctx = await blacklistedCtx();
    await setRules(ctx, { duplicate_window_minutes: 60 });

    const res = await storefrontOrder(ctx.workspace.id, ctx.variant.id);
    expect(res.status).toBe(201);
    expect(res.body.order.riskFlags).toEqual(['blacklisted_customer', 'duplicate_order']);
  });

  it("block_blacklisted refuses a blacklisted phone even with action 'flag'", async () => {
    const ctx = await blacklistedCtx();
    await setRules(ctx, { action: 'flag', block_blacklisted: true });
    const reservedBefore = await reserved(ctx.variant.id);

    expectRefused(await storefrontOrder(ctx.workspace.id, ctx.variant.id));
    expect(await reserved(ctx.variant.id)).toBe(reservedBefore);
    const audit = await db.AuditLog.findOne({ where: { workspaceId: ctx.workspace.id, action: 'order.blocked' } });
    expect(audit.afterState).toEqual({ flags: ['blacklisted_customer'] });

    // Someone else still gets through.
    expect((await storefrontOrder(ctx.workspace.id, ctx.variant.id, { phone: '01077770009' })).status).toBe(201);
  });
});

describe('fraud rules — scope', () => {
  it('never evaluates or refuses a staff-created order', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 20 });
    await setRules(ctx, {
      action: 'block',
      block_blacklisted: true,
      duplicate_window_minutes: 60,
      max_orders_per_phone_per_day: 1,
      high_rejection_threshold: 1,
    });

    expect((await staffOrder(ctx, ctx.variant.id)).status).toBe(201);
    await (await customerByPhone(ctx.workspace.id)).update({
      isBlacklisted: true,
      blacklistReason: 'test',
      totalRejectedOrders: 5,
    });

    const res = await staffOrder(ctx, ctx.variant.id);
    expect(res.status).toBe(201);
    expect(res.body.order.riskFlags).toEqual(['blacklisted_customer']);
    expect(await db.AuditLog.count({ where: { workspaceId: ctx.workspace.id, action: 'order.blocked' } })).toBe(0);
  });

  it('exempts a funnel follow-on (upsell) of the same variant inside the window', async () => {
    const auth = await registerAndActivate();
    const workspace = await createWorkspace(auth.accessToken, 'Upsell Fraud Co');
    const ctx = { auth, workspace };
    const H = bearer(auth.accessToken);
    const base = `/api/v1/workspaces/${workspace.id}/funnels`;
    const store = `/api/v1/store/${workspace.id}/funnels`;

    const { product, variant } = await createProductWithVariant(auth.accessToken, workspace.id, { price: 12000, stock: 20 });
    const offer = await db.Offer.create({
      workspaceId: workspace.id,
      productId: product.id,
      name: 'Same Variant Upsell',
      pricingMode: 'fixed',
      priceAmount: 6000,
      currency: 'EGP',
      status: 'active',
    });
    await db.OfferVariant.create({ offerId: offer.id, variantId: variant.id, quantity: 1 });

    const builderData = {
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
    const funnel = (await request(app).post(base).set(H).send({ name: 'Upsell Funnel' })).body.funnel;
    await request(app).post(`${base}/${funnel.id}/steps`).set(H).send({ key: 'checkout', stepType: 'checkout', name: 'C', builderData });
    await request(app)
      .post(`${base}/${funnel.id}/steps`)
      .set(H)
      .send({ key: 'upsell', stepType: 'upsell', name: 'U', builderData, offerId: offer.id });
    await request(app).post(`${base}/${funnel.id}/steps`).set(H).send({ key: 'win', stepType: 'thank_you', name: 'W', builderData });
    await request(app).post(`${base}/${funnel.id}/edges`).set(H).send({ fromStepKey: 'checkout', toStepKey: 'upsell', condition: { type: 'always' } });
    await request(app).post(`${base}/${funnel.id}/edges`).set(H).send({ fromStepKey: 'upsell', toStepKey: 'win', condition: { type: 'accepted_offer' } });
    const pub = await request(app).post(`${base}/${funnel.id}/publish`).set(H).send({});
    expect(pub.status).toBe(201);

    await setRules(ctx, { action: 'block', duplicate_window_minutes: 60, max_orders_per_phone_per_day: 1 });

    const original = await storefrontOrder(workspace.id, variant.id);
    expect(original.status).toBe(201);

    const sid = (await request(app).post(`${store}/${funnel.id}/sessions`).send({ visitorId: 'fraud-upsell' })).body.session.id;
    await request(app)
      .post(`${store}/${funnel.id}/sessions/${sid}/advance`)
      .send({ outcome: { type: 'completed_checkout', orderId: original.body.order.id } });
    const accepted = await request(app)
      .post(`${store}/${funnel.id}/sessions/${sid}/advance`)
      .send({ fromStepKey: 'upsell', outcome: { type: 'accepted_offer' } });

    expect(accepted.status).toBe(200);
    const followOn = await db.Order.findByPk(accepted.body.followOnOrder.id);
    expect(followOn.linkedFromOrderId).toBe(original.body.order.id);
    expect(followOn.riskFlags).toEqual([]);
  });
});

describe('fraud_rules setting', () => {
  it('refuses out-of-range values with 422', async () => {
    const ctx = await setupWorkspaceWithProduct();
    for (const bad of [
      { action: 'deny' },
      { block_blacklisted: 'yes' },
      { duplicate_window_minutes: 0 },
      { duplicate_window_minutes: 10081 },
      { duplicate_window_minutes: 1.5 },
      { max_orders_per_phone_per_day: 0 },
      { max_orders_per_phone_per_day: 101 },
      { high_rejection_threshold: 0 },
      { high_rejection_threshold: 101 },
    ]) {
      const res = await patchSettings(ctx, { fraud_rules: bad });
      expect(res.status).toBe(422);
    }
    const edges = await patchSettings(ctx, {
      fraud_rules: { duplicate_window_minutes: 10080, max_orders_per_phone_per_day: 100, high_rejection_threshold: 100 },
    });
    expect(edges.status).toBe(200);
  });

  it('merges sub-keys, clears a sub-key with null, and clears the whole object with null', async () => {
    const ctx = await setupWorkspaceWithProduct();
    await patchSettings(ctx, { checkout_settings: { email: 'required' } });

    expect(await setRules(ctx, { action: 'block', duplicate_window_minutes: 30 })).toEqual({
      action: 'block',
      duplicate_window_minutes: 30,
    });
    expect(await setRules(ctx, { high_rejection_threshold: 4, block_blacklisted: false })).toEqual({
      action: 'block',
      duplicate_window_minutes: 30,
      high_rejection_threshold: 4,
      block_blacklisted: false,
    });
    expect(await setRules(ctx, { duplicate_window_minutes: null })).toEqual({
      action: 'block',
      high_rejection_threshold: 4,
      block_blacklisted: false,
    });

    const cleared = await patchSettings(ctx, { fraud_rules: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.workspace.settings.fraud_rules).toBeUndefined();
    // Sibling settings are untouched throughout.
    expect(cleared.body.workspace.settings.checkout_settings).toEqual({ email: 'required' });
  });

  it('takes workspace.manage: an Editor is refused (nothing written), the owner is not', async () => {
    const ctx = await setupWorkspaceWithProduct();
    await setRules(ctx, { action: 'block', duplicate_window_minutes: 30 });

    const editor = await registerAndActivate();
    const role = await db.Role.findOne({ where: { workspaceId: ctx.workspace.id, key: 'editor' } });
    const invite = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/members`)
      .set(bearer(ctx.auth.accessToken))
      .send({ email: editor.email, roleId: role.id });
    expect(invite.status).toBe(201);
    const asEditor = { ...ctx, auth: editor };
    const stored = async () => (await db.Workspace.findByPk(ctx.workspace.id)).settings;

    for (const fraudRules of [{ duplicate_window_minutes: 5 }, null]) {
      // A sibling key in the same request is not written either.
      const res = await patchSettings(asEditor, { fraud_rules: fraudRules, checkout_settings: { email: 'hidden' } });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      const settings = await stored();
      expect(settings.fraud_rules).toEqual({ action: 'block', duplicate_window_minutes: 30 });
      expect(settings.checkout_settings).toBeUndefined();
    }

    const checkout = await patchSettings(asEditor, { checkout_settings: { email: 'required' } });
    expect(checkout.status).toBe(200);
    expect(checkout.body.workspace.settings.checkout_settings).toEqual({ email: 'required' });
    expect(checkout.body.workspace.settings.fraud_rules).toEqual({ action: 'block', duplicate_window_minutes: 30 });

    expect(await setRules(ctx, { duplicate_window_minutes: 5 })).toEqual({ action: 'block', duplicate_window_minutes: 5 });
  });
});

describe('GET /fraud/flagged-orders', () => {
  const list = (ctx, query = '') =>
    request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/fraud/flagged-orders${query}`).set(bearer(ctx.auth.accessToken));

  // Five storefront orders from one phone with the daily limit at 1: the
  // first is clean, the next four are flagged phone_daily_limit.
  async function flaggedCtx() {
    const ctx = await setupWorkspaceWithProduct({ stock: 50 });
    await setRules(ctx, { max_orders_per_phone_per_day: 1 });
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push((await storefrontOrder(ctx.workspace.id, ctx.variant.id)).body.order.id);
    // Distinct, known created_at values so newest-first is unambiguous.
    for (let i = 0; i < ids.length; i += 1) {
      await db.sequelize.query(`UPDATE orders SET created_at = now() - make_interval(mins => $m) WHERE id = $id`, {
        bind: { id: ids[i], m: 100 - i },
      });
    }
    return { ctx, clean: ids[0], flagged: ids.slice(1).reverse() }; // flagged: newest first
  }

  it('returns open flagged orders newest first in the documented shape', async () => {
    const { ctx, flagged, clean } = await flaggedCtx();

    const res = await list(ctx);
    expect(res.status).toBe(200);
    expect(res.body.orders.map((o) => o.id)).toEqual(flagged);
    expect(res.body.orders.map((o) => o.id)).not.toContain(clean);
    expect(res.body.nextCursor).toBeNull();

    const order = await db.Order.findByPk(flagged[0]);
    expect(res.body.orders[0]).toEqual({
      id: order.id,
      orderNumber: order.orderNumber,
      createdAt: order.createdAt.toISOString(),
      riskFlags: ['phone_daily_limit'],
      customerName: 'Fraud Test Buyer',
      phone: PHONE,
      totalAmount: Number(order.totalAmount),
      currency: order.currency,
      confirmationState: 'pending',
      cancelled: false,
    });
    expect(typeof res.body.orders[0].totalAmount).toBe('number');
  });

  it('hides resolved orders unless includeResolved=true', async () => {
    const { ctx, flagged } = await flaggedCtx();
    const [cancelled, confirmed, unreachable] = flagged;
    await db.Order.update({ cancelledAt: new Date() }, { where: { id: cancelled } });
    await db.Order.update({ confirmationState: 'confirmed' }, { where: { id: confirmed } });
    await db.Order.update({ confirmationState: 'unreachable' }, { where: { id: unreachable } });

    const open = await list(ctx);
    // needs_follow_up (unreachable) is still open; confirmed and cancelled are not.
    expect(open.body.orders.map((o) => o.id)).toEqual([unreachable, flagged[3]]);

    const all = await list(ctx, '?includeResolved=true');
    expect(all.body.orders.map((o) => o.id)).toEqual(flagged);
    expect(all.body.orders.find((o) => o.id === cancelled).cancelled).toBe(true);
    expect(all.body.orders.find((o) => o.id === confirmed).cancelled).toBe(false);
  });

  it('pages with before = the previous nextCursor (an order id)', async () => {
    const { ctx, flagged } = await flaggedCtx();

    const first = await list(ctx, '?limit=3');
    expect(first.body.orders.map((o) => o.id)).toEqual(flagged.slice(0, 3));
    expect(first.body.nextCursor).toBe(flagged[2]);

    const second = await list(ctx, `?limit=3&before=${first.body.nextCursor}`);
    expect(second.body.orders.map((o) => o.id)).toEqual(flagged.slice(3));
    expect(second.body.nextCursor).toBeNull();
  });

  it('rejects a bad cursor and bad limits with 422', async () => {
    const { ctx } = await flaggedCtx();
    const other = await setupWorkspaceWithProduct();
    const foreign = (await storefrontOrder(other.workspace.id, other.variant.id)).body.order.id;

    for (const query of [
      '?before=not-a-uuid',
      '?before=00000000-0000-4000-8000-000000000000',
      `?before=${foreign}`,
      '?limit=0',
      '?limit=101',
    ]) {
      const res = await list(ctx, query);
      expect(res.status).toBe(422);
    }
  });

  it("never shows another workspace's flagged orders", async () => {
    const { ctx } = await flaggedCtx();
    const other = await setupWorkspaceWithProduct();

    expect((await list(other)).body.orders).toEqual([]);
    expect((await list(other, '?includeResolved=true')).body.orders).toEqual([]);
    // And a member of one cannot read the other's list at all.
    const cross = await request(app)
      .get(`/api/v1/workspaces/${ctx.workspace.id}/fraud/flagged-orders`)
      .set(bearer(other.auth.accessToken));
    expect(cross.status).toBe(404);
  });
});

describe('POST /fraud/flagged-orders/:orderId/approve', () => {
  const approve = (ctx, orderId) =>
    request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/fraud/flagged-orders/${orderId}/approve`)
      .set(bearer(ctx.auth.accessToken));

  async function oneFlagged() {
    const ctx = await setupWorkspaceWithProduct({ stock: 20 });
    await setRules(ctx, { duplicate_window_minutes: 60, max_orders_per_phone_per_day: 1 });
    await storefrontOrder(ctx.workspace.id, ctx.variant.id);
    const order = (await storefrontOrder(ctx.workspace.id, ctx.variant.id)).body.order;
    expect(order.riskFlags).toEqual(['duplicate_order', 'phone_daily_limit']);
    return { ctx, order };
  }

  it('clears the flags, audits the old ones, and leaves the order state alone', async () => {
    const { ctx, order } = await oneFlagged();

    const res = await approve(ctx, order.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ order: { id: order.id, riskFlags: [] } });

    const after = await db.Order.findByPk(order.id);
    expect(after.riskFlags).toEqual([]);
    expect(after.confirmationState).toBe(order.confirmationState);
    expect(after.financialState).toBe(order.financialState);
    expect(after.fulfillmentState).toBe(order.fulfillmentState);
    expect(await db.ConfirmationTask.count({ where: { orderId: order.id, status: 'queued' } })).toBe(1);

    const audit = await db.AuditLog.findOne({ where: { action: 'order.risk_approved', entityId: order.id } });
    expect(audit.beforeState).toEqual({ riskFlags: ['duplicate_order', 'phone_daily_limit'] });
    expect(audit.afterState).toEqual({ riskFlags: [] });
    expect(audit.actorUserId).toBe(ctx.auth.userId);

    // Gone from the queue.
    const listed = await request(app)
      .get(`/api/v1/workspaces/${ctx.workspace.id}/fraud/flagged-orders?includeResolved=true`)
      .set(bearer(ctx.auth.accessToken));
    expect(listed.body.orders).toEqual([]);
  });

  it('is idempotent: a second approve is a 200 no-op with no second audit row', async () => {
    const { ctx, order } = await oneFlagged();

    expect((await approve(ctx, order.id)).status).toBe(200);
    const again = await approve(ctx, order.id);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ order: { id: order.id, riskFlags: [] } });
    expect(await db.AuditLog.count({ where: { action: 'order.risk_approved', entityId: order.id } })).toBe(1);
  });

  it('404s for an order in another workspace, and leaves it flagged', async () => {
    const { order } = await oneFlagged();
    const other = await setupWorkspaceWithProduct();

    const res = await approve(other, order.id);
    expect(res.status).toBe(404);
    expect((await db.Order.findByPk(order.id)).riskFlags).toEqual(['duplicate_order', 'phone_daily_limit']);
  });
});

describe('/fraud/blocklist', () => {
  const getList = (ctx, token = ctx.auth.accessToken) =>
    request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/fraud/blocklist`).set(bearer(token));
  const block = (ctx, body, token = ctx.auth.accessToken) =>
    request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/fraud/blocklist`).set(bearer(token)).send(body);

  it('blocks a phone that never ordered by creating its customer, then updates the reason on a repeat', async () => {
    const ctx = await setupWorkspaceWithProduct();

    const created = await block(ctx, { phone: '+20 100 555 0101', reason: 'Refused three parcels' });
    expect(created.status).toBe(201);
    const customer = await db.Customer.findOne({ where: { workspaceId: ctx.workspace.id, phoneNormalized: '201005550101' } });
    expect(customer).not.toBeNull();
    expect(customer.fullName).toBeNull();
    expect(customer.isBlacklisted).toBe(true);
    expect(customer.blacklistedAt).toBeInstanceOf(Date);
    expect(created.body).toEqual({
      entry: { customerId: customer.id, phone: '+20 100 555 0101', reason: 'Refused three parcels' },
    });
    const audit = await db.AuditLog.findOne({ where: { action: 'customer.blacklist_change', entityId: customer.id } });
    expect(audit.actorUserId).toBe(ctx.auth.userId);
    expect(audit.afterState).toMatchObject({ isBlacklisted: true, reason: 'Refused three parcels' });

    // Same phone, typed differently: same customer, reason updated, 200, and
    // blockedAt kept — the block did not start again.
    const firstBlockedAt = customer.blacklistedAt.getTime();
    const again = await block(ctx, { phone: '01005550101', reason: 'Updated reason', fullName: 'Known Name' });
    expect(again.status).toBe(200);
    expect(again.body.entry).toEqual({ customerId: customer.id, phone: '+20 100 555 0101', reason: 'Updated reason' });
    await customer.reload();
    expect(customer.blacklistReason).toBe('Updated reason');
    expect(customer.fullName).toBe('Known Name');
    expect(customer.blacklistedAt.getTime()).toBe(firstBlockedAt);
    expect(await db.Customer.count({ where: { workspaceId: ctx.workspace.id } })).toBe(1);

    // The next storefront order from that phone lands on the blocked customer.
    const order = await storefrontOrder(ctx.workspace.id, ctx.variant.id, { phone: '01005550101' });
    expect(order.body.order.customerId).toBe(customer.id);
    expect(order.body.order.riskFlags).toEqual(['blacklisted_customer']);
  });

  it('blocks an existing customer without creating another', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const order = (await storefrontOrder(ctx.workspace.id, ctx.variant.id)).body.order;

    const res = await block(ctx, { phone: PHONE, reason: 'Fake address' });
    expect(res.status).toBe(201);
    expect(res.body.entry.customerId).toBe(order.customerId);
    expect(await db.Customer.count({ where: { workspaceId: ctx.workspace.id } })).toBe(1);
  });

  it('validates the body: invalid phone is INVALID_PHONE, reason 2–300 chars', async () => {
    const ctx = await setupWorkspaceWithProduct();

    const badPhone = await block(ctx, { phone: 'no digits', reason: 'Some reason' });
    expect(badPhone.status).toBe(422);
    expect(badPhone.body.error.code).toBe('INVALID_PHONE');

    for (const body of [
      { reason: 'Missing phone' },
      { phone: PHONE },
      { phone: PHONE, reason: 'x' },
      { phone: PHONE, reason: 'x'.repeat(301) },
    ]) {
      expect((await block(ctx, body)).status).toBe(422);
    }
    expect(await db.Customer.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);
  });

  it('lists blacklisted customers newest blockedAt first; unblocking via PATCH removes the entry and clears blacklisted_at', async () => {
    const ctx = await setupWorkspaceWithProduct();
    await storefrontOrder(ctx.workspace.id, ctx.variant.id); // an unblocked customer, never listed
    await block(ctx, { phone: '01005550201', reason: 'First blocked', fullName: 'First' });
    const second = await block(ctx, { phone: '01005550202', reason: 'Second blocked' });
    await db.Customer.update(
      { blacklistedAt: new Date(Date.now() - 60_000) },
      { where: { workspaceId: ctx.workspace.id, phoneNormalized: '201005550201' } }
    );

    const res = await getList(ctx);
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e) => e.phone)).toEqual(['01005550202', '01005550201']);
    const stored = await db.Customer.findByPk(second.body.entry.customerId);
    expect(res.body.entries[0]).toEqual({
      customerId: stored.id,
      fullName: null,
      phone: '01005550202',
      reason: 'Second blocked',
      totalOrders: 0,
      totalRejectedOrders: 0,
      blockedAt: stored.blacklistedAt.toISOString(),
    });
    expect(res.body.entries[1].fullName).toBe('First');

    const unblock = await request(app)
      .patch(`/api/v1/workspaces/${ctx.workspace.id}/customers/${stored.id}/blacklist`)
      .set(bearer(ctx.auth.accessToken))
      .send({ isBlacklisted: false });
    expect(unblock.status).toBe(200);
    await stored.reload();
    expect(stored.isBlacklisted).toBe(false);
    expect(stored.blacklistReason).toBeNull();
    expect(stored.blacklistedAt).toBeNull();
    expect((await getList(ctx)).body.entries.map((e) => e.phone)).toEqual(['01005550201']);
  });

  it('the existing PATCH blacklist sets blacklisted_at too', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const order = (await storefrontOrder(ctx.workspace.id, ctx.variant.id)).body.order;

    const res = await request(app)
      .patch(`/api/v1/workspaces/${ctx.workspace.id}/customers/${order.customerId}/blacklist`)
      .set(bearer(ctx.auth.accessToken))
      .send({ isBlacklisted: true, reason: 'Via customer screen' });
    expect(res.status).toBe(200);
    expect((await db.Customer.findByPk(order.customerId)).blacklistedAt).toBeInstanceOf(Date);
    expect((await getList(ctx)).body.entries.map((e) => e.customerId)).toEqual([order.customerId]);
  });

  it('is workspace-scoped and permission-gated', async () => {
    const ctx = await setupWorkspaceWithProduct();
    await block(ctx, { phone: '01005550301', reason: 'Scoped' });

    const other = await setupWorkspaceWithProduct();
    expect((await getList(other)).body.entries).toEqual([]);

    // A Confirmation Agent has customers.view but not customers.manage.
    const agent = await registerAndActivate({ fullName: 'Agent' });
    const agentRole = await db.Role.findOne({ where: { workspaceId: ctx.workspace.id, key: 'confirmation_agent' } });
    await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/members`)
      .set(bearer(ctx.auth.accessToken))
      .send({ email: agent.email, roleId: agentRole.id })
      .expect(201);

    expect((await getList(ctx, agent.accessToken)).status).toBe(200);
    const denied = await block(ctx, { phone: '01005550302', reason: 'Not allowed' }, agent.accessToken);
    expect(denied.status).toBe(403);
    expect(await db.Customer.count({ where: { workspaceId: ctx.workspace.id, phoneNormalized: '201005550302' } })).toBe(0);
    // Approving a flagged order needs orders.manage, which the agent lacks too.
    const approve = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/fraud/flagged-orders/00000000-0000-4000-8000-000000000000/approve`)
      .set(bearer(agent.accessToken));
    expect(approve.status).toBe(403);
  });
});

describe('phone numbers too short to be real', () => {
  it('normalizes valid Egyptian formats exactly as before and refuses fewer than 8 digits', () => {
    for (const phone of ['01012345678', '+201012345678', '201012345678', '1012345678']) {
      expect(normalizePhone(phone)).toBe('201012345678');
    }
    for (const junk of ['no digits', '123', '+20 123', '1234567']) {
      expect(normalizePhone(junk)).toBeNull();
    }
  });

  it('storefront checkout answers 422 INVALID_PHONE and creates no customer', async () => {
    const ctx = await setupWorkspaceWithProduct();
    for (const phone of ['no digits', '123']) {
      const res = await storefrontOrder(ctx.workspace.id, ctx.variant.id, { phone });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INVALID_PHONE');
    }
    expect(await db.Customer.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);
    expect(await db.Order.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);
  });
});
