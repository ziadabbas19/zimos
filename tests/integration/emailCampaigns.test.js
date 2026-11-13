'use strict';

// Email campaigns (modules/emailCampaigns, migration 748, EMAIL_CAMPAIGNS_ENABLED):
// the staff routes and who may use them, the audience (consent, opt-outs,
// suppressions, segments), the monthly quota and the daily cap, sending in
// batches with retries and without ever sending twice, a restart mid-way,
// cancelling, scheduling, the unsubscribe link and one-click POST, the
// provider's reports through the signed webhook, the checkout's consent box,
// the preview and the test email.

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct, createProductWithVariant, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const logger = require('../../src/core/utils/logger');
const providers = require('../../src/modules/emailCampaigns/campaignProviders');
const sender = require('../../src/modules/emailCampaigns/campaignSender');
const tokens = require('../../src/modules/emailCampaigns/campaignTokens');

const ORIGINAL = {
  enabled: env.emailCampaigns.enabled,
  batchSize: env.emailCampaigns.batchSize,
  cap: env.emailCampaigns.storeDailyCap,
  growth: env.growth.requirePlanFeature,
  enforcement: env.planFeatures.enforcement,
  webhookToken: env.notifications.brevo.webhookToken,
  features: [...env.storeFeatures],
};
let sent;
beforeEach(() => {
  env.emailCampaigns.enabled = true;
  sent = [];
  jest.spyOn(providers.PROVIDERS.log, 'send').mockImplementation(async (message) => {
    const messageId = `log-${crypto.randomUUID()}`;
    sent.push({ ...message, messageId });
    return { messageId };
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  env.emailCampaigns.enabled = ORIGINAL.enabled;
  env.emailCampaigns.batchSize = ORIGINAL.batchSize;
  env.emailCampaigns.storeDailyCap = ORIGINAL.cap;
  env.growth.requirePlanFeature = ORIGINAL.growth;
  env.planFeatures.enforcement = ORIGINAL.enforcement;
  env.notifications.brevo.webhookToken = ORIGINAL.webhookToken;
  env.storeFeatures.splice(0, env.storeFeatures.length, ...ORIGINAL.features);
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const BLOCKS = [
  { type: 'heading', text: 'Summer sale' },
  { type: 'text', text: 'Everything is 20% off this week.' },
  { type: 'button', label: 'Shop now', url: 'https://shop.example.com/sale' },
];

async function setQuota(workspaceId, max, features = []) {
  const sub = await db.Subscription.findOne({ where: { workspaceId } });
  const plan = await db.Plan.create({
    key: `plan-${crypto.randomUUID().slice(0, 8)}`,
    name: 'Campaign plan',
    monthlyPriceAmount: 0,
    yearlyPriceAmount: 0,
    features,
    maxCampaignEmailsPerMonth: max,
  });
  await sub.update({ planId: plan.id });
  return plan;
}

let phoneCounter = 0;
async function customer(workspaceId, { email, consent = true, ...rest } = {}) {
  phoneCounter += 1;
  return db.Customer.create({
    workspaceId,
    phoneNormalized: `2010${String(10000000 + phoneCounter).slice(-8)}`,
    phoneRaw: `010${String(10000000 + phoneCounter).slice(-8)}`,
    fullName: rest.fullName || 'Campaign Customer',
    email,
    marketingConsent: consent,
    ...rest,
  });
}

async function store({ quota = 100 } = {}) {
  const ctx = await setupWorkspaceWithProduct({ price: 15000, stock: 20 });
  const ws = ctx.workspace.id;
  if (quota !== undefined) await setQuota(ws, quota);
  const api = (method, path, token = ctx.auth.accessToken) => request(app)[method](`/api/v1/workspaces/${ws}/email-campaigns${path}`).set(bearer(token));
  const draft = async (extra = {}) => {
    const res = await api('post', '/').send({ name: 'November sale', subject: 'Sale this week', blocks: BLOCKS, ...extra });
    if (res.status !== 201) throw new Error(`create: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.campaign;
  };
  return { ...ctx, ws, api, draft };
}

const rowsOf = (campaignId) => db.EmailCampaignRecipient.findAll({ where: { campaignId }, order: [['email', 'ASC']] });
const campaignRow = (id) => db.EmailCampaign.findByPk(id);

describe('the switch and who may use it', () => {
  it('answers 404 everywhere while EMAIL_CAMPAIGNS_ENABLED is off', async () => {
    env.emailCampaigns.enabled = false;
    const s = await store();
    expect((await s.api('get', '/')).status).toBe(404);
    expect((await s.api('post', '/').send({ name: 'x' })).status).toBe(404);
    expect((await request(app).post('/api/v1/email-campaigns/unsubscribe').query({ t: 'c1.x.y' })).status).toBe(404);
  });

  it('needs discounts.manage, and never reaches another store’s campaign', async () => {
    const s = await store();
    const campaign = await s.draft();
    const editor = await addMemberWithRole(s.auth.accessToken, s.ws, 'editor');
    expect((await s.api('get', '/', editor.accessToken)).status).toBe(403);
    expect((await s.api('post', `/${campaign.id}/send`, editor.accessToken)).status).toBe(403);

    const other = await store();
    // Their own store's address, this store's campaign id: not found.
    const theirs = await other.api('get', `/${campaign.id}`);
    expect(theirs.status).toBe(404);
    expect((await other.api('patch', `/${campaign.id}`).send({ name: 'Taken' })).status).toBe(404);
    expect((await other.api('post', `/${campaign.id}/send`)).status).toBe(404);
    expect((await other.api('delete', `/${campaign.id}`)).status).toBe(404);
    expect((await other.api('get', `/${campaign.id}/recipients`)).status).toBe(404);
    // This store's address with their token: not a member.
    expect((await s.api('get', `/${campaign.id}`, other.auth.accessToken)).status).toBe(404);
    expect((await other.api('get', '/')).body.campaigns).toEqual([]);
  });

  it('is locked by the plan like combos while GROWTH_REQUIRE_PLAN_FEATURE is on', async () => {
    const s = await store();
    env.growth.requirePlanFeature = true;
    env.planFeatures.enforcement = true;
    const locked = await s.api('get', '/');
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe('PLAN_FEATURE_REQUIRED');
    await setQuota(s.ws, 100, ['email_campaigns']);
    expect((await s.api('get', '/')).status).toBe(200);
  });
});

describe('drafts and their content', () => {
  it('creates a draft in the store’s language and edits it', async () => {
    const s = await store();
    const campaign = await s.draft();
    expect(campaign).toEqual(expect.objectContaining({ status: 'draft', locale: 'ar', audience: { type: 'all' }, subject: 'Sale this week' }));
    const edited = await s.api('patch', `/${campaign.id}`).send({ locale: 'en', preheader: 'Only this week', audience: { type: 'rules', rules: { minOrders: 1 } } });
    expect(edited.status).toBe(200);
    expect(edited.body.campaign).toEqual(expect.objectContaining({ locale: 'en', preheader: 'Only this week', audience: { type: 'rules', rules: { minOrders: 1 } } }));
    const list = await s.api('get', '/');
    expect(list.body.campaigns.map((c) => c.id)).toEqual([campaign.id]);
  });

  it('takes only checked blocks: no raw HTML, http(s) links only, one-line subjects', async () => {
    const s = await store();
    const bad = [
      { blocks: [{ type: 'html', html: '<script>alert(1)</script>' }] },
      { blocks: [{ type: 'button', label: 'Go', url: 'javascript:alert(1)' }] },
      { blocks: [{ type: 'image', url: 'data:image/png;base64,AAAA' }] },
      { subject: 'Hello\r\nBcc: everyone@example.com' },
      { blocks: [{ type: 'products', productIds: [] }] },
      { audience: { type: 'segment' } },
    ];
    for (const body of bad) {
      const res = await s.api('post', '/').send({ name: 'Bad', ...body });
      expect([res.status, JSON.stringify(body)]).toEqual([422, JSON.stringify(body)]);
    }
    // An unknown field on a block is dropped, not stored.
    const res = await s.api('post', '/').send({ name: 'Ok', blocks: [{ type: 'text', text: 'Hi', html: '<b>x</b>' }] });
    expect(res.status).toBe(201);
    expect(res.body.campaign.blocks).toEqual([{ type: 'text', text: 'Hi' }]);
  });

  it('previews the email escaped, right-to-left, with the store’s own products only', async () => {
    const s = await store();
    const other = await setupWorkspaceWithProduct();
    const res = await s.api('post', '/preview').send({
      subject: 'Offer',
      locale: 'ar',
      blocks: [
        { type: 'text', text: '<img src=x onerror=alert(1)> عرض خاص' },
        { type: 'products', productIds: [s.product.id, other.product.id] },
      ],
    });
    expect(res.status).toBe(200);
    const { html, text } = res.body.preview;
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('Test Product');
    expect((html.match(/Test Product/g) || []).length).toBeGreaterThan(0);
    // The other store's product (same name in the factory) is not there: one product card.
    expect((html.match(/<td valign="top" width="50%"/g) || []).length).toBe(1);
    expect(text).toContain('عرض خاص');
    expect(text).toContain('إلغاء الاشتراك');
  });

  it('sends a test to the teammate’s own address only, outside the quota', async () => {
    const s = await store({ quota: 0 });
    const res = await s.api('post', '/test').send({ subject: 'Try', blocks: BLOCKS, locale: 'en' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, to: s.auth.email });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(s.auth.email);
    expect(sent[0].subject).toBe('[Test] Try');
    // A `to` in the body is ignored: never anyone else's inbox.
    await s.api('post', '/test').send({ subject: 'Try', blocks: BLOCKS, to: 'someone@else.com' });
    expect(sent.map((m) => m.to)).toEqual([s.auth.email, s.auth.email]);
    expect(await db.EmailCampaignRecipient.count()).toBe(0);
  });
});

describe('the audience', () => {
  it('reaches only consenting customers with an address, never opted out, suppressed, blocked or of another store', async () => {
    const s = await store();
    const other = await store();
    await customer(s.ws, { email: 'yes1@example.com' });
    await customer(s.ws, { email: 'YES2@Example.com ' });
    await customer(s.ws, { email: 'yes2@example.com' }); // the same address twice: one email
    await customer(s.ws, { email: 'no-consent@example.com', consent: false });
    await customer(s.ws, { email: null });
    await customer(s.ws, { email: 'not-an-address' });
    await customer(s.ws, { email: 'unsub@example.com' });
    await db.MarketingOptOut.create({ workspaceId: s.ws, email: 'unsub@example.com', source: 'email' });
    const stop = await customer(s.ws, { email: 'stop@example.com' });
    await db.MarketingOptOut.create({ workspaceId: s.ws, phoneNormalized: stop.phoneNormalized, source: 'whatsapp' });
    await customer(s.ws, { email: 'bounced@example.com' });
    await db.EmailSuppression.create({ workspaceId: s.ws, email: 'bounced@example.com', reason: 'hard_bounce', source: 'brevo' });
    await customer(s.ws, { email: 'blacklisted@example.com', isBlacklisted: true });
    await customer(s.ws, { email: 'blocked@example.com' });
    await db.BlockedEntry.create({ workspaceId: s.ws, type: 'email', value: 'blocked@example.com', label: 'blocked@example.com', scope: 'orders' });
    await customer(other.ws, { email: 'theirs@example.com' });

    const res = await s.api('post', '/audience').send({ audience: { type: 'all' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 2, subscribed: 2 });

    const campaign = await s.draft();
    const started = await s.api('post', `/${campaign.id}/send`);
    expect(started.status).toBe(200);
    expect((await rowsOf(campaign.id)).map((r) => r.email)).toEqual(['yes1@example.com', 'yes2@example.com']);
    expect(sent.map((m) => m.to).sort()).toEqual(['yes1@example.com', 'yes2@example.com']);
  });

  it('narrows by orders and spend, and by a saved segment', async () => {
    const s = await store();
    const buyer = await customer(s.ws, { email: 'buyer@example.com' });
    await customer(s.ws, { email: 'lead@example.com' });
    // One COD order for the buyer, placed through the checkout with the buyer's phone.
    const order = await request(app)
      .post(`/api/v1/store/${s.ws}/checkout`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        item: { variantId: s.variant.id, quantity: 2 },
        contact: { fullName: 'Buyer', phone: buyer.phoneRaw },
        shippingAddress: { country: 'EG', province: 'القاهرة (Cairo)', city: 'Cairo', addressLine: '1 Street' },
        paymentMethod: 'cod',
      });
    expect(order.status).toBe(201);

    const count = async (audience) => (await s.api('post', '/audience').send({ audience })).body.count;
    expect(await count({ type: 'rules', rules: { minOrders: 1 } })).toBe(1);
    expect(await count({ type: 'rules', rules: { maxOrders: 0 } })).toBe(1);
    expect(await count({ type: 'rules', rules: { minSpent: 30000 } })).toBe(1);
    expect(await count({ type: 'rules', rules: { minSpent: 10000000 } })).toBe(0);

    const segment = await db.Segment.create({ workspaceId: s.ws, name: 'Buyers', rules: { type: 'customer' } });
    expect(await count({ type: 'segment', segmentId: segment.id })).toBe(1);
    const otherStore = await store();
    const foreign = await db.Segment.create({ workspaceId: otherStore.ws, name: 'Theirs', rules: {} });
    expect((await s.api('post', '/audience').send({ audience: { type: 'segment', segmentId: foreign.id } })).status).toBe(422);
    // RFM groups only while the RFM feature is on.
    expect((await s.api('post', '/audience').send({ audience: { type: 'rfm', labels: ['champions'] } })).status).toBe(422);
    env.storeFeatures.push('rfm');
    expect((await s.api('post', '/audience').send({ audience: { type: 'rfm', labels: ['champions'] } })).status).toBe(200);
  });
});

describe('the monthly quota and the daily cap', () => {
  it('refuses a campaign that doesn’t fit the month, whole, and shows what is left', async () => {
    const s = await store({ quota: 3 });
    for (let i = 0; i < 4; i += 1) await customer(s.ws, { email: `q${i}@example.com` });
    const campaign = await s.draft();
    const refused = await s.api('post', `/${campaign.id}/send`);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('EMAIL_QUOTA_EXCEEDED');
    expect(refused.body.error.details).toEqual(expect.objectContaining({ needed: 4, remaining: 3, max: 3 }));
    expect(await db.EmailCampaignRecipient.count()).toBe(0);
    expect((await campaignRow(campaign.id)).status).toBe('draft');

    await setQuota(s.ws, 10);
    expect((await s.api('post', `/${campaign.id}/send`)).status).toBe(200);
    const overview = await s.api('get', '/overview');
    expect(overview.body.quota.monthly).toEqual(expect.objectContaining({ max: 10, used: 4, remaining: 6 }));
    expect(overview.body.quota.daily).toEqual(expect.objectContaining({ cap: env.emailCampaigns.storeDailyCap, used: 4 }));
    expect(overview.body.sender).toEqual(expect.objectContaining({ fromAddress: env.emailCampaigns.fromAddress }));

    // The month's 4 are used: a second campaign to the same 4 needs 4 and only 6 are left — fits; a third doesn't.
    const second = await s.draft({ name: 'Second' });
    expect((await s.api('post', `/${second.id}/send`)).status).toBe(200);
    const third = await s.draft({ name: 'Third' });
    expect((await s.api('post', `/${third.id}/send`)).body.error.code).toBe('EMAIL_QUOTA_EXCEEDED');
  });

  it('a plan with no number set sends nothing, and null is unlimited', async () => {
    const s = await store({ quota: 0 });
    await customer(s.ws, { email: 'one@example.com' });
    const campaign = await s.draft();
    const res = await s.api('post', `/${campaign.id}/send`);
    expect(res.body.error.code).toBe('EMAIL_QUOTA_EXCEEDED');
    expect(res.body.error.message).toBe('Your plan does not include email campaigns this month');
    await setQuota(s.ws, null);
    expect((await s.api('post', `/${campaign.id}/send`)).status).toBe(200);
    expect((await s.api('get', '/overview')).body.quota.monthly).toEqual(expect.objectContaining({ max: null, remaining: null }));
  });

  it('waits for the next day past the store’s daily cap, then goes on', async () => {
    env.emailCampaigns.storeDailyCap = 2;
    const s = await store();
    for (let i = 0; i < 3; i += 1) await customer(s.ws, { email: `cap${i}@example.com` });
    const campaign = await s.draft();
    await s.api('post', `/${campaign.id}/send`);
    let row = await campaignRow(campaign.id);
    expect(row.status).toBe('sending');
    expect(row.sentCount).toBe(2);
    expect(row.pausedUntil).toBeTruthy();
    expect(sent).toHaveLength(2);

    // The tick leaves it while paused.
    await sender.tick();
    expect(sent).toHaveLength(2);
    // Next day: yesterday's sends no longer count and the pause has passed.
    await db.sequelize.query("UPDATE email_campaign_recipients SET handed_at = handed_at - INTERVAL '2 days'");
    await row.update({ pausedUntil: new Date(Date.now() - 1000) });
    await sender.tick();
    row = await campaignRow(campaign.id);
    expect(row.status).toBe('sent');
    expect(row.sentCount).toBe(3);
    expect(sent).toHaveLength(3);
  });
});

describe('sending', () => {
  it('sends each address once, in batches, under the store’s name, with the unsubscribe headers and link', async () => {
    env.emailCampaigns.batchSize = 2;
    const s = await store();
    await db.Workspace.update({ settings: { order_email_sender: { replyTo: 'hello@store.example' } } }, { where: { id: s.ws } });
    for (let i = 0; i < 5; i += 1) await customer(s.ws, { email: `b${i}@example.com` });
    const infos = [];
    jest.spyOn(logger, 'info').mockImplementation((msg) => infos.push(String(msg)));
    const campaign = await s.draft();
    const res = await s.api('post', `/${campaign.id}/send`);
    expect(res.status).toBe(200);

    const row = await campaignRow(campaign.id);
    expect(row).toEqual(expect.objectContaining({ status: 'sent', recipientsCount: 5, sentCount: 5, failedCount: 0 }));
    expect(sent.map((m) => m.to).sort()).toEqual(['b0@example.com', 'b1@example.com', 'b2@example.com', 'b3@example.com', 'b4@example.com']);
    const m = sent[0];
    expect(m.fromName).toBe(s.workspace.name);
    expect(m.fromAddress).toBe(env.emailCampaigns.fromAddress);
    expect(m.replyTo).toBe('hello@store.example');
    expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(m.headers['List-Unsubscribe']).toMatch(/^<http.+\/api\/v1\/email-campaigns\/unsubscribe\?t=c1\./);
    expect(m.html).toMatch(/\/unsubscribe\?t=c1\./);
    expect(m.text).toMatch(/unsubscribe\?t=c1\./);
    const rows = await rowsOf(campaign.id);
    expect(rows.every((r) => r.status === 'sent' && r.attempts === 1 && r.providerMessageId && r.handedAt)).toBe(true);

    // Run again: nothing more goes out.
    await sender.sendBatch(campaign.id);
    await sender.tick();
    expect(sent).toHaveLength(5);
    // A started campaign can't be started again.
    expect((await s.api('post', `/${campaign.id}/send`)).status).toBe(409);
    // No address in the campaign's info lines.
    const ours = infos.filter((l) => l.includes('emailCampaigns'));
    expect(ours.length).toBeGreaterThan(0);
    for (const line of ours) expect(line).not.toMatch(/@example\.com/);
  });

  it('two batches running at once never send one address twice', async () => {
    env.emailCampaigns.batchSize = 50;
    const s = await store();
    for (let i = 0; i < 12; i += 1) await customer(s.ws, { email: `p${i}@example.com` });
    const campaign = await s.draft();
    // Rows queued without a batch: start's own batch is held back by turning the switch off for it.
    env.emailCampaigns.enabled = false;
    await sender.start(s.ws, campaign.id);
    env.emailCampaigns.enabled = true;
    expect(sent).toHaveLength(0);
    await Promise.all([sender.sendBatch(campaign.id), sender.sendBatch(campaign.id), sender.sendBatch(campaign.id)]);
    expect(sent).toHaveLength(12);
    expect(new Set(sent.map((x) => x.to)).size).toBe(12);
    expect((await campaignRow(campaign.id)).sentCount).toBe(12);
  });

  it('retries a 429 / 5xx later, fails a 4xx at once, and never retries a send that got no answer', async () => {
    const s = await store();
    for (const name of ['busy', 'bad', 'silent', 'fine']) await customer(s.ws, { email: `${name}@example.com` });
    providers.PROVIDERS.log.send.mockImplementation(async (message) => {
      const fail = (status, text) => Object.assign(new Error(text), status ? { status } : {}, { transient: !status || status >= 500 || status === 429 });
      if (message.to === 'busy@example.com' && !sent.some((x) => x.to === 'busy@example.com' && x.failed)) {
        sent.push({ ...message, failed: true });
        throw fail(503, 'Service unavailable');
      }
      if (message.to === 'bad@example.com') throw fail(400, 'invalid email');
      if (message.to === 'silent@example.com') throw fail(null, 'timed out after 10000ms');
      const messageId = `log-${crypto.randomUUID()}`;
      sent.push({ ...message, messageId });
      return { messageId };
    });
    const campaign = await s.draft();
    await s.api('post', `/${campaign.id}/send`);
    let rows = Object.fromEntries((await rowsOf(campaign.id)).map((r) => [r.email, r]));
    expect(rows['fine@example.com'].status).toBe('sent');
    expect(rows['bad@example.com']).toEqual(expect.objectContaining({ status: 'failed', attempts: 1 }));
    expect(rows['silent@example.com'].status).toBe('failed');
    expect(rows['silent@example.com'].error).toMatch(/not retried/);
    expect(rows['busy@example.com']).toEqual(expect.objectContaining({ status: 'queued', attempts: 1, handedAt: null }));
    expect(rows['busy@example.com'].nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20 * 1000);
    expect((await campaignRow(campaign.id)).status).toBe('sending');

    // Its time comes: the tick sends it.
    await db.EmailCampaignRecipient.update({ nextAttemptAt: new Date(Date.now() - 1000) }, { where: { campaignId: campaign.id, email: 'busy@example.com' } });
    await sender.tick();
    rows = Object.fromEntries((await rowsOf(campaign.id)).map((r) => [r.email, r]));
    expect(rows['busy@example.com']).toEqual(expect.objectContaining({ status: 'sent', attempts: 2 }));
    const done = await campaignRow(campaign.id);
    expect(done).toEqual(expect.objectContaining({ status: 'sent', sentCount: 2, failedCount: 2 }));
  });

  it('after a restart: an address never handed over goes out, one that may have gone is failed, not resent', async () => {
    const s = await store();
    for (const name of ['never', 'maybe', 'later']) await customer(s.ws, { email: `${name}@example.com` });
    const campaign = await s.draft();
    env.emailCampaigns.enabled = false;
    await sender.start(s.ws, campaign.id);
    env.emailCampaigns.enabled = true;
    const old = new Date(Date.now() - 20 * 60 * 1000);
    // A worker died mid-batch: one row claimed only, one handed to the provider.
    await db.EmailCampaignRecipient.update({ status: 'sending', claimedAt: old }, { where: { campaignId: campaign.id, email: 'never@example.com' } });
    await db.EmailCampaignRecipient.update({ status: 'sending', claimedAt: old, handedAt: old, attempts: 1 }, { where: { campaignId: campaign.id, email: 'maybe@example.com' } });
    await sender.tick();
    const rows = Object.fromEntries((await rowsOf(campaign.id)).map((r) => [r.email, r]));
    expect(rows['never@example.com'].status).toBe('sent');
    expect(rows['later@example.com'].status).toBe('sent');
    expect(rows['maybe@example.com']).toEqual(expect.objectContaining({ status: 'failed', error: 'interrupted: the worker stopped while sending' }));
    expect(sent.map((m) => m.to).sort()).toEqual(['later@example.com', 'never@example.com']);
    expect(await campaignRow(campaign.id)).toEqual(expect.objectContaining({ status: 'sent', sentCount: 2, failedCount: 1 }));
  });

  it('skips an address that unsubscribed after the campaign started', async () => {
    const s = await store();
    await customer(s.ws, { email: 'stays@example.com' });
    await customer(s.ws, { email: 'leaves@example.com' });
    const campaign = await s.draft();
    env.emailCampaigns.enabled = false;
    await sender.start(s.ws, campaign.id);
    env.emailCampaigns.enabled = true;
    await db.MarketingOptOut.create({ workspaceId: s.ws, email: 'leaves@example.com', source: 'email' });
    await sender.sendBatch(campaign.id);
    expect(sent.map((m) => m.to)).toEqual(['stays@example.com']);
    const row = await campaignRow(campaign.id);
    expect(row).toEqual(expect.objectContaining({ status: 'sent', sentCount: 1, skippedCount: 1 }));
    // A skipped address gives its email back to the month.
    expect((await s.api('get', '/overview')).body.quota.monthly.used).toBe(1);
  });

  it('cancels while sending: nothing queued goes out after it', async () => {
    env.emailCampaigns.storeDailyCap = 1;
    const s = await store();
    for (let i = 0; i < 3; i += 1) await customer(s.ws, { email: `c${i}@example.com` });
    const campaign = await s.draft();
    await s.api('post', `/${campaign.id}/send`);
    expect(sent).toHaveLength(1);
    const res = await s.api('post', `/${campaign.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.campaign.status).toBe('cancelled');
    await db.sequelize.query("UPDATE email_campaign_recipients SET handed_at = handed_at - INTERVAL '2 days'");
    await sender.tick();
    await sender.sendBatch(campaign.id);
    expect(sent).toHaveLength(1);
    const statuses = (await rowsOf(campaign.id)).map((r) => r.status).sort();
    expect(statuses).toEqual(['cancelled', 'cancelled', 'sent']);
    // Cancelled addresses don't use the month's quota.
    expect((await s.api('get', '/overview')).body.quota.monthly.used).toBe(1);
  });
});

describe('scheduling', () => {
  it('starts a scheduled campaign when its time comes, and can be put back to a draft before', async () => {
    const s = await store();
    await customer(s.ws, { email: 'later@example.com' });
    const campaign = await s.draft();
    const at = new Date(Date.now() + 2 * 3600 * 1000);
    expect((await s.api('post', `/${campaign.id}/schedule`).send({ scheduledAt: new Date(Date.now() + 1000).toISOString() })).status).toBe(422);
    const res = await s.api('post', `/${campaign.id}/schedule`).send({ scheduledAt: at.toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.campaign.status).toBe('scheduled');
    await sender.tick();
    expect(sent).toHaveLength(0);
    const back = await s.api('post', `/${campaign.id}/unschedule`);
    expect(back.body.campaign.status).toBe('draft');
    await s.api('post', `/${campaign.id}/schedule`).send({ scheduledAt: at.toISOString() });
    await sender.tick({ now: new Date(at.getTime() + 1000) });
    expect(sent.map((m) => m.to)).toEqual(['later@example.com']);
    expect((await campaignRow(campaign.id)).status).toBe('sent');
  });

  it('fails a scheduled campaign that no longer fits the quota when its time comes, sending nothing', async () => {
    const s = await store({ quota: 5 });
    await customer(s.ws, { email: 'one@example.com' });
    const campaign = await s.draft();
    const at = new Date(Date.now() + 3600 * 1000);
    await s.api('post', `/${campaign.id}/schedule`).send({ scheduledAt: at.toISOString() });
    await setQuota(s.ws, 0);
    await sender.tick({ now: new Date(at.getTime() + 1000) });
    const row = await campaignRow(campaign.id);
    expect(row).toEqual(expect.objectContaining({ status: 'failed', failureReason: 'quota_exceeded' }));
    expect(sent).toHaveLength(0);
  });
});

describe('unsubscribing', () => {
  async function sentCampaign(s, emails) {
    for (const email of emails) await customer(s.ws, { email });
    const campaign = await s.draft();
    await s.api('post', `/${campaign.id}/send`);
    const tokenOf = (to) => {
      const m = sent.find((x) => x.to === to);
      return decodeURIComponent(m.html.match(/\/unsubscribe\?t=(c1\.[^"&]+)/)[1]);
    };
    return { campaign, tokenOf };
  }

  it('from the store’s page: stops every later campaign, once, without signing in', async () => {
    const s = await store();
    const { campaign, tokenOf } = await sentCampaign(s, ['out@example.com', 'in@example.com']);
    const token = tokenOf('out@example.com');
    const res = await request(app).post(`/api/v1/store/${s.ws}/marketing/unsubscribe`).send({ token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, storeName: s.workspace.name });
    await request(app).post(`/api/v1/store/${s.ws}/marketing/unsubscribe`).send({ token });
    expect((await campaignRow(campaign.id)).unsubscribedCount).toBe(1);
    const out = await db.Customer.findOne({ where: { workspaceId: s.ws, email: 'out@example.com' } });
    expect(out.marketingConsent).toBe(false);
    expect(await db.MarketingOptOut.count({ where: { workspaceId: s.ws, email: 'out@example.com' } })).toBe(1);

    sent.length = 0;
    const next = await s.draft({ name: 'Next' });
    await s.api('post', `/${next.id}/send`);
    expect(sent.map((m) => m.to)).toEqual(['in@example.com']);
  });

  it('refuses a forged or altered link, and another store’s page', async () => {
    const s = await store();
    const other = await store();
    const { tokenOf } = await sentCampaign(s, ['x@example.com']);
    const token = tokenOf('x@example.com');
    const altered = `${token.slice(0, -2)}${token.endsWith('A') ? 'BB' : 'AA'}`;
    expect((await request(app).post(`/api/v1/store/${s.ws}/marketing/unsubscribe`).send({ token: altered })).status).toBe(404);
    const forged = tokens.tokenFor(s.ws, crypto.randomUUID());
    expect((await request(app).post(`/api/v1/store/${s.ws}/marketing/unsubscribe`).send({ token: forged })).status).toBe(404);
    expect((await request(app).post(`/api/v1/store/${other.ws}/marketing/unsubscribe`).send({ token })).status).toBe(404);
    expect((await db.Customer.findOne({ where: { workspaceId: s.ws, email: 'x@example.com' } })).marketingConsent).toBe(true);
  });

  it('by the one-click POST from the List-Unsubscribe header; a GET only leads to the page', async () => {
    const s = await store();
    const { campaign } = await sentCampaign(s, ['click@example.com']);
    const header = sent[0].headers['List-Unsubscribe'];
    const url = new URL(header.slice(1, -1));
    const t = url.searchParams.get('t');
    const look = await request(app).get('/api/v1/email-campaigns/unsubscribe').query({ t });
    expect(look.status).toBe(302);
    expect(look.headers.location).toMatch(/\/unsubscribe\?t=c1\./);
    expect((await campaignRow(campaign.id)).unsubscribedCount).toBe(0);
    const res = await request(app).post('/api/v1/email-campaigns/unsubscribe').query({ t }).type('form').send('List-Unsubscribe=One-Click');
    expect(res.status).toBe(200);
    expect((await campaignRow(campaign.id)).unsubscribedCount).toBe(1);
    expect((await request(app).post('/api/v1/email-campaigns/unsubscribe').query({ t: 'c1.nope.nope' })).status).toBe(404);
  });
});

describe('what the provider reports', () => {
  const TOKEN = 'campaign-webhook-test-token-0123456789';
  const hook = (events, token = TOKEN) => request(app).post('/api/v1/webhooks/email/brevo').set('Authorization', `Bearer ${token}`).send(events);

  it('counts delivered, opened and clicked once each, and suppresses a hard bounce', async () => {
    env.notifications.brevo.webhookToken = TOKEN;
    const s = await store();
    for (const name of ['d', 'b']) await customer(s.ws, { email: `${name}@example.com` });
    const campaign = await s.draft();
    await s.api('post', `/${campaign.id}/send`);
    const idOf = (to) => sent.find((m) => m.to === to).messageId;
    const ev = (event, to) => ({ event, email: to, 'message-id': `<${idOf(to)}>` });

    expect((await hook([ev('delivered', 'd@example.com')], 'wrong')).status).toBe(401);
    const res = await hook([ev('delivered', 'd@example.com'), ev('opened', 'd@example.com'), ev('unique_opened', 'd@example.com'), ev('click', 'd@example.com'), ev('click', 'd@example.com'), ev('hard_bounce', 'b@example.com')]);
    expect(res.status).toBe(200);
    await hook([ev('delivered', 'd@example.com'), ev('hard_bounce', 'b@example.com')]);
    // An event naming another address than the message's is not applied.
    await hook([{ event: 'opened', email: 'someone@else.com', 'message-id': idOf('b@example.com') }]);

    const row = await campaignRow(campaign.id);
    expect(row).toEqual(expect.objectContaining({ deliveredCount: 1, openedCount: 1, clickedCount: 1, bouncedCount: 1 }));
    expect(await db.EmailSuppression.count({ where: { workspaceId: s.ws, email: 'b@example.com', reason: 'hard_bounce' } })).toBe(1);
    const list = await s.api('get', `/${campaign.id}/recipients`).query({ status: 'sent' });
    const byEmail = Object.fromEntries(list.body.recipients.map((r) => [r.email, r]));
    expect(byEmail['b@example.com'].deliveryStatus).toBe('bounced');
    expect(byEmail['d@example.com'].openedAt).toBeTruthy();
  });

  it('a spam complaint unsubscribes the address too', async () => {
    env.notifications.brevo.webhookToken = TOKEN;
    const s = await store();
    await customer(s.ws, { email: 'angry@example.com' });
    const campaign = await s.draft();
    await s.api('post', `/${campaign.id}/send`);
    await hook({ event: 'spam', email: 'angry@example.com', 'message-id': sent[0].messageId });
    const row = await campaignRow(campaign.id);
    expect(row).toEqual(expect.objectContaining({ complainedCount: 1, unsubscribedCount: 1 }));
    expect((await db.Customer.findOne({ where: { workspaceId: s.ws, email: 'angry@example.com' } })).marketingConsent).toBe(false);
  });

  it('answers 404 with neither delivery status nor campaigns on', async () => {
    env.notifications.brevo.webhookToken = TOKEN;
    env.emailCampaigns.enabled = false;
    expect((await hook([])).status).toBe(404);
  });
});

describe('the checkout’s consent box', () => {
  const checkout = (s, body) =>
    request(app)
      .post(`/api/v1/store/${s.ws}/checkout`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        item: { variantId: s.variant.id, quantity: 1 },
        contact: { fullName: 'Box Ticker', phone: '01099887766', email: 'ticker@example.com' },
        shippingAddress: { country: 'EG', province: 'القاهرة (Cairo)', city: 'Cairo', addressLine: '1 Street' },
        paymentMethod: 'cod',
        ...body,
      });

  it('ticked gives consent and lifts an earlier unsubscribe; unticked or switched off changes nothing', async () => {
    const s = await store();
    env.emailCampaigns.enabled = false;
    expect((await checkout(s, { marketingConsent: true })).status).toBe(201);
    const c = await db.Customer.findOne({ where: { workspaceId: s.ws, email: 'ticker@example.com' } });
    expect(c.marketingConsent).toBe(false);

    env.emailCampaigns.enabled = true;
    await db.MarketingOptOut.create({ workspaceId: s.ws, email: 'ticker@example.com', source: 'email' });
    expect((await checkout(s, { marketingConsent: false })).status).toBe(201);
    expect((await c.reload()).marketingConsent).toBe(false);
    expect((await checkout(s, { marketingConsent: true })).status).toBe(201);
    expect((await c.reload()).marketingConsent).toBe(true);
    expect(await db.MarketingOptOut.count({ where: { workspaceId: s.ws, email: 'ticker@example.com' } })).toBe(0);
  });
});

describe('the console plan screen', () => {
  it('reads and saves the campaign emails per month like the other limits', async () => {
    const { makePlatformUser } = require('../helpers/factories');
    const admin = await makePlatformUser('admin');
    const created = await request(app)
      .post('/api/v1/admin/plans')
      .set(admin.H)
      .send({ name: 'Mail plan', code: 'mail-plan', monthlyPrice: 50000, trialDays: 0, features: [], maxCampaignEmailsPerMonth: 2500 });
    expect(created.status).toBe(201);
    expect(created.body.plan.maxCampaignEmailsPerMonth).toBe(2500);
    const id = created.body.plan.id;
    const unlimited = await request(app)
      .patch(`/api/v1/admin/plans/${id}`)
      .set(admin.H)
      .send({ name: 'Mail plan', code: 'mail-plan', monthlyPrice: 50000, trialDays: 0, features: [], maxCampaignEmailsPerMonth: null });
    expect(unlimited.status).toBe(200);
    expect(unlimited.body.plan.maxCampaignEmailsPerMonth).toBeNull();
    // Left out: kept.
    const kept = await request(app).patch(`/api/v1/admin/plans/${id}`).set(admin.H).send({ name: 'Mail plan', code: 'mail-plan', monthlyPrice: 50000, trialDays: 0, features: [] });
    expect(kept.body.plan.maxCampaignEmailsPerMonth).toBeNull();
    expect((await request(app).patch(`/api/v1/admin/plans/${id}`).set(admin.H).send({ name: 'Mail plan', code: 'mail-plan', monthlyPrice: 50000, trialDays: 0, maxCampaignEmailsPerMonth: -1 })).status).toBe(422);
  });
});

describe('products for the products block', () => {
  it('lists the store’s active products only', async () => {
    const s = await store();
    const other = await setupWorkspaceWithProduct();
    await createProductWithVariant(s.auth.accessToken, s.ws, { price: 9900 });
    const res = await s.api('get', '/products');
    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);
    expect(res.body.products.map((p) => p.id)).not.toContain(other.product.id);
  });
});
