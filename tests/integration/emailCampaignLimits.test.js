'use strict';

// The plan's campaign limits (emailCampaigns/campaignQuota.js, migration 749):
// campaigns a store may send or schedule a Cairo month, the largest audience
// one campaign may have, both with the monthly email limit at once; drafts,
// cancelling before the start and failing before any email; a scheduled
// campaign checked again when it starts; null = unlimited; one store's
// campaigns never counted against another's; the overview's numbers; the
// console's plan screen.

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const providers = require('../../src/modules/emailCampaigns/campaignProviders');
const sender = require('../../src/modules/emailCampaigns/campaignSender');

const ORIGINAL = { enabled: env.emailCampaigns.enabled };
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
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const BLOCKS = [{ type: 'text', text: 'News this week.' }];

async function setPlan(workspaceId, { emails = 1000, campaigns = null, recipients = null } = {}) {
  const sub = await db.Subscription.findOne({ where: { workspaceId } });
  const plan = await db.Plan.create({
    key: `plan-${crypto.randomUUID().slice(0, 8)}`,
    name: 'Limits plan',
    monthlyPriceAmount: 0,
    yearlyPriceAmount: 0,
    features: [],
    maxCampaignEmailsPerMonth: emails,
    maxCampaignsPerMonth: campaigns,
    maxRecipientsPerCampaign: recipients,
  });
  await sub.update({ planId: plan.id });
  return plan;
}

let phoneCounter = 0;
async function customers(workspaceId, n, prefix = 'c') {
  for (let i = 0; i < n; i += 1) {
    phoneCounter += 1;
    await db.Customer.create({
      workspaceId,
      phoneNormalized: `2012${String(30000000 + phoneCounter).slice(-8)}`,
      phoneRaw: `012${String(30000000 + phoneCounter).slice(-8)}`,
      fullName: 'Limit Customer',
      email: `${prefix}${phoneCounter}@example.com`,
      marketingConsent: true,
    });
  }
}

async function store(limits = {}) {
  const ctx = await setupWorkspaceWithProduct({ price: 15000, stock: 20 });
  const ws = ctx.workspace.id;
  await setPlan(ws, limits);
  const api = (method, path) => request(app)[method](`/api/v1/workspaces/${ws}/email-campaigns${path}`).set(bearer(ctx.auth.accessToken));
  const draft = async (name = 'Campaign') => {
    const res = await api('post', '/').send({ name, subject: 'News', blocks: BLOCKS });
    if (res.status !== 201) throw new Error(`create: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.campaign;
  };
  return { ...ctx, ws, api, draft };
}

// Soon, so it stays in this Cairo month however the clock stands (unless the month ends within minutes).
const soon = (minutes = 5) => new Date(Date.now() + minutes * 60 * 1000);
const row = (id) => db.EmailCampaign.findByPk(id);

describe('campaigns a month', () => {
  it('counts sent and scheduled campaigns, not drafts, and refuses one more past the limit', async () => {
    const s = await store({ campaigns: 2 });
    await customers(s.ws, 1);
    const a = await s.draft('A');
    const b = await s.draft('B');
    const c = await s.draft('C');
    // Three drafts use nothing.
    let overview = (await s.api('get', '/overview')).body.quota;
    expect(overview.campaigns).toEqual(expect.objectContaining({ max: 2, used: 0, remaining: 2 }));

    expect((await s.api('post', `/${a.id}/send`)).status).toBe(200);
    expect((await s.api('post', `/${b.id}/schedule`).send({ scheduledAt: soon().toISOString() })).status).toBe(200);
    overview = (await s.api('get', '/overview')).body.quota;
    expect(overview.campaigns).toEqual(expect.objectContaining({ max: 2, used: 2, remaining: 0 }));
    expect(overview.monthly.used).toBe(1);

    const refused = await s.api('post', `/${c.id}/send`);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('CAMPAIGN_LIMIT_REACHED');
    expect(refused.body.error.details).toEqual(expect.objectContaining({ max: 2, used: 2 }));
    expect((await s.api('post', `/${c.id}/schedule`).send({ scheduledAt: soon().toISOString() })).body.error.code).toBe('CAMPAIGN_LIMIT_REACHED');
    expect((await row(c.id)).status).toBe('draft');
    // Rescheduling the one already scheduled doesn't count it twice.
    expect((await s.api('post', `/${b.id}/schedule`).send({ scheduledAt: soon(10).toISOString() })).status).toBe(200);
  });

  it('gives the place back when a campaign is cancelled before it starts, or put back to a draft', async () => {
    const s = await store({ campaigns: 1 });
    await customers(s.ws, 1);
    const a = await s.draft('A');
    const b = await s.draft('B');
    await s.api('post', `/${a.id}/schedule`).send({ scheduledAt: soon().toISOString() });
    expect((await s.api('post', `/${b.id}/send`)).body.error.code).toBe('CAMPAIGN_LIMIT_REACHED');
    expect((await s.api('post', `/${a.id}/cancel`)).status).toBe(200);
    expect((await s.api('post', `/${b.id}/send`)).status).toBe(200);

    const t = await store({ campaigns: 1 });
    await customers(t.ws, 1);
    const x = await t.draft('X');
    const y = await t.draft('Y');
    await t.api('post', `/${x.id}/schedule`).send({ scheduledAt: soon().toISOString() });
    await t.api('post', `/${x.id}/unschedule`);
    expect((await t.api('post', `/${y.id}/send`)).status).toBe(200);
  });

  it('gives the place back when a campaign fails before any email goes out', async () => {
    const s = await store({ campaigns: 1 });
    await customers(s.ws, 1, 'gone');
    const a = await s.draft('A');
    const at = soon();
    await s.api('post', `/${a.id}/schedule`).send({ scheduledAt: at.toISOString() });
    // By its time nobody can receive it: it fails, nothing sent.
    await db.Customer.update({ marketingConsent: false }, { where: { workspaceId: s.ws } });
    await sender.tick({ now: new Date(at.getTime() + 1000) });
    expect(await row(a.id)).toEqual(expect.objectContaining({ status: 'failed', failureReason: 'no_recipients' }));
    expect((await s.api('get', '/overview')).body.quota.campaigns.used).toBe(0);
    await customers(s.ws, 1);
    const b = await s.draft('B');
    expect((await s.api('post', `/${b.id}/send`)).status).toBe(200);
  });

  it('is unlimited with null, and one store’s campaigns never count against another’s', async () => {
    const free = await store({ campaigns: null, recipients: null });
    await customers(free.ws, 2);
    for (let i = 0; i < 4; i += 1) expect((await free.api('post', `/${(await free.draft(`N${i}`)).id}/send`)).status).toBe(200);
    expect((await free.api('get', '/overview')).body.quota).toEqual(expect.objectContaining({ campaigns: expect.objectContaining({ max: null, used: 4, remaining: null }), recipientsPerCampaign: null }));

    const capped = await store({ campaigns: 1 });
    await customers(capped.ws, 1);
    expect((await capped.api('get', '/overview')).body.quota.campaigns.used).toBe(0);
    expect((await capped.api('post', `/${(await capped.draft()).id}/send`)).status).toBe(200);
  });
});

describe('the largest audience of one campaign', () => {
  it('refuses the whole send when the live audience is larger, with both numbers, and queues nobody', async () => {
    const s = await store({ recipients: 2 });
    await customers(s.ws, 3);
    const a = await s.draft();
    const res = await s.api('post', `/${a.id}/send`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AUDIENCE_TOO_LARGE');
    expect(res.body.error.details).toEqual({ audienceSize: 3, max: 2 });
    expect(res.body.error.message).toContain('segment or rules');
    expect(await db.EmailCampaignRecipient.count({ where: { campaignId: a.id } })).toBe(0);
    expect((await row(a.id)).status).toBe('draft');
    expect(sent).toHaveLength(0);
    // Not counted either.
    expect((await s.api('get', '/overview')).body.quota).toEqual(expect.objectContaining({ recipientsPerCampaign: 2, campaigns: expect.objectContaining({ used: 0 }) }));
  });

  it('refuses at scheduling too, and checks again when a scheduled campaign starts', async () => {
    const s = await store({ recipients: 2 });
    await customers(s.ws, 3);
    const a = await s.draft();
    const refused = await s.api('post', `/${a.id}/schedule`).send({ scheduledAt: soon().toISOString() });
    expect(refused.status).toBe(422);
    expect(refused.body.error.details).toEqual({ audienceSize: 3, max: 2 });

    const t = await store({ recipients: 2 });
    await customers(t.ws, 2);
    const b = await t.draft();
    const at = soon();
    expect((await t.api('post', `/${b.id}/schedule`).send({ scheduledAt: at.toISOString() })).status).toBe(200);
    // The audience grows before its time.
    await customers(t.ws, 1);
    await sender.tick({ now: new Date(at.getTime() + 1000) });
    expect(await row(b.id)).toEqual(expect.objectContaining({ status: 'failed', failureReason: 'audience_too_large' }));
    expect(await db.EmailCampaignRecipient.count({ where: { campaignId: b.id } })).toBe(0);
    expect(sent).toHaveLength(0);
    // The campaign page says why.
    expect((await t.api('get', `/${b.id}`)).body.campaign.failureReason).toBe('audience_too_large');
  });
});

describe('all three limits at once', () => {
  it('sends only within every one, whichever is tightest', async () => {
    const s = await store({ emails: 3, campaigns: 2, recipients: 2 });
    await customers(s.ws, 2);
    const a = await s.draft('A');
    expect((await s.api('post', `/${a.id}/send`)).status).toBe(200);
    // Emails: 2 used of 3; the next needs 2 — the email limit refuses it though the other two allow it.
    const b = await s.draft('B');
    const short = await s.api('post', `/${b.id}/send`);
    expect(short.body.error.code).toBe('EMAIL_QUOTA_EXCEEDED');
    // With a third customer the audience is too large too: the audience check comes first.
    await customers(s.ws, 1);
    expect((await s.api('post', `/${b.id}/send`)).body.error.code).toBe('AUDIENCE_TOO_LARGE');
    // Room again on every count: sent.
    await setPlan(s.ws, { emails: 100, campaigns: 2, recipients: 5 });
    expect((await s.api('post', `/${b.id}/send`)).status).toBe(200);
    // Two campaigns this month: the third is refused by the campaign limit alone.
    const c = await s.draft('C');
    expect((await s.api('post', `/${c.id}/send`)).body.error.code).toBe('CAMPAIGN_LIMIT_REACHED');
    const quota = (await s.api('get', '/overview')).body.quota;
    expect(quota.monthly.used).toBe(5);
    expect(quota.campaigns).toEqual(expect.objectContaining({ max: 2, used: 2, remaining: 0 }));
    expect(quota.recipientsPerCampaign).toBe(5);
  });
});

describe('the console plan screen', () => {
  it('reads and saves both limits like the others: a number, null for unlimited, kept when left out', async () => {
    const { makePlatformUser } = require('../helpers/factories');
    const admin = await makePlatformUser('admin');
    const base = { name: 'Limits plan', code: `limits-${crypto.randomUUID().slice(0, 6)}`, monthlyPrice: 50000, trialDays: 0, features: [] };
    const created = await request(app).post('/api/v1/admin/plans').set(admin.H).send({ ...base, maxCampaignsPerMonth: 4, maxRecipientsPerCampaign: 2000 });
    expect(created.status).toBe(201);
    expect(created.body.plan).toEqual(expect.objectContaining({ maxCampaignsPerMonth: 4, maxRecipientsPerCampaign: 2000 }));
    const id = created.body.plan.id;
    const cleared = await request(app).patch(`/api/v1/admin/plans/${id}`).set(admin.H).send({ ...base, maxCampaignsPerMonth: null, maxRecipientsPerCampaign: null });
    expect(cleared.body.plan).toEqual(expect.objectContaining({ maxCampaignsPerMonth: null, maxRecipientsPerCampaign: null }));
    await request(app).patch(`/api/v1/admin/plans/${id}`).set(admin.H).send({ ...base, maxCampaignsPerMonth: 7 });
    // Left out by an older console: kept.
    const kept = await request(app).patch(`/api/v1/admin/plans/${id}`).set(admin.H).send(base);
    expect(kept.body.plan).toEqual(expect.objectContaining({ maxCampaignsPerMonth: 7, maxRecipientsPerCampaign: null }));
    expect((await request(app).patch(`/api/v1/admin/plans/${id}`).set(admin.H).send({ ...base, maxCampaignsPerMonth: -1 })).status).toBe(422);
    expect((await request(app).patch(`/api/v1/admin/plans/${id}`).set(admin.H).send({ ...base, maxRecipientsPerCampaign: 0 })).status).toBe(422);
    // A plan made without them is unlimited.
    const plain = await request(app).post('/api/v1/admin/plans').set(admin.H).send({ ...base, code: `plain-${crypto.randomUUID().slice(0, 6)}` });
    expect(plain.body.plan).toEqual(expect.objectContaining({ maxCampaignsPerMonth: null, maxRecipientsPerCampaign: null }));
  });
});
