'use strict';

const {
  app,
  request,
  registerAndActivate,
  createWorkspace,
  createProductWithVariant,
} = require('../helpers/factories');
const db = require('../../src/db/models');

// A minimal but valid section -> row -> column -> element tree. `marker` goes
// into the single text element so tests can prove which version is live.
function tree(marker = 'Hello world') {
  return {
    version: 1,
    sections: [
      {
        id: 's1',
        type: 'section',
        settings: {},
        rows: [
          {
            id: 'r1',
            type: 'row',
            settings: {},
            columns: [
              {
                id: 'c1',
                type: 'column',
                span: 12,
                settings: {},
                elements: [{ id: 'e1', type: 'text', props: { text: marker } }],
              },
            ],
          },
        ],
      },
    ],
  };
}

const markerOfStep = (body) => body.step.tree.sections[0].rows[0].columns[0].elements[0].props.text;

let uniquePhone = 1000000000;
const nextPhone = () => `01${String(++uniquePhone).slice(-9)}`;

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Acme Funnels');
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const base = `/api/v1/workspaces/${workspace.id}/funnels`;
  const store = `/api/v1/store/${workspace.id}/funnels`;

  const ctx = {
    auth,
    workspace,
    H,
    base,
    store,
    createFunnel: (body = { name: 'Launch Funnel' }) => request(app).post(base).set(H).send(body),
    getFunnel: (id) => request(app).get(`${base}/${id}`).set(H),
    createStep: (id, body) => request(app).post(`${base}/${id}/steps`).set(H).send(body),
    patchStep: (id, stepId, body) => request(app).patch(`${base}/${id}/steps/${stepId}`).set(H).send(body),
    getStep: (id, stepId) => request(app).get(`${base}/${id}/steps/${stepId}`).set(H),
    createEdge: (id, body) => request(app).post(`${base}/${id}/edges`).set(H).send(body),
    publish: (id, note) => request(app).post(`${base}/${id}/publish`).set(H).send(note ? { note } : {}),
    revisions: (id) => request(app).get(`${base}/${id}/revisions`).set(H),
    rollback: (id, revId) => request(app).post(`${base}/${id}/revisions/${revId}/rollback`).set(H).send({}),
    pause: (id) => request(app).post(`${base}/${id}/pause`).set(H).send({}),
    resume: (id) => request(app).post(`${base}/${id}/resume`).set(H).send({}),
    startSession: (ref, body) => request(app).post(`${store}/${ref}/sessions`).send(body),
    sessionStep: (id, sid) => request(app).get(`${store}/${id}/sessions/${sid}/step`).redirects(0),
    advance: (id, sid, outcome) =>
      request(app).post(`${store}/${id}/sessions/${sid}/advance`).send({ outcome }),
    placeOrder: async (variantId) => {
      const res = await request(app)
        .post(`/api/v1/workspaces/${workspace.id}/orders`)
        .set(H)
        .set('Idempotency-Key', `ord-${Math.random().toString(36).slice(2)}`)
        .send({
          items: [{ variantId, quantity: 1 }],
          contact: { fullName: 'Funnel Buyer', phone: nextPhone() },
          paymentMethod: 'cod',
        });
      if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.order;
    },
  };
  return ctx;
}

// Builds a published funnel: entry `landing` --always--> `thanks`, both with content.
async function publishedLinearFunnel(ctx, { landingMarker = 'V1' } = {}) {
  const funnel = (await ctx.createFunnel({ name: 'Linear' })).body.funnel;
  await ctx.createStep(funnel.id, { key: 'landing', stepType: 'landing', name: 'Landing', builderData: tree(landingMarker) });
  await ctx.createStep(funnel.id, { key: 'thanks', stepType: 'thank_you', name: 'Thanks', builderData: tree('done') });
  await ctx.createEdge(funnel.id, { fromStepKey: 'landing', toStepKey: 'thanks', condition: { type: 'always' } });
  const pub = await ctx.publish(funnel.id);
  if (pub.status !== 201) throw new Error(`publish failed: ${pub.status} ${JSON.stringify(pub.body)}`);
  return funnel;
}

describe('Funnel engine — funnel / step / edge CRUD', () => {
  it('creates a draft funnel with an auto subdomain, scoped to the workspace', async () => {
    const ctx = await setup();
    const res = await ctx.createFunnel({ name: 'Acme Launch' });
    expect(res.status).toBe(201);
    expect(res.body.funnel.status).toBe('draft');
    expect(res.body.funnel.subdomain).toMatch(/^acme-launch/);

    const get = await ctx.getFunnel(res.body.funnel.id);
    expect(get.status).toBe(200);
    expect(get.body.steps).toHaveLength(0);
    expect(get.body.edges).toHaveLength(0);
    expect(get.body.publishedRevision).toBeNull();
  });

  it("refuses another workspace's funnel (404, same as tenant isolation)", async () => {
    const ctx = await setup();
    const funnel = (await ctx.createFunnel()).body.funnel;
    const outsider = await registerAndActivate();
    const res = await request(app)
      .get(`${ctx.base}/${funnel.id}`)
      .set({ Authorization: `Bearer ${outsider.accessToken}` });
    expect(res.status).toBe(404);
  });

  it('rejects a step stored as a raw HTML string, with an actionable message', async () => {
    const ctx = await setup();
    const funnel = (await ctx.createFunnel()).body.funnel;
    const res = await ctx.createStep(funnel.id, {
      key: 'landing',
      stepType: 'landing',
      name: 'Landing',
      builderData: '<section><h1>hi</h1></section>',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body.error.details)).toMatch(/raw HTML string/i);
  });

  it('rejects an unknown / raw-html element type inside an otherwise valid step tree', async () => {
    const ctx = await setup();
    const funnel = (await ctx.createFunnel()).body.funnel;
    const bad = tree('x');
    bad.sections[0].rows[0].columns[0].elements[0] = { id: 'e1', type: 'html', props: { html: '<b>x</b>' } };
    const res = await ctx.createStep(funnel.id, { key: 'landing', stepType: 'landing', name: 'L', builderData: bad });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/Unknown element type/i);
  });

  it('enforces a unique step key within a funnel', async () => {
    const ctx = await setup();
    const funnel = (await ctx.createFunnel()).body.funnel;
    const first = await ctx.createStep(funnel.id, { key: 'landing', stepType: 'landing', name: 'One' });
    expect(first.status).toBe(201);
    const dup = await ctx.createStep(funnel.id, { key: 'landing', stepType: 'sales', name: 'Two' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('FUNNEL_STEP_KEY_TAKEN');
  });

  it('rejects an edge that points at a step that does not exist', async () => {
    const ctx = await setup();
    const funnel = (await ctx.createFunnel()).body.funnel;
    await ctx.createStep(funnel.id, { key: 'landing', stepType: 'landing', name: 'L' });
    const res = await ctx.createEdge(funnel.id, { fromStepKey: 'landing', toStepKey: 'ghost' });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/ghost/);
  });

  it('requires an offer id that resolves to an active offer in the workspace', async () => {
    const ctx = await setup();
    const funnel = (await ctx.createFunnel()).body.funnel;
    const res = await ctx.createStep(funnel.id, {
      key: 'up',
      stepType: 'upsell',
      name: 'Upsell',
      builderData: tree('u'),
      offerId: '00000000-0000-4000-8000-000000000000',
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/offer/i);
  });
});

describe('Funnel engine — pre-publish validation', () => {
  it('refuses to publish a funnel with no steps', async () => {
    const ctx = await setup();
    const funnel = (await ctx.createFunnel()).body.funnel;
    const res = await ctx.publish(funnel.id);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/at least one step/i);
  });

  it('refuses to publish when a step has an empty content tree', async () => {
    const ctx = await setup();
    const funnel = (await ctx.createFunnel()).body.funnel;
    await ctx.createStep(funnel.id, { key: 'landing', stepType: 'landing', name: 'L' }); // default empty tree
    const res = await ctx.publish(funnel.id);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/empty/i);
  });

  it('refuses to publish with more than one possible entry step', async () => {
    const ctx = await setup();
    const funnel = (await ctx.createFunnel()).body.funnel;
    await ctx.createStep(funnel.id, { key: 'a', stepType: 'landing', name: 'A', builderData: tree('a') });
    await ctx.createStep(funnel.id, { key: 'b', stepType: 'landing', name: 'B', builderData: tree('b') });
    const res = await ctx.publish(funnel.id);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/entry step/i);
  });

  it('refuses to publish with a step unreachable from the entry', async () => {
    const ctx = await setup();
    const funnel = (await ctx.createFunnel()).body.funnel;
    await ctx.createStep(funnel.id, { key: 'a', stepType: 'landing', name: 'A', builderData: tree('a') });
    await ctx.createStep(funnel.id, { key: 'b', stepType: 'sales', name: 'B', builderData: tree('b') });
    await ctx.createStep(funnel.id, { key: 'c', stepType: 'thank_you', name: 'C', builderData: tree('c') });
    // a <-> b cycle; c is the lone entry and can reach nobody.
    await ctx.createEdge(funnel.id, { fromStepKey: 'a', toStepKey: 'b', condition: { type: 'always' } });
    await ctx.createEdge(funnel.id, { fromStepKey: 'b', toStepKey: 'a', condition: { type: 'always' } });
    const res = await ctx.publish(funnel.id);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/unreachable/i);
  });

  it('refuses to publish an upsell step with no offer', async () => {
    const ctx = await setup();
    const funnel = (await ctx.createFunnel()).body.funnel;
    await ctx.createStep(funnel.id, { key: 'landing', stepType: 'landing', name: 'L', builderData: tree('l') });
    await ctx.createStep(funnel.id, { key: 'up', stepType: 'upsell', name: 'U', builderData: tree('u') });
    await ctx.createEdge(funnel.id, { fromStepKey: 'landing', toStepKey: 'up', condition: { type: 'always' } });
    const res = await ctx.publish(funnel.id);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/must reference an offer/i);
  });
});

describe('Funnel engine — publish / revision / rollback lifecycle', () => {
  it('publishes revision #1 and flips the funnel to published', async () => {
    const ctx = await setup();
    const funnel = await publishedLinearFunnel(ctx);
    const pub = await ctx.revisions(funnel.id);
    expect(pub.body.revisions[0].revisionNumber).toBe(1);

    const get = await ctx.getFunnel(funnel.id);
    expect(get.body.funnel.status).toBe('published');
    expect(get.body.publishedRevision.revisionNumber).toBe(1);
  });

  it('draft edits after publish do not change the runtime until the next publish', async () => {
    const ctx = await setup();
    const funnel = await publishedLinearFunnel(ctx, { landingMarker: 'V1' });
    const steps = (await request(app).get(`${ctx.base}/${funnel.id}/steps`).set(ctx.H)).body.steps;
    const landing = steps.find((s) => s.key === 'landing');

    await ctx.patchStep(funnel.id, landing.id, { builderData: tree('V2') });

    // Runtime still serves V1.
    const s1 = await ctx.startSession(funnel.id, { visitorId: 'v-a' });
    expect(markerOfStep(s1.body)).toBe('V1');

    // Publish again -> revision 2 -> runtime serves V2.
    const pub2 = await ctx.publish(funnel.id);
    expect(pub2.status).toBe(201);
    expect(pub2.body.revision.revisionNumber).toBe(2);
    const s2 = await ctx.startSession(funnel.id, { visitorId: 'v-b' });
    expect(markerOfStep(s2.body)).toBe('V2');
  });

  it('rollback repoints to an earlier revision without touching drafts', async () => {
    const ctx = await setup();
    const funnel = await publishedLinearFunnel(ctx, { landingMarker: 'V1' });
    const steps = (await request(app).get(`${ctx.base}/${funnel.id}/steps`).set(ctx.H)).body.steps;
    const landing = steps.find((s) => s.key === 'landing');
    await ctx.patchStep(funnel.id, landing.id, { name: 'Landing V2', builderData: tree('V2') });
    await ctx.publish(funnel.id); // revision 2 (V2)

    const revs = (await ctx.revisions(funnel.id)).body.revisions;
    const rev1 = revs.find((r) => r.revisionNumber === 1);
    const rb = await ctx.rollback(funnel.id, rev1.id);
    expect(rb.status).toBe(200);

    const get = await ctx.getFunnel(funnel.id);
    expect(get.body.publishedRevision.revisionNumber).toBe(1);
    const s = await ctx.startSession(funnel.id, { visitorId: 'v-c' });
    expect(markerOfStep(s.body)).toBe('V1');

    // Draft is still the V2 edit — rollback didn't rewind it.
    const stepAfter = (await ctx.getStep(funnel.id, landing.id)).body.step;
    expect(stepAfter.name).toBe('Landing V2');
  });
});

describe('Funnel engine — public runtime', () => {
  it('starts a session at the entry step and walks an "always" edge to completion', async () => {
    const ctx = await setup();
    const funnel = await publishedLinearFunnel(ctx);

    const start = await ctx.startSession(funnel.id, { visitorId: 'walk-1', attribution: { utm_source: 'ig' } });
    expect(start.status).toBe(201);
    expect(start.body.session.currentStepKey).toBe('landing');
    expect(start.body.step.key).toBe('landing');
    const sid = start.body.session.id;

    const step2 = await ctx.advance(funnel.id, sid, { type: 'clicked_through' });
    expect(step2.status).toBe(200);
    expect(step2.body.step.key).toBe('thanks');
    expect(step2.body.session.path).toEqual(['landing']);

    const step3 = await ctx.advance(funnel.id, sid, { type: 'clicked_through' });
    expect(step3.body.done).toBe(true);

    const session = await db.FunnelSession.findByPk(sid);
    expect(session.status).toBe('completed');
    expect(session.completedAt).not.toBeNull();
  });

  it('picks the higher-priority edge when more than one condition matches', async () => {
    const ctx = await setup();
    const funnel = (await ctx.createFunnel({ name: 'Priority' })).body.funnel;
    await ctx.createStep(funnel.id, { key: 'a', stepType: 'landing', name: 'A', builderData: tree('a') });
    await ctx.createStep(funnel.id, { key: 'b', stepType: 'thank_you', name: 'B', builderData: tree('b') });
    await ctx.createStep(funnel.id, { key: 'c', stepType: 'thank_you', name: 'C', builderData: tree('c') });
    await ctx.createEdge(funnel.id, { fromStepKey: 'a', toStepKey: 'b', condition: { type: 'always' }, priority: 0 });
    await ctx.createEdge(funnel.id, { fromStepKey: 'a', toStepKey: 'c', condition: { type: 'always' }, priority: 10 });
    expect((await ctx.publish(funnel.id)).status).toBe(201);

    const start = await ctx.startSession(funnel.id, { visitorId: 'prio-1' });
    const next = await ctx.advance(funnel.id, start.body.session.id, { type: 'clicked_through' });
    expect(next.body.step.key).toBe('c');
  });

  it('paused funnels are unavailable to the runtime (410), and resume restores them', async () => {
    const ctx = await setup();
    const funnel = await publishedLinearFunnel(ctx);

    expect((await ctx.pause(funnel.id)).status).toBe(200);
    const blocked = await ctx.startSession(funnel.id, { visitorId: 'p-1' });
    expect(blocked.status).toBe(410);
    expect(blocked.body.error.code).toBe('FUNNEL_PAUSED');

    expect((await ctx.resume(funnel.id)).status).toBe(200);
    const ok = await ctx.startSession(funnel.id, { visitorId: 'p-2' });
    expect(ok.status).toBe(201);
  });

  it('cannot pause a funnel that was never published', async () => {
    const ctx = await setup();
    const funnel = (await ctx.createFunnel()).body.funnel;
    const res = await ctx.pause(funnel.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FUNNEL_NOT_PUBLISHED');
  });

  it('routes an accepted upsell to a linked follow-on order and back-fills funnel_id', async () => {
    const ctx = await setup();
    const { product, variant } = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id, {
      price: 12000,
      stock: 20,
    });
    const offer = await db.Offer.create({
      workspaceId: ctx.workspace.id,
      productId: product.id,
      name: 'One-click Upsell',
      pricingMode: 'fixed',
      priceAmount: 6000,
      currency: 'EGP',
      status: 'active',
    });
    await db.OfferVariant.create({ offerId: offer.id, variantId: variant.id, quantity: 1 });

    const funnel = (await ctx.createFunnel({ name: 'Upsell Funnel' })).body.funnel;
    await ctx.createStep(funnel.id, { key: 'checkout', stepType: 'checkout', name: 'Checkout', builderData: tree('co') });
    await ctx.createStep(funnel.id, {
      key: 'upsell',
      stepType: 'upsell',
      name: 'Upsell',
      builderData: tree('up'),
      offerId: offer.id,
    });
    await ctx.createStep(funnel.id, { key: 'win', stepType: 'thank_you', name: 'Win', builderData: tree('win') });
    await ctx.createStep(funnel.id, { key: 'lose', stepType: 'thank_you', name: 'Lose', builderData: tree('lose') });
    await ctx.createEdge(funnel.id, { fromStepKey: 'checkout', toStepKey: 'upsell', condition: { type: 'always' } });
    await ctx.createEdge(funnel.id, { fromStepKey: 'upsell', toStepKey: 'win', condition: { type: 'accepted_offer' } });
    await ctx.createEdge(funnel.id, { fromStepKey: 'upsell', toStepKey: 'lose', condition: { type: 'declined_offer' } });
    expect((await ctx.publish(funnel.id)).status).toBe(201);

    const original = await ctx.placeOrder(variant.id);
    const start = await ctx.startSession(funnel.id, { visitorId: 'buy-1' });
    const sid = start.body.session.id;

    const toUpsell = await ctx.advance(funnel.id, sid, { type: 'completed_checkout', orderId: original.id });
    expect(toUpsell.body.step.key).toBe('upsell');
    expect(toUpsell.body.offer.id).toBe(offer.id);
    const originalAfter = await db.Order.findByPk(original.id);
    expect(originalAfter.funnelId).toBe(funnel.id);

    const accepted = await ctx.advance(funnel.id, sid, { type: 'accepted_offer' });
    expect(accepted.body.step.key).toBe('win');
    expect(accepted.body.followOnOrder.linkedFromOrderId).toBe(original.id);

    const linked = await db.Order.findAll({ where: { workspaceId: ctx.workspace.id, linkedFromOrderId: original.id } });
    expect(linked).toHaveLength(1);
    const v = await db.ProductVariant.findByPk(variant.id);
    expect(v.reservedStock).toBe(2); // 1 for the original order + 1 for the upsell
  });

  it('routes a declined upsell down the declined edge with no follow-on order', async () => {
    const ctx = await setup();
    const { product, variant } = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id, {
      price: 12000,
      stock: 20,
    });
    const offer = await db.Offer.create({
      workspaceId: ctx.workspace.id,
      productId: product.id,
      name: 'Skippable Upsell',
      pricingMode: 'fixed',
      priceAmount: 6000,
      currency: 'EGP',
      status: 'active',
    });
    await db.OfferVariant.create({ offerId: offer.id, variantId: variant.id, quantity: 1 });

    const funnel = (await ctx.createFunnel({ name: 'Decline Funnel' })).body.funnel;
    await ctx.createStep(funnel.id, { key: 'checkout', stepType: 'checkout', name: 'Checkout', builderData: tree('co') });
    await ctx.createStep(funnel.id, { key: 'upsell', stepType: 'upsell', name: 'Upsell', builderData: tree('up'), offerId: offer.id });
    await ctx.createStep(funnel.id, { key: 'win', stepType: 'thank_you', name: 'Win', builderData: tree('win') });
    await ctx.createStep(funnel.id, { key: 'lose', stepType: 'thank_you', name: 'Lose', builderData: tree('lose') });
    await ctx.createEdge(funnel.id, { fromStepKey: 'checkout', toStepKey: 'upsell', condition: { type: 'always' } });
    await ctx.createEdge(funnel.id, { fromStepKey: 'upsell', toStepKey: 'win', condition: { type: 'accepted_offer' } });
    await ctx.createEdge(funnel.id, { fromStepKey: 'upsell', toStepKey: 'lose', condition: { type: 'declined_offer' } });
    expect((await ctx.publish(funnel.id)).status).toBe(201);

    const original = await ctx.placeOrder(variant.id);
    const start = await ctx.startSession(funnel.id, { visitorId: 'buy-2' });
    const sid = start.body.session.id;
    await ctx.advance(funnel.id, sid, { type: 'completed_checkout', orderId: original.id });
    const declined = await ctx.advance(funnel.id, sid, { type: 'declined_offer' });

    expect(declined.body.step.key).toBe('lose');
    expect(declined.body.followOnOrder).toBeUndefined();
    const linked = await db.Order.count({ where: { workspaceId: ctx.workspace.id, linkedFromOrderId: original.id } });
    expect(linked).toBe(0);
  });

  it('rejects accepting an upsell when the session has no prior order', async () => {
    const ctx = await setup();
    const { product, variant } = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id, { stock: 5 });
    const offer = await db.Offer.create({
      workspaceId: ctx.workspace.id,
      productId: product.id,
      name: 'Orphan Upsell',
      pricingMode: 'fixed',
      priceAmount: 6000,
      currency: 'EGP',
      status: 'active',
    });
    await db.OfferVariant.create({ offerId: offer.id, variantId: variant.id, quantity: 1 });

    const funnel = (await ctx.createFunnel({ name: 'Orphan' })).body.funnel;
    await ctx.createStep(funnel.id, { key: 'landing', stepType: 'landing', name: 'L', builderData: tree('l') });
    await ctx.createStep(funnel.id, { key: 'upsell', stepType: 'upsell', name: 'U', builderData: tree('u'), offerId: offer.id });
    await ctx.createStep(funnel.id, { key: 'thanks', stepType: 'thank_you', name: 'T', builderData: tree('t') });
    await ctx.createEdge(funnel.id, { fromStepKey: 'landing', toStepKey: 'upsell', condition: { type: 'always' } });
    await ctx.createEdge(funnel.id, { fromStepKey: 'upsell', toStepKey: 'thanks', condition: { type: 'always' } });
    expect((await ctx.publish(funnel.id)).status).toBe(201);

    const start = await ctx.startSession(funnel.id, { visitorId: 'orphan-1' });
    const sid = start.body.session.id;
    await ctx.advance(funnel.id, sid, { type: 'clicked_through' }); // -> upsell
    const res = await ctx.advance(funnel.id, sid, { type: 'accepted_offer' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('serialises concurrent advance calls so an accepted upsell creates exactly one follow-on order', async () => {
    const ctx = await setup();
    const { product, variant } = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id, {
      price: 12000,
      stock: 50,
    });
    const offer = await db.Offer.create({
      workspaceId: ctx.workspace.id,
      productId: product.id,
      name: 'Race Upsell',
      pricingMode: 'fixed',
      priceAmount: 6000,
      currency: 'EGP',
      status: 'active',
    });
    await db.OfferVariant.create({ offerId: offer.id, variantId: variant.id, quantity: 1 });

    const funnel = (await ctx.createFunnel({ name: 'Race' })).body.funnel;
    await ctx.createStep(funnel.id, { key: 'checkout', stepType: 'checkout', name: 'C', builderData: tree('c') });
    await ctx.createStep(funnel.id, { key: 'upsell', stepType: 'upsell', name: 'U', builderData: tree('u'), offerId: offer.id });
    await ctx.createStep(funnel.id, { key: 'win', stepType: 'thank_you', name: 'W', builderData: tree('w') });
    await ctx.createEdge(funnel.id, { fromStepKey: 'checkout', toStepKey: 'upsell', condition: { type: 'always' } });
    await ctx.createEdge(funnel.id, { fromStepKey: 'upsell', toStepKey: 'win', condition: { type: 'always' } });
    expect((await ctx.publish(funnel.id)).status).toBe(201);

    const original = await ctx.placeOrder(variant.id);
    const start = await ctx.startSession(funnel.id, { visitorId: 'race-1' });
    const sid = start.body.session.id;
    await ctx.advance(funnel.id, sid, { type: 'completed_checkout', orderId: original.id }); // -> upsell

    const results = await Promise.all(
      Array.from({ length: 5 }, () => ctx.advance(funnel.id, sid, { type: 'accepted_offer' }))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);

    const linked = await db.Order.count({ where: { workspaceId: ctx.workspace.id, linkedFromOrderId: original.id } });
    expect(linked).toBe(1);
  });
});
