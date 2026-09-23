'use strict';

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const billingService = require('../../src/modules/billing/billingService');
const { signPayload, SIGNATURE_HEADER } = require('../../src/modules/billing/gatewaySignature');

// The gateway webhook is authenticated by an HMAC over the raw body, so every
// call here signs its payload with a test secret. env is mutated in place (the
// same way mediaR2Storage.test.js switches storage provider) because the
// verifier reads the value per request.
const TEST_SECRET = 'test_billing_webhook_secret_0123456789';
const ORIGINAL_SECRET = env.billing.webhookSecret;

/**
 * POSTs a webhook, correctly signed by default. Pass `signature` to send a
 * specific header value (or null for none), or `secret` to sign with the
 * wrong key. The body goes out pre-serialised so the bytes signed are exactly
 * the bytes sent.
 */
function postWebhook(payload, { signature, secret } = {}) {
  const raw = JSON.stringify(payload);
  const req = request(app).post('/api/v1/billing/webhook').type('json');
  const header = signature === undefined ? signPayload(raw, secret || TEST_SECRET) : signature;
  if (header !== null) req.set(SIGNATURE_HEADER, header);
  return req.send(raw);
}

// The global beforeEach (tests/helpers/setup.js) truncates every table first;
// re-seed the default plans after that so workspace creation picks a real plan.
beforeEach(async () => {
  env.billing.webhookSecret = TEST_SECRET;
  await billingService.seedDefaultPlans();
});

afterAll(() => {
  env.billing.webhookSecret = ORIGINAL_SECRET;
});

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Billing Co');
  return {
    auth,
    workspace,
    wid: workspace.id,
    userId: auth.userId,
    H: { Authorization: `Bearer ${auth.accessToken}` },
  };
}

const subOf = (wid) => db.Subscription.findOne({ where: { workspaceId: wid } });

describe('subscription scaffolding (no gateway)', () => {
  it('a new workspace starts on a trialing subscription with a ~14-day trial end and no gateway id', async () => {
    const before = Date.now();
    const { wid } = await setup();

    const sub = await subOf(wid);
    expect(sub).not.toBeNull();
    expect(sub.status).toBe('trialing');
    expect(sub.externalSubscriptionId).toBeNull();
    expect(sub.externalProvider).toBeNull();
    expect(sub.planId).not.toBeNull(); // 'free' plan seeded in beforeEach

    const days = (new Date(sub.currentPeriodEnd).getTime() - before) / 86400000;
    expect(days).toBeGreaterThan(13.5);
    expect(days).toBeLessThan(14.5);
  });

  it('the webhook flips subscription status on mapped events when the signature checks out', async () => {
    const { wid } = await setup();

    const activated = await postWebhook({ type: 'subscription.activated', data: { workspaceId: wid } });
    expect(activated.status).toBe(200);
    expect(activated.body.handled).toBe(true);
    expect((await subOf(wid)).status).toBe('active');

    await postWebhook({ type: 'payment.failed', data: { workspaceId: wid } });
    expect((await subOf(wid)).status).toBe('past_due');

    await postWebhook({ type: 'subscription.canceled', data: { workspaceId: wid } });
    expect((await subOf(wid)).status).toBe('cancelled');
  });

  it('the webhook is a safe no-op for an unmapped event type', async () => {
    const { wid } = await setup();
    const res = await postWebhook({ type: 'invoice.paid', data: { workspaceId: wid } });
    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(false);
  });

  it('blocks creating new pages/funnels once the subscription lapses, but keeps a live storefront serving buyers', async () => {
    const { wid, H } = await setup();

    // Publish a store while still trialing.
    const provisioned = await request(app)
      .post(`/api/v1/workspaces/${wid}/quickstart`)
      .set(H)
      .type('form')
      .send({ template: 'light', productName: 'Live Widget', price: '50.00', description: 'still selling' });
    expect(provisioned.status).toBe(200);

    // Lapse it.
    await postWebhook({ type: 'subscription.canceled', data: { workspaceId: wid } });

    // Mutating actions are blocked with a clear error.
    const blockedSite = await request(app)
      .post(`/api/v1/workspaces/${wid}/websites`)
      .set(H)
      .send({ name: 'Another site' });
    expect(blockedSite.status).toBe(402);
    expect(blockedSite.body.error.code).toBe('SUBSCRIPTION_REQUIRED');

    const blockedFunnel = await request(app).post(`/api/v1/workspaces/${wid}/funnels`).set(H).send({ name: 'F' });
    expect(blockedFunnel.status).toBe(402);

    // The already-published storefront is untouched — never break a live campaign over billing.
    const shop = await request(app).get(`/shop/${wid}`);
    expect(shop.status).toBe(200);
    expect(shop.text).toContain('Live Widget');
  });

  it('the trial-expiry sweep flips a lapsed trial to past_due', async () => {
    const { wid } = await setup();
    await db.Subscription.update(
      { currentPeriodEnd: new Date(Date.now() - 86400000) },
      { where: { workspaceId: wid } }
    );

    const res = await billingService.expireStaleTrials();
    expect(res.expired).toBeGreaterThanOrEqual(1);
    expect((await subOf(wid)).status).toBe('past_due');
  });

  it('a platform admin can list all workspaces with plan/status; a normal user is refused', async () => {
    const { wid, H, userId } = await setup();

    const denied = await request(app).get('/api/v1/admin/workspaces').set(H);
    expect(denied.status).toBe(403);

    await db.User.update({ platformAdmin: true }, { where: { id: userId } });
    const ok = await request(app).get('/api/v1/admin/workspaces').set(H);
    expect(ok.status).toBe(200);

    const row = ok.body.workspaces.find((w) => w.id === wid);
    expect(row).toBeDefined();
    expect(row.name).toBe('Billing Co');
    expect(row.subscriptionStatus).toBe('trialing');
    expect(row).toHaveProperty('orderCount');
    // The admin client treats a row as a Workspace, so the entity fields
    // have to be present and correctly named.
    expect(row.slug).toEqual(expect.any(String));
    expect(row.defaultCurrency).toEqual(expect.any(String));
    expect(row.createdAt).toBeTruthy();
  });

  it('renders the platform-admin dashboard as HTML', async () => {
    const { H, userId } = await setup();
    await db.User.update({ platformAdmin: true }, { where: { id: userId } });

    const res = await request(app).get('/api/v1/admin/dashboard').set(H);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toMatch(/Platform admin/);
    expect(res.text).toContain('Billing Co');
  });
});

describe('billing webhook signature', () => {
  it('processes a correctly signed webhook', async () => {
    const { wid } = await setup();
    const res = await postWebhook({ type: 'subscription.activated', data: { workspaceId: wid } });
    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(true);
    expect((await subOf(wid)).status).toBe('active');
  });

  it('rejects a webhook with no signature header', async () => {
    const { wid } = await setup();
    const res = await postWebhook({ type: 'subscription.canceled', data: { workspaceId: wid } }, { signature: null });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect((await subOf(wid)).status).toBe('trialing'); // nothing was applied
  });

  it('rejects a webhook signed with the wrong secret', async () => {
    const { wid } = await setup();
    const res = await postWebhook(
      { type: 'subscription.canceled', data: { workspaceId: wid } },
      { secret: 'not_the_configured_secret' }
    );
    expect(res.status).toBe(401);
    expect((await subOf(wid)).status).toBe('trialing');
  });

  it('rejects a signature of the right length but the wrong bytes', async () => {
    const { wid } = await setup();
    const payload = { type: 'subscription.canceled', data: { workspaceId: wid } };
    const valid = signPayload(JSON.stringify(payload), TEST_SECRET);
    const tampered = (valid[0] === 'a' ? 'b' : 'a') + valid.slice(1);
    const res = await postWebhook(payload, { signature: tampered });
    expect(res.status).toBe(401);
    expect((await subOf(wid)).status).toBe('trialing');
  });

  it('rejects a body that was tampered with after it was signed', async () => {
    const { wid } = await setup();
    const signed = signPayload(JSON.stringify({ type: 'payment.failed', data: { workspaceId: wid } }), TEST_SECRET);
    const res = await request(app)
      .post('/api/v1/billing/webhook')
      .type('json')
      .set(SIGNATURE_HEADER, signed)
      .send(JSON.stringify({ type: 'subscription.canceled', data: { workspaceId: wid } }));
    expect(res.status).toBe(401);
    expect((await subOf(wid)).status).toBe('trialing');
  });

  it('rejects every webhook when BILLING_WEBHOOK_SECRET is unset — an unsigned one is never accepted', async () => {
    const { wid } = await setup();
    const payload = { type: 'subscription.activated', data: { workspaceId: wid } };
    const signedWithOldSecret = signPayload(JSON.stringify(payload), TEST_SECRET);

    env.billing.webhookSecret = '';
    try {
      expect((await postWebhook(payload, { signature: null })).status).toBe(401);
      expect((await postWebhook(payload, { signature: signedWithOldSecret })).status).toBe(401);
    } finally {
      env.billing.webhookSecret = TEST_SECRET;
    }

    expect((await subOf(wid)).status).toBe('trialing');
  });
});
