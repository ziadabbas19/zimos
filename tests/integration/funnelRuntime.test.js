'use strict';

// Public funnel runtime edge cases: a stale advance is refused rather than
// applied, reaching a terminal step completes the session, a republish that
// removes the step a visitor is standing on restarts them instead of dead-
// ending, and an accepted upsell's order commits with the advance or not at
// all.

const { app, request, registerAndActivate, createWorkspace, createProductWithVariant } = require('../helpers/factories');
const db = require('../../src/db/models');
const crypto = require('crypto');
const { Op } = require('sequelize');
const orderService = require('../../src/modules/orders/orderService');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let phoneSeq = 0;
const nextPhone = () => `0102${String(10000000 + (phoneSeq += 1)).slice(-8)}`;

function tree(marker = 'hello') {
  return {
    version: 1,
    sections: [
      {
        id: 's1',
        type: 'section',
        rows: [
          {
            id: 'r1',
            type: 'row',
            columns: [{ id: 'c1', type: 'column', span: 12, elements: [{ id: 'e1', type: 'text', props: { text: marker } }] }],
          },
        ],
      },
    ],
  };
}

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Runtime Co');
  const H = bearer(auth.accessToken);
  const base = `/api/v1/workspaces/${workspace.id}/funnels`;
  const store = `/api/v1/store/${workspace.id}/funnels`;

  return {
    auth,
    workspace,
    H,
    createFunnel: (body = { name: 'Runtime Funnel' }) => request(app).post(base).set(H).send(body),
    createStep: (id, body) => request(app).post(`${base}/${id}/steps`).set(H).send(body),
    deleteStep: (id, stepId) => request(app).delete(`${base}/${id}/steps/${stepId}`).set(H),
    createEdge: (id, body) => request(app).post(`${base}/${id}/edges`).set(H).send(body),
    deleteEdge: (id, edgeId) => request(app).delete(`${base}/${id}/edges/${edgeId}`).set(H),
    publish: (id) => request(app).post(`${base}/${id}/publish`).set(H).send({}),
    startSession: (ref, body) => request(app).post(`${store}/${ref}/sessions`).send(body),
    sessionStep: (id, sid) => request(app).get(`${store}/${id}/sessions/${sid}/step`).redirects(0),
    advance: (id, sid, body) => request(app).post(`${store}/${id}/sessions/${sid}/advance`).send(body),
    placeOrder: async (variantId) => {
      const { order } = await orderService.createOrder(
        workspace.id,
        {
          items: [{ variantId, quantity: 1 }],
          contact: { fullName: 'Runtime Buyer', phone: nextPhone() },
          shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 A St' },
          paymentMethod: 'cod',
        },
        { user: null, headers: {}, ip: null }
      );
      return order;
    },
  };
}

/** landing --always--> middle --always--> thanks (thanks is terminal). */
async function publishedThreeStep(ctx) {
  const funnel = (await ctx.createFunnel({ name: 'Three Step' })).body.funnel;
  const landing = (await ctx.createStep(funnel.id, { key: 'landing', stepType: 'landing', name: 'L', builderData: tree('l') })).body.step;
  const middle = (await ctx.createStep(funnel.id, { key: 'middle', stepType: 'sales', name: 'M', builderData: tree('m') })).body.step;
  const thanks = (await ctx.createStep(funnel.id, { key: 'thanks', stepType: 'thank_you', name: 'T', builderData: tree('t') })).body.step;
  await ctx.createEdge(funnel.id, { fromStepKey: 'landing', toStepKey: 'middle', condition: { type: 'always' } });
  await ctx.createEdge(funnel.id, { fromStepKey: 'middle', toStepKey: 'thanks', condition: { type: 'always' } });
  const pub = await ctx.publish(funnel.id);
  if (pub.status !== 201) throw new Error(`publish failed: ${pub.status} ${JSON.stringify(pub.body)}`);
  return { funnel, landing, middle, thanks };
}

describe('funnel runtime — stale advance (fromStepKey)', () => {
  it('refuses an advance whose fromStepKey is no longer the session step, and changes nothing', async () => {
    const ctx = await setup();
    const { funnel } = await publishedThreeStep(ctx);

    const start = await ctx.startSession(funnel.id, { visitorId: 'stale-1' });
    const sid = start.body.session.id;

    const first = await ctx.advance(funnel.id, sid, { fromStepKey: 'landing', outcome: { type: 'clicked_through' } });
    expect(first.status).toBe(200);
    expect(first.body.step.key).toBe('middle');

    // The visitor's other tab is still showing `landing` and clicks through.
    const stale = await ctx.advance(funnel.id, sid, { fromStepKey: 'landing', outcome: { type: 'clicked_through' } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STEP_MISMATCH');

    const session = await db.FunnelSession.findByPk(sid);
    expect(session.currentStepKey).toBe('middle');
    expect(session.path).toEqual(['landing']);
    expect(session.status).toBe('active');
  });

  it('accepts a matching fromStepKey, and stays backward compatible when it is omitted', async () => {
    const ctx = await setup();
    const { funnel } = await publishedThreeStep(ctx);

    const sid = (await ctx.startSession(funnel.id, { visitorId: 'stale-2' })).body.session.id;

    const matched = await ctx.advance(funnel.id, sid, { fromStepKey: 'landing', outcome: { type: 'clicked_through' } });
    expect(matched.status).toBe(200);

    const noKey = await ctx.advance(funnel.id, sid, { outcome: { type: 'clicked_through' } });
    expect(noKey.status).toBe(200);
    expect(noKey.body.step.key).toBe('thanks');
  });
});

describe('funnel runtime — completion', () => {
  it('completes the session the moment it lands on a step no edge leaves, and still returns that step', async () => {
    const ctx = await setup();
    const { funnel } = await publishedThreeStep(ctx);

    const sid = (await ctx.startSession(funnel.id, { visitorId: 'done-1' })).body.session.id;
    await ctx.advance(funnel.id, sid, { outcome: { type: 'clicked_through' } });

    const last = await ctx.advance(funnel.id, sid, { outcome: { type: 'clicked_through' } });
    expect(last.status).toBe(200);
    expect(last.body.done).toBe(true);
    // The thank-you page still comes back — it is what the visitor must see.
    expect(last.body.step.key).toBe('thanks');

    const session = await db.FunnelSession.findByPk(sid);
    expect(session.status).toBe('completed');
    expect(session.completedAt).not.toBeNull();

    // Refreshing the thank-you page keeps rendering it.
    const reload = await ctx.sessionStep(funnel.id, sid);
    expect(reload.status).toBe(200);
    expect(reload.body.done).toBe(true);
    expect(reload.body.step.key).toBe('thanks');
  });

  it('starts a brand-new session for a visitor who already completed one', async () => {
    const ctx = await setup();
    const { funnel } = await publishedThreeStep(ctx);

    const first = await ctx.startSession(funnel.id, { visitorId: 'repeat-1' });
    const firstId = first.body.session.id;
    await ctx.advance(funnel.id, firstId, { outcome: { type: 'clicked_through' } });
    await ctx.advance(funnel.id, firstId, { outcome: { type: 'clicked_through' } });
    expect((await db.FunnelSession.findByPk(firstId)).status).toBe('completed');

    const second = await ctx.startSession(funnel.id, { visitorId: 'repeat-1' });
    expect(second.status).toBe(201);
    expect(second.body.session.id).not.toBe(firstId);
    expect(second.body.session.currentStepKey).toBe('landing');
    expect(second.body.step.key).toBe('landing');
  });
});

describe('funnel runtime — a republish that removes the visitor’s step', () => {
  async function stranded(ctx) {
    const { funnel, middle } = await publishedThreeStep(ctx);
    const sid = (await ctx.startSession(funnel.id, { visitorId: `lost-${Math.random()}` })).body.session.id;
    await ctx.advance(funnel.id, sid, { outcome: { type: 'clicked_through' } }); // -> middle

    // Republish without `middle`: deleting a step takes its edges with it
    // (funnelsService.deleteStep), so landing is wired straight to thanks.
    await ctx.deleteStep(funnel.id, middle.id);
    await ctx.createEdge(funnel.id, { fromStepKey: 'landing', toStepKey: 'thanks', condition: { type: 'always' } });
    const pub = await ctx.publish(funnel.id);
    if (pub.status !== 201) throw new Error(`republish failed: ${pub.status} ${JSON.stringify(pub.body)}`);

    return { funnel, sid };
  }

  it('restarts the session at the entry step on get-step instead of 404ing', async () => {
    const ctx = await setup();
    const { funnel, sid } = await stranded(ctx);

    const res = await ctx.sessionStep(funnel.id, sid);
    expect(res.status).toBe(200);
    expect(res.body.step.key).toBe('landing');
    expect(res.body.session.currentStepKey).toBe('landing');
    expect(res.body.session.path).toEqual([]);
  });

  it('restarts the session at the entry step on advance instead of 404ing', async () => {
    const ctx = await setup();
    const { funnel, sid } = await stranded(ctx);

    const res = await ctx.advance(funnel.id, sid, { outcome: { type: 'clicked_through' } });
    expect(res.status).toBe(200);
    expect(res.body.step.key).toBe('landing');

    const session = await db.FunnelSession.findByPk(sid);
    expect(session.currentStepKey).toBe('landing');
    expect(session.status).toBe('active');
  });
});

describe('funnel runtime — upsell atomicity', () => {
  async function upsellFunnel(ctx) {
    const { product, variant } = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id, {
      price: 12000,
      stock: 20,
    });
    const offer = await db.Offer.create({
      workspaceId: ctx.workspace.id,
      productId: product.id,
      name: 'Atomic Upsell',
      pricingMode: 'fixed',
      priceAmount: 6000,
      currency: 'EGP',
      status: 'active',
    });
    await db.OfferVariant.create({ offerId: offer.id, variantId: variant.id, quantity: 1 });

    const funnel = (await ctx.createFunnel({ name: 'Atomic' })).body.funnel;
    await ctx.createStep(funnel.id, { key: 'checkout', stepType: 'checkout', name: 'C', builderData: tree('c') });
    await ctx.createStep(funnel.id, { key: 'upsell', stepType: 'upsell', name: 'U', builderData: tree('u'), offerId: offer.id });
    await ctx.createStep(funnel.id, { key: 'win', stepType: 'thank_you', name: 'W', builderData: tree('w') });
    await ctx.createEdge(funnel.id, { fromStepKey: 'checkout', toStepKey: 'upsell', condition: { type: 'always' } });
    await ctx.createEdge(funnel.id, { fromStepKey: 'upsell', toStepKey: 'win', condition: { type: 'accepted_offer' } });
    const pub = await ctx.publish(funnel.id);
    if (pub.status !== 201) throw new Error(`publish failed: ${pub.status} ${JSON.stringify(pub.body)}`);
    return { funnel, variant, offer };
  }

  it('an order paid online only moves the funnel once it is paid; its upsell is cash on delivery', async () => {
    const ctx = await setup();
    const { funnel, variant } = await upsellFunnel(ctx);
    const { order: card } = await orderService.createOrder(
      ctx.workspace.id,
      {
        items: [{ variantId: variant.id, quantity: 1 }],
        contact: { fullName: 'Card Buyer', phone: nextPhone() },
        shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 A St' },
        paymentMethod: 'card',
      },
      { user: null, headers: {}, ip: null }
    );

    const sid = (await ctx.startSession(funnel.id, { visitorId: 'paid-first-1' })).body.session.id;
    const early = await ctx.advance(funnel.id, sid, { outcome: { type: 'completed_checkout', orderId: card.id } });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('FUNNEL_ORDER_NOT_PAID');
    expect((await db.FunnelSession.findByPk(sid)).currentStepKey).toBe('checkout');

    await db.Order.update({ financialState: 'paid', amountPaid: card.totalAmount }, { where: { id: card.id } });
    const paid = await ctx.advance(funnel.id, sid, { outcome: { type: 'completed_checkout', orderId: card.id } });
    expect(paid.status).toBe(200);

    const accepted = await ctx.advance(funnel.id, sid, { outcome: { type: 'accepted_offer' } });
    expect(accepted.status).toBe(200);
    const followOn = await db.Order.findByPk(accepted.body.followOnOrder.id);
    expect(followOn.paymentMethod).toBe('cod');
    expect(await db.ConfirmationTask.count({ where: { orderId: followOn.id } })).toBe(1);
  });

  it('commits the follow-on order with the session move', async () => {
    const ctx = await setup();
    const { funnel, variant } = await upsellFunnel(ctx);
    const original = await ctx.placeOrder(variant.id);

    const sid = (await ctx.startSession(funnel.id, { visitorId: 'atomic-1' })).body.session.id;
    await ctx.advance(funnel.id, sid, { outcome: { type: 'completed_checkout', orderId: original.id } });

    const accepted = await ctx.advance(funnel.id, sid, { fromStepKey: 'upsell', outcome: { type: 'accepted_offer' } });
    expect(accepted.status).toBe(200);
    expect(accepted.body.followOnOrder.linkedFromOrderId).toBe(original.id);

    const linked = await db.Order.findAll({ where: { workspaceId: ctx.workspace.id, linkedFromOrderId: original.id } });
    expect(linked).toHaveLength(1);
    expect((await db.FunnelSession.findByPk(sid)).currentStepKey).toBe('win');
  });

  it('rolls the follow-on order back when the advance fails after it was created', async () => {
    const ctx = await setup();
    const { funnel, variant } = await upsellFunnel(ctx);
    const original = await ctx.placeOrder(variant.id);

    const sid = (await ctx.startSession(funnel.id, { visitorId: 'atomic-2' })).body.session.id;
    await ctx.advance(funnel.id, sid, { outcome: { type: 'completed_checkout', orderId: original.id } });

    const reservedBefore = (await db.ProductVariant.findByPk(variant.id)).reservedStock;

    // Blow up after the follow-on order is created but before the session is
    // saved. If the order had its own transaction it would already be
    // committed and would survive this.
    const saveDescriptor = Object.getOwnPropertyDescriptor(db.FunnelSession.prototype, 'save');
    db.FunnelSession.prototype.save = function failingSave() {
      throw new Error('boom: advance failed after the upsell order was created');
    };
    let res;
    try {
      res = await ctx.advance(funnel.id, sid, { outcome: { type: 'accepted_offer' } });
    } finally {
      if (saveDescriptor) Object.defineProperty(db.FunnelSession.prototype, 'save', saveDescriptor);
      else delete db.FunnelSession.prototype.save;
    }

    expect(res.status).toBe(500);

    // Nothing survived: no order, no inventory reservation, no session move.
    const linked = await db.Order.count({ where: { workspaceId: ctx.workspace.id, linkedFromOrderId: original.id } });
    expect(linked).toBe(0);
    expect((await db.ProductVariant.findByPk(variant.id)).reservedStock).toBe(reservedBefore);
    expect((await db.FunnelSession.findByPk(sid)).currentStepKey).toBe('upsell');
  });
});

describe('funnel runtime — distinct error codes', () => {
  const randomUuid = () => crypto.randomUUID();

  it('FUNNEL_NOT_FOUND (404) for an unknown funnel, by id or subdomain, and for one that is not published', async () => {
    const ctx = await setup();
    const draft = (await ctx.createFunnel({ name: 'Never Published' })).body.funnel;
    await ctx.createStep(draft.id, { key: 'landing', stepType: 'landing', name: 'L', builderData: tree('l') });

    for (const ref of [randomUuid(), 'no-such-funnel', draft.id]) {
      const res = await ctx.startSession(ref, { visitorId: 'nf-1' });
      expect([ref, res.status, res.body.error.code]).toEqual([ref, 404, 'FUNNEL_NOT_FOUND']);
      expect(res.body.error.message).toBe('Funnel not found');
    }

    // A session whose funnel was unpublished since (back to draft).
    const { funnel } = await publishedThreeStep(ctx);
    const sid = (await ctx.startSession(funnel.id, { visitorId: 'nf-2' })).body.session.id;
    await db.Funnel.update({ status: 'draft', publishedRevisionId: null }, { where: { id: funnel.id } });
    const step = await ctx.sessionStep(funnel.id, sid);
    expect(step.status).toBe(404);
    expect(step.body.error.code).toBe('FUNNEL_NOT_FOUND');
    const adv = await ctx.advance(funnel.id, sid, { outcome: { type: 'clicked_through' } });
    expect(adv.status).toBe(404);
    expect(adv.body.error.code).toBe('FUNNEL_NOT_FOUND');
  });

  it('FUNNEL_SESSION_NOT_FOUND (404) for an unknown session, on get-step and advance', async () => {
    const ctx = await setup();
    const { funnel } = await publishedThreeStep(ctx);
    const other = await publishedThreeStep(ctx);
    const otherSid = (await ctx.startSession(other.funnel.id, { visitorId: 'sess-1' })).body.session.id;

    for (const sid of [randomUuid(), otherSid]) {
      const step = await ctx.sessionStep(funnel.id, sid);
      expect(step.status).toBe(404);
      expect(step.body.error.code).toBe('FUNNEL_SESSION_NOT_FOUND');
      const adv = await ctx.advance(funnel.id, sid, { outcome: { type: 'clicked_through' } });
      expect(adv.status).toBe(404);
      expect(adv.body.error.code).toBe('FUNNEL_SESSION_NOT_FOUND');
    }
  });

  it('FUNNEL_STEP_NOT_FOUND (404) when the published snapshot has no step to put the visitor on', async () => {
    const ctx = await setup();
    const { funnel } = await publishedThreeStep(ctx);
    const sid = (await ctx.startSession(funnel.id, { visitorId: 'step-1' })).body.session.id;

    // A published revision whose steps (entry included) are gone.
    const live = await db.Funnel.findByPk(funnel.id);
    const revision = await db.FunnelRevision.findByPk(live.publishedRevisionId);
    await revision.update({ snapshot: { ...revision.snapshot, steps: [], edges: [] } });

    const step = await ctx.sessionStep(funnel.id, sid);
    expect(step.status).toBe(404);
    expect(step.body.error.code).toBe('FUNNEL_STEP_NOT_FOUND');
    const adv = await ctx.advance(funnel.id, sid, { outcome: { type: 'clicked_through' } });
    expect(adv.status).toBe(404);
    expect(adv.body.error.code).toBe('FUNNEL_STEP_NOT_FOUND');
    const start = await ctx.startSession(funnel.id, { visitorId: 'step-2' });
    expect(start.status).toBe(404);
    expect(start.body.error.code).toBe('FUNNEL_STEP_NOT_FOUND');
  });

  describe('accepting an offer', () => {
    async function upsellAfterCheckout(ctx) {
      const { product, variant } = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id, { price: 12000, stock: 20 });
      const offer = await db.Offer.create({
        workspaceId: ctx.workspace.id,
        productId: product.id,
        name: 'Codes Upsell',
        pricingMode: 'fixed',
        priceAmount: 6000,
        currency: 'EGP',
        status: 'active',
      });
      await db.OfferVariant.create({ offerId: offer.id, variantId: variant.id, quantity: 1 });
      const funnel = (await ctx.createFunnel({ name: 'Codes' })).body.funnel;
      await ctx.createStep(funnel.id, { key: 'checkout', stepType: 'checkout', name: 'C', builderData: tree('c') });
      await ctx.createStep(funnel.id, { key: 'upsell', stepType: 'upsell', name: 'U', builderData: tree('u'), offerId: offer.id });
      await ctx.createStep(funnel.id, { key: 'win', stepType: 'thank_you', name: 'W', builderData: tree('w') });
      await ctx.createEdge(funnel.id, { fromStepKey: 'checkout', toStepKey: 'upsell', condition: { type: 'always' } });
      await ctx.createEdge(funnel.id, { fromStepKey: 'upsell', toStepKey: 'win', condition: { type: 'accepted_offer' } });
      const pub = await ctx.publish(funnel.id);
      if (pub.status !== 201) throw new Error(`publish failed: ${pub.status} ${JSON.stringify(pub.body)}`);
      return { funnel, variant, offer };
    }

    const linkedCount = (workspaceId) => db.Order.count({ where: { workspaceId, linkedFromOrderId: { [Op.ne]: null } } });

    it('FUNNEL_OFFER_NEEDS_ORDER (422, details[].field "session") with no checkout order in the session', async () => {
      const ctx = await setup();
      const { funnel } = await upsellAfterCheckout(ctx);
      const sid = (await ctx.startSession(funnel.id, { visitorId: 'offer-1' })).body.session.id;
      await ctx.advance(funnel.id, sid, { outcome: { type: 'clicked_through' } }); // -> upsell, no order

      const res = await ctx.advance(funnel.id, sid, { outcome: { type: 'accepted_offer' } });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('FUNNEL_OFFER_NEEDS_ORDER');
      expect(res.body.error.details).toEqual([{ field: 'session', message: expect.stringMatching(/complete checkout first/) }]);
      expect((await db.FunnelSession.findByPk(sid)).currentStepKey).toBe('upsell');
    });

    it('FUNNEL_OFFER_UNAVAILABLE (404) when the offer was archived or lost its lines', async () => {
      const ctx = await setup();
      const { funnel, variant, offer } = await upsellAfterCheckout(ctx);

      const breakers = [
        () => offer.update({ status: 'archived' }),
        async () => {
          await offer.update({ status: 'active' });
          await db.OfferVariant.destroy({ where: { offerId: offer.id } });
        },
      ];
      for (const breakOffer of breakers) {
        const original = await ctx.placeOrder(variant.id);
        const sid = (await ctx.startSession(funnel.id, { visitorId: `offer-gone-${Math.random()}` })).body.session.id;
        await ctx.advance(funnel.id, sid, { outcome: { type: 'completed_checkout', orderId: original.id } });
        await breakOffer();

        const res = await ctx.advance(funnel.id, sid, { outcome: { type: 'accepted_offer' } });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('FUNNEL_OFFER_UNAVAILABLE');
        expect((await db.FunnelSession.findByPk(sid)).currentStepKey).toBe('upsell');
      }
      expect(await linkedCount(ctx.workspace.id)).toBe(0);
    });

    it('FUNNEL_OFFER_UNAVAILABLE (404) when the session order is no longer in this store', async () => {
      const ctx = await setup();
      const { funnel, variant } = await upsellAfterCheckout(ctx);
      const original = await ctx.placeOrder(variant.id);
      const sid = (await ctx.startSession(funnel.id, { visitorId: 'order-gone' })).body.session.id;
      await ctx.advance(funnel.id, sid, { outcome: { type: 'completed_checkout', orderId: original.id } });

      // The order lookup is workspace-scoped: an order id this store can't
      // see is the same as one that was removed.
      const elsewhere = await setup();
      const { variant: otherVariant } = await createProductWithVariant(elsewhere.auth.accessToken, elsewhere.workspace.id, {
        price: 1000,
        stock: 5,
      });
      const foreign = await elsewhere.placeOrder(otherVariant.id);
      await db.FunnelSession.update({ orderId: foreign.id }, { where: { id: sid } });

      const res = await ctx.advance(funnel.id, sid, { outcome: { type: 'accepted_offer' } });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('FUNNEL_OFFER_UNAVAILABLE');
      expect(await linkedCount(ctx.workspace.id)).toBe(0);
    });
  });
});
