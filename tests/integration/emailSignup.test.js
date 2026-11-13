'use strict';

// Where shoppers sign up for a store's marketing emails (modules/emailCampaigns,
// signupSettings.js, signupService.js, consent.js, migration 749): the staff
// settings routes and who may use them, the settings in the public store
// payload and the cache dropped on a save, the public footer and popup signup
// (validation, honeypot, the same answer every time, opt-outs lifted, the
// source recorded, consent written once), the boxes at checkout per place and
// pre-ticked or not, and subscribers reached by a campaign.

const crypto = require('crypto');
const express = require('express');
const supertest = require('supertest');
const { app, request, setupWorkspaceWithProduct, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const logger = require('../../src/core/utils/logger');
const providers = require('../../src/modules/emailCampaigns/campaignProviders');
const tokens = require('../../src/modules/emailCampaigns/campaignTokens');
const cloudflarePurge = require('../../src/modules/storefront/cloudflarePurge');
const { createEmailSignupLimiters, emailSignupLimiters } = require('../../src/core/middleware/rateLimiters');
const { errorHandler } = require('../../src/core/middleware/errorHandler');

const ORIGINAL = {
  enabled: env.emailCampaigns.enabled,
  growth: env.growth.requirePlanFeature,
  enforcement: env.planFeatures.enforcement,
};
let sent;
beforeEach(() => {
  env.emailCampaigns.enabled = true;
  sent = [];
  jest.spyOn(providers.PROVIDERS.log, 'send').mockImplementation(async (message) => {
    sent.push(message);
    return { messageId: `log-${crypto.randomUUID()}` };
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  env.emailCampaigns.enabled = ORIGINAL.enabled;
  env.growth.requirePlanFeature = ORIGINAL.growth;
  env.planFeatures.enforcement = ORIGINAL.enforcement;
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function setPlan(workspaceId, { features = [], emails = 100 } = {}) {
  const sub = await db.Subscription.findOne({ where: { workspaceId } });
  const plan = await db.Plan.create({
    key: `plan-${crypto.randomUUID().slice(0, 8)}`,
    name: 'Signup plan',
    monthlyPriceAmount: 0,
    yearlyPriceAmount: 0,
    features,
    maxCampaignEmailsPerMonth: emails,
  });
  await sub.update({ planId: plan.id });
  return plan;
}

let phoneCounter = 0;
async function customer(workspaceId, { email, consent = false, ...rest } = {}) {
  phoneCounter += 1;
  return db.Customer.create({
    workspaceId,
    phoneNormalized: `2011${String(20000000 + phoneCounter).slice(-8)}`,
    phoneRaw: `011${String(20000000 + phoneCounter).slice(-8)}`,
    fullName: 'Signup Customer',
    email,
    marketingConsent: consent,
    ...rest,
  });
}

async function store() {
  const ctx = await setupWorkspaceWithProduct({ price: 15000, stock: 50 });
  const ws = ctx.workspace.id;
  await setPlan(ws);
  const staff = (method, path = '', token = ctx.auth.accessToken) => request(app)[method](`/api/v1/workspaces/${ws}/email-campaigns/signup${path}`).set(bearer(token));
  const save = async (settings) => {
    const res = await staff('put').send(settings);
    if (res.status !== 200) throw new Error(`save: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const signup = (body, ip = '203.0.113.7') => request(app).post(`/api/v1/store/${ws}/email-signup`).set('X-Forwarded-For', ip).send(body);
  return { ...ctx, ws, staff, save, signup };
}

const ON = { footer: { enabled: true }, popup: { enabled: true, trigger: 'exit_intent', delaySeconds: 20 } };

describe('the signup settings and who may use them', () => {
  it('answers 404 everywhere while EMAIL_CAMPAIGNS_ENABLED is off, and the store shows nothing', async () => {
    const s = await store();
    env.emailCampaigns.enabled = false;
    expect((await s.staff('get')).status).toBe(404);
    expect((await s.staff('put').send(ON)).status).toBe(404);
    expect((await s.signup({ email: 'a@example.com', source: 'footer' })).status).toBe(404);
    const page = await request(app).get(`/api/v1/store/${s.ws}`);
    expect(page.status).toBe(200);
    expect(page.body.store.emailSignup).toBeNull();
  });

  it('needs discounts.manage, and never reads or changes another store’s', async () => {
    const s = await store();
    const editor = await addMemberWithRole(s.auth.accessToken, s.ws, 'editor');
    expect((await s.staff('get', '', editor.accessToken)).status).toBe(403);
    expect((await s.staff('put', '', editor.accessToken).send(ON)).status).toBe(403);

    const other = await store();
    // Their token on this store's address: not a member.
    expect((await s.staff('get', '', other.auth.accessToken)).status).toBe(404);
    expect((await s.staff('put', '', other.auth.accessToken).send(ON)).status).toBe(404);
    await other.save(ON);
    expect((await s.staff('get')).body.settings.footer.enabled).toBe(false);
    // A signup on the other store stays the other store's.
    expect((await other.signup({ email: 'theirs@example.com', source: 'footer' })).status).toBe(200);
    expect((await s.staff('get')).body.stats.subscribers).toBe(0);
    expect((await other.staff('get')).body.stats.subscribers).toBe(1);
  });

  it('is locked by the plan like the campaigns while GROWTH_REQUIRE_PLAN_FEATURE is on', async () => {
    const s = await store();
    await s.save(ON);
    env.growth.requirePlanFeature = true;
    env.planFeatures.enforcement = true;
    const locked = await s.staff('get');
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe('PLAN_FEATURE_REQUIRED');
    // The storefront shows nothing and takes no signup.
    expect((await request(app).get(`/api/v1/store/${s.ws}`)).body.store.emailSignup).toBeNull();
    expect((await s.signup({ email: 'a@example.com', source: 'footer' })).status).toBe(404);
    await setPlan(s.ws, { features: ['email_campaigns'] });
    expect((await s.staff('get')).status).toBe(200);
    expect((await request(app).get(`/api/v1/store/${s.ws}`)).body.store.emailSignup.footer).toEqual({});
  });

  it('starts with the checkout box on and unticked, the rest off; saves whole and validates', async () => {
    const s = await store();
    const first = await s.staff('get');
    expect(first.status).toBe(200);
    expect(first.body.settings).toEqual({
      checkout: { enabled: true, preTicked: false },
      quickOrder: { enabled: false, preTicked: false },
      cart: { enabled: false, preTicked: false },
      footer: { enabled: false },
      popup: { enabled: false, trigger: 'delay', delaySeconds: 15 },
      text: { ar: { label: null, privacy: null, incentive: null }, en: { label: null, privacy: null, incentive: null } },
    });
    expect(first.body.stats).toEqual({ subscribers: 0, bySource: { checkout: 0, quick_order: 0, cart: 0, footer: 0, popup: 0, other: 0 } });
    expect(['hidden', 'optional', 'required']).toContain(first.body.checkoutEmailField);
    expect((await request(app).get(`/api/v1/store/${s.ws}`)).body.store.emailSignup).toEqual({
      checkout: { preTicked: false },
      quickOrder: null,
      cart: null,
      footer: null,
      popup: null,
      text: { ar: { label: null, privacy: null, incentive: null }, en: { label: null, privacy: null, incentive: null } },
    });

    expect((await s.staff('put').send({ popup: { enabled: true, delaySeconds: 1 } })).status).toBe(422);
    expect((await s.staff('put').send({ popup: { enabled: true, trigger: 'scroll' } })).status).toBe(422);
    expect((await s.staff('put').send({ text: { en: { label: 'x'.repeat(161) } } })).status).toBe(422);

    const saved = await s.save({
      checkout: { enabled: true, preTicked: true },
      quickOrder: { enabled: true, preTicked: false },
      cart: { enabled: true, preTicked: true },
      ...ON,
      text: { en: { label: 'Get our offers', privacy: 'No spam.', incentive: '10% off your next order' }, ar: { label: '  ' } },
    });
    expect(saved.settings.text.en).toEqual({ label: 'Get our offers', privacy: 'No spam.', incentive: '10% off your next order' });
    expect(saved.settings.text.ar.label).toBeNull();
    const page = await request(app).get(`/api/v1/store/${s.ws}`);
    expect(page.body.store.emailSignup).toEqual({
      checkout: { preTicked: true },
      quickOrder: { preTicked: false },
      cart: { preTicked: true },
      footer: {},
      popup: { trigger: 'exit_intent', delaySeconds: 20 },
      text: saved.settings.text,
    });
  });

  it('drops the store’s cached pages on a save, as a publish does — a signup does not', async () => {
    const s = await store();
    const purge = jest.spyOn(cloudflarePurge, 'purgeStore').mockImplementation(() => undefined);
    await s.save(ON);
    expect(purge).toHaveBeenCalledWith(s.ws, expect.anything());
    purge.mockClear();
    expect((await s.signup({ email: 'quiet@example.com', source: 'footer' })).status).toBe(200);
    expect(purge).not.toHaveBeenCalled();
  });
});

describe('the footer and popup signup', () => {
  it('takes a signup only from a place switched on, and validates the address on the server', async () => {
    const s = await store();
    expect((await s.signup({ email: 'a@example.com', source: 'footer' })).status).toBe(404);
    await s.save({ footer: { enabled: true } });
    expect((await s.signup({ email: 'a@example.com', source: 'popup' })).status).toBe(404);
    expect((await s.signup({ email: 'not-an-address', source: 'footer' })).status).toBe(422);
    expect((await s.signup({ email: '', source: 'footer' })).status).toBe(422);
    expect((await s.signup({ email: 'a@example.com' })).status).toBe(422);
    expect((await s.signup({ email: 'a@example.com', source: 'checkout' })).status).toBe(422);
    const ok = await s.signup({ email: '  New.Person@Example.COM ', source: 'footer' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    const row = await db.EmailSubscriber.findOne({ where: { workspaceId: s.ws } });
    expect(row).toEqual(expect.objectContaining({ email: 'new.person@example.com', source: 'footer', marketingConsent: true }));
    // Nothing is sent on a signup.
    expect(sent).toHaveLength(0);
    // No lead for the automations either: a subscriber is not a customer.
    expect(await db.Customer.count({ where: { workspaceId: s.ws, email: 'new.person@example.com' } })).toBe(0);
  });

  it('answers a bot that filled the honeypot like anyone else, and keeps nothing', async () => {
    const s = await store();
    await s.save(ON);
    const bot = await s.signup({ email: 'bot@example.com', source: 'popup', website: 'http://spam.example' });
    expect(bot.status).toBe(200);
    expect(bot.body).toEqual({ ok: true });
    expect(await db.EmailSubscriber.count({ where: { workspaceId: s.ws } })).toBe(0);
  });

  it('answers the same whether the address is new, a customer’s or already subscribed', async () => {
    const s = await store();
    await s.save(ON);
    await customer(s.ws, { email: 'known@example.com' });
    const answers = [];
    for (const email of ['fresh@example.com', 'known@example.com', 'fresh@example.com']) {
      const res = await s.signup({ email, source: 'footer' });
      answers.push({ status: res.status, body: res.body });
    }
    expect(answers).toEqual([
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true } },
    ]);
  });

  it('gives a known customer the consent with its source, and lifts an earlier unsubscribe', async () => {
    const s = await store();
    await s.save(ON);
    const c = await customer(s.ws, { email: 'Back.Again@example.com' });
    await db.MarketingOptOut.create({ workspaceId: s.ws, email: 'back.again@example.com', source: 'email', word: 'unsubscribe' });
    expect((await s.signup({ email: 'back.again@example.com', source: 'popup' })).status).toBe(200);
    await c.reload();
    expect(c.marketingConsent).toBe(true);
    expect(c.marketingConsentSource).toBe('popup');
    expect(await db.MarketingOptOut.count({ where: { workspaceId: s.ws, email: 'back.again@example.com' } })).toBe(0);
    // A customer has the address: no subscriber row besides.
    expect(await db.EmailSubscriber.count({ where: { workspaceId: s.ws } })).toBe(0);
    // A consent already given keeps the source it came with.
    await s.signup({ email: 'back.again@example.com', source: 'footer' });
    expect((await c.reload()).marketingConsentSource).toBe('popup');
  });

  it('writes the consent once, however many times the address signs up', async () => {
    const s = await store();
    await s.save(ON);
    for (let i = 0; i < 3; i += 1) expect((await s.signup({ email: 'twice@example.com', source: i ? 'popup' : 'footer' })).status).toBe(200);
    const rows = await db.EmailSubscriber.findAll({ where: { workspaceId: s.ws } });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('footer');
    expect(await db.AuditLog.count({ where: { workspaceId: s.ws, action: 'customer.marketing_consent.given' } })).toBe(1);
  });

  it('records where each consent came from, and counts them in the settings section', async () => {
    const s = await store();
    await s.save({ ...ON, cart: { enabled: true } });
    await s.signup({ email: 'f1@example.com', source: 'footer' });
    await s.signup({ email: 'f2@example.com', source: 'footer' });
    await s.signup({ email: 'p1@example.com', source: 'popup' });
    await customer(s.ws, { email: 'old@example.com', consent: true });
    const { body } = await s.staff('get');
    expect(body.stats).toEqual({ subscribers: 4, bySource: { checkout: 0, quick_order: 0, cart: 0, footer: 2, popup: 1, other: 1 } });
  });

  it('never writes the address to the log', async () => {
    const s = await store();
    await s.save(ON);
    const lines = [];
    for (const level of ['info', 'warn', 'error', 'debug']) jest.spyOn(logger, level).mockImplementation((...args) => lines.push(JSON.stringify(args)));
    await s.signup({ email: 'private.person@example.com', source: 'footer' });
    await s.signup({ email: 'private.person@example.com', source: 'popup', website: 'x' });
    expect(lines.join('\n')).not.toContain('private.person');
  });

  it('is limited per address and per store', async () => {
    // The routes carry both limiters.
    const layer = require('../../src/modules/emailCampaigns/campaignRoutes').store.stack.find((l) => l.route && l.route.path === '/email-signup');
    const handlers = layer.route.stack.map((h) => h.handle);
    expect(handlers).toContain(emailSignupLimiters.perIp);
    expect(handlers).toContain(emailSignupLimiters.perStore);
    // Every limiter is skipped under NODE_ENV=test, so these are built the same way without it.
    const limits = createEmailSignupLimiters({ perIpPerMinute: 2, perStorePerMinute: 3 });
    const small = express();
    small.set('trust proxy', 1);
    small.post('/:workspaceId/signup', limits.perIp, limits.perStore, (req, res) => res.json({ ok: true }));
    small.use(errorHandler);
    const from = (store, ip) => supertest(small).post(`/${store}/signup`).set('X-Forwarded-For', ip);
    const statuses = async (n, store, ip) => {
      const out = [];
      for (let i = 0; i < n; i += 1) out.push((await from(store, ip)).status);
      return out;
    };
    expect(await statuses(3, 'store-a', '198.51.100.10')).toEqual([200, 200, 429]);
    // Another address, same store: its own two, until the store's three are used.
    expect(await statuses(2, 'store-a', '198.51.100.11')).toEqual([200, 429]);
    // Another store is not touched.
    expect(await statuses(1, 'store-b', '198.51.100.10')).toEqual([200]);
  });
});

describe('the boxes at checkout, per place and ticked or not', () => {
  // One phone per address, so a second order is the same customer.
  const phones = new Map();
  const phoneOf = (email) => {
    if (!phones.has(email)) phones.set(email, `0109${String(1000000 + phones.size + 1).slice(-7)}`);
    return phones.get(email);
  };
  const checkout = (s, body = {}, email = 'boxed@example.com') => {
    return request(app)
      .post(`/api/v1/store/${s.ws}/checkout`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        item: { variantId: s.variant.id, quantity: 1 },
        contact: { fullName: 'Box Person', phone: phoneOf(email), email },
        shippingAddress: { country: 'EG', province: 'القاهرة (Cairo)', city: 'Cairo', addressLine: '1 Street' },
        paymentMethod: 'cod',
        ...body,
      });
  };
  const customerOf = (s, email) => db.Customer.findOne({ where: { workspaceId: s.ws, email } });

  it('records consent only when the box was ticked at the order, whether it started ticked or not', async () => {
    const s = await store();
    await s.save({ checkout: { enabled: true, preTicked: true } });
    // Pre-ticked, then unticked by the shopper: the order carries no consent and none is recorded.
    expect((await checkout(s, {}, 'unticked@example.com')).status).toBe(201);
    expect((await checkout(s, { marketingConsent: false }, 'unticked@example.com')).status).toBe(201);
    expect((await customerOf(s, 'unticked@example.com')).marketingConsent).toBe(false);
    // Left ticked: recorded, from the checkout.
    expect((await checkout(s, { marketingConsent: true }, 'ticked@example.com')).status).toBe(201);
    const ticked = await customerOf(s, 'ticked@example.com');
    expect(ticked.marketingConsent).toBe(true);
    expect(ticked.marketingConsentSource).toBe('checkout');
  });

  it('takes the quick order form’s and the cart’s box only while that place is on', async () => {
    const s = await store();
    expect((await checkout(s, { marketingConsent: true, marketingConsentSource: 'quick_order' }, 'quick@example.com')).status).toBe(201);
    expect((await checkout(s, { marketingConsent: true, marketingConsentSource: 'cart' }, 'cart@example.com')).status).toBe(201);
    expect((await customerOf(s, 'quick@example.com')).marketingConsent).toBe(false);
    expect((await customerOf(s, 'cart@example.com')).marketingConsent).toBe(false);

    await s.save({ quickOrder: { enabled: true, preTicked: true }, cart: { enabled: true } });
    await checkout(s, { marketingConsent: true, marketingConsentSource: 'quick_order' }, 'quick@example.com');
    await checkout(s, { marketingConsent: true, marketingConsentSource: 'cart' }, 'cart@example.com');
    expect(await customerOf(s, 'quick@example.com')).toEqual(expect.objectContaining({ marketingConsent: true, marketingConsentSource: 'quick_order' }));
    expect(await customerOf(s, 'cart@example.com')).toEqual(expect.objectContaining({ marketingConsent: true, marketingConsentSource: 'cart' }));
    // A source the checkout doesn't know is refused, never guessed.
    expect((await checkout(s, { marketingConsent: true, marketingConsentSource: 'footer' })).status).toBe(422);
  });

  it('ignores the checkout box once the merchant switches it off', async () => {
    const s = await store();
    await s.save({ checkout: { enabled: false } });
    expect((await checkout(s, { marketingConsent: true }, 'off@example.com')).status).toBe(201);
    expect((await customerOf(s, 'off@example.com')).marketingConsent).toBe(false);
  });

  it('carries a footer signup over to the customer when they order later, even with the box unticked', async () => {
    const s = await store();
    await s.save(ON);
    await s.signup({ email: 'later.buyer@example.com', source: 'footer' });
    expect((await checkout(s, {}, 'later.buyer@example.com')).status).toBe(201);
    expect(await customerOf(s, 'later.buyer@example.com')).toEqual(expect.objectContaining({ marketingConsent: true, marketingConsentSource: 'footer' }));
    expect((await s.staff('get')).body.stats).toEqual(expect.objectContaining({ subscribers: 1, bySource: expect.objectContaining({ footer: 1 }) }));
  });
});

describe('subscribers in a campaign', () => {
  it('reaches a footer subscriber with “everyone subscribed”, and their unsubscribe sticks until they sign up again', async () => {
    const s = await store();
    await s.save(ON);
    await s.signup({ email: 'listener@example.com', source: 'footer' });
    await customer(s.ws, { email: 'buyer@example.com', consent: true });
    const api = (method, path) => request(app)[method](`/api/v1/workspaces/${s.ws}/email-campaigns${path}`).set(bearer(s.auth.accessToken));
    const audience = await api('post', '/audience').send({ audience: { type: 'all' } });
    expect(audience.body).toEqual({ count: 2, subscribed: 2 });
    // Rules read orders: a subscriber without orders is not in them.
    expect((await api('post', '/audience').send({ audience: { type: 'rules', rules: { minOrders: 0 } } })).body.count).toBe(1);

    const draft = await api('post', '/').send({ name: 'Hello', subject: 'Hello', blocks: [{ type: 'text', text: 'Hi' }] });
    expect((await api('post', `/${draft.body.campaign.id}/send`)).status).toBe(200);
    expect(sent.map((m) => m.to).sort()).toEqual(['buyer@example.com', 'listener@example.com']);
    const row = await db.EmailCampaignRecipient.findOne({ where: { campaignId: draft.body.campaign.id, email: 'listener@example.com' } });
    expect(row.customerId).toBeNull();
    expect(row.status).toBe('sent');

    const token = tokens.tokenFor(s.ws, row.id);
    expect((await request(app).post('/api/v1/email-campaigns/unsubscribe').query({ t: token })).status).toBe(200);
    expect((await db.EmailSubscriber.findOne({ where: { workspaceId: s.ws, email: 'listener@example.com' } })).marketingConsent).toBe(false);
    expect((await api('post', '/audience').send({ audience: { type: 'all' } })).body.count).toBe(1);

    await s.signup({ email: 'listener@example.com', source: 'popup' });
    const back = await db.EmailSubscriber.findOne({ where: { workspaceId: s.ws, email: 'listener@example.com' } });
    expect(back).toEqual(expect.objectContaining({ marketingConsent: true, source: 'popup' }));
    expect((await api('post', '/audience').send({ audience: { type: 'all' } })).body.count).toBe(2);
  });

  it('leaves a subscriber out once a customer with the address exists without consent', async () => {
    const s = await store();
    await s.save(ON);
    await s.signup({ email: 'shared@example.com', source: 'footer' });
    await customer(s.ws, { email: 'Shared@Example.com', consent: false });
    const res = await request(app).post(`/api/v1/workspaces/${s.ws}/email-campaigns/audience`).set(bearer(s.auth.accessToken)).send({ audience: { type: 'all' } });
    expect(res.body.count).toBe(0);
  });
});
