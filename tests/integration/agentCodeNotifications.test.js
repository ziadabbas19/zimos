'use strict';

// The console's bell on a creator's review (migration 744): who is told what,
// and that one code never piles up rows.

const { app, request, registerAndActivate, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const billingService = require('../../src/modules/billing/billingService');

const ORIGINAL_V2 = env.billing.referralCodesV2.enabled;

beforeEach(async () => {
  await billingService.seedDefaultPlans();
  // The test database's truncation leaves this table alone.
  await db.sequelize.query('DELETE FROM platform_notifications');
});

afterEach(() => {
  env.billing.referralCodesV2.enabled = ORIGINAL_V2;
});

const path = (rest) => `/api/v1/admin${rest}`;
const makeOwn = (who, body) => request(app).post(path('/my/referral-codes')).set(who.H).send(body);
const editOwn = (who, id, body) => request(app).patch(path(`/my/referral-codes/${id}`)).set(who.H).send(body);
const editCode = (who, id, body) => request(app).patch(path(`/referral-codes/${id}`)).set(who.H).send(body);
const approve = (who, id, body = {}) => request(app).post(path(`/referral-codes/${id}/approve`)).set(who.H).send(body);
const reject = (who, id, reason) => request(app).post(path(`/referral-codes/${id}/reject`)).set(who.H).send({ reason });
const linkStore = (who, wid, body) => request(app).post(path(`/workspaces/${wid}/agent-links`)).set(who.H).send(body);
const approveLink = (who, id) => request(app).post(path(`/agent-link-requests/${id}/approve`)).set(who.H).send({});
const rejectLink = (who, id, reason) => request(app).post(path(`/agent-link-requests/${id}/reject`)).set(who.H).send({ reason });
const rateOf = (rateBp) => ({ monthly: [{ count: null, rateBp }], yearly: [{ count: null, rateBp }] });

async function holding(permissions) {
  const who = await makePlatformUser('admin');
  await db.User.update({ platformPermissions: permissions }, { where: { id: who.userId } });
  return who;
}

const bell = async (who, type) => (await request(app).get(path(`/notifications?type=${type}`)).set(who.H)).body.notifications;
const unread = async (who) => (await request(app).get(path('/notifications/unread-count')).set(who.H)).body.unread;
const MANAGER = ['agents.view', 'agents.manage'];
const REVIEWER = [...MANAGER, 'referral_codes.approve'];

describe('a code waiting for review', () => {
  it('reaches a creator and whoever can approve, not other agents or managers', async () => {
    const creator = await makePlatformUser('creator');
    const reviewer = await holding(REVIEWER);
    const manager = await holding(MANAGER);
    const owner = await makePlatformUser('agent', { fullName: 'Owner Agent' });
    const other = await makePlatformUser('agent');
    const { id } = (await makeOwn(owner, { code: 'BELL-1' })).body.code;

    const [row] = await bell(creator, 'referral_code_review');
    expect(row).toMatchObject({ link: `/referral-codes/${id}`, data: { code: 'BELL-1', change: 'new', actorName: 'Owner Agent' } });
    expect(row.title).toContain('BELL-1');
    expect(await bell(reviewer, 'referral_code_review')).toHaveLength(1);
    expect(await bell(manager, 'referral_code_review')).toHaveLength(0);
    expect(await bell(other, 'referral_code_review')).toHaveLength(0);
    expect(await bell(owner, 'referral_code_review')).toHaveLength(0);
  });

  it('stays away from a reviewer who made it, since they cannot review it', async () => {
    const creator = await makePlatformUser('creator');
    const reviewer = await holding(REVIEWER);
    const agent = await makePlatformUser('agent');
    await request(app).post(path(`/agents/${agent.userId}/codes`)).set(reviewer.H).send({ code: 'BELL-2' });
    expect(await bell(reviewer, 'referral_code_review')).toHaveLength(0);
    expect(await bell(creator, 'referral_code_review')).toHaveLength(1);
  });

  it('keeps one row for one code: another change updates it and shows it as unread again', async () => {
    const creator = await makePlatformUser('creator');
    const owner = await makePlatformUser('agent');
    const manager = await holding(MANAGER);
    const { id } = (await makeOwn(owner, { code: 'BELL-3' })).body.code;

    await editOwn(owner, id, { commissionRateBp: 1000 });
    await editCode(manager, id, { commissionRateBp: 2000 });
    const rows = await bell(creator, 'referral_code_review');
    expect(rows).toHaveLength(1);
    expect(rows[0].data.change).toBe('change');
    expect(await db.sequelize.query("SELECT 1 FROM platform_notifications WHERE type = 'referral_code_review'", { type: 'SELECT' })).toHaveLength(1);

    await request(app).post(path('/notifications/read')).set(creator.H).send({ ids: [rows[0].id] });
    expect((await bell(creator, 'referral_code_review'))[0].readAt).not.toBeNull();
    await editCode(manager, id, { commissionRateBp: 3000 });
    const after = await bell(creator, 'referral_code_review');
    expect(after).toHaveLength(1);
    expect(after[0].readAt).toBeNull();
  });

  it('tells nobody about a label, and goes away when a change is taken back', async () => {
    const creator = await makePlatformUser('creator');
    const person = await registerAndActivate();
    const made = await request(app).post(path('/agents')).set(creator.H).send({ email: person.email, firstCode: { code: 'BELL-4', discountType: 'percentage', discountValue: 1000 } });
    const owner = { H: { Authorization: `Bearer ${person.accessToken}` } };
    const { id } = made.body.code;

    await editOwn(owner, id, { label: 'Renamed' });
    expect(await bell(creator, 'referral_code_review')).toHaveLength(0);

    await editOwn(owner, id, { discountValue: 2000 });
    expect((await bell(creator, 'referral_code_review'))[0].data.change).toBe('change');
    await editOwn(owner, id, { discountValue: 1000 });
    expect(await bell(creator, 'referral_code_review')).toHaveLength(0);
  });
});

describe('a decision on a code', () => {
  it("tells its owner and whoever changed it, with the reason, and clears the reviewer's row", async () => {
    const creator = await makePlatformUser('creator');
    const owner = await makePlatformUser('agent');
    const other = await makePlatformUser('agent');
    const manager = await holding(MANAGER);
    const bystander = await holding(MANAGER);
    const { id } = (await makeOwn(owner, { code: 'BELL-5' })).body.code;
    await editCode(manager, id, { commissionRateBp: 2000 });

    await reject(creator, id, 'Too generous');
    expect(await bell(creator, 'referral_code_review')).toHaveLength(0);

    const [told] = await bell(owner, 'referral_code_decided');
    expect(told).toMatchObject({ body: 'Too generous', data: { code: 'BELL-5', decision: 'rejected', edited: false } });
    // An agent without agents.view reads their code on My referrals.
    expect(told.link).toBe('/my-referrals');
    const [toManager] = await bell(manager, 'referral_code_decided');
    expect(toManager.link).toBe(`/referral-codes/${id}`);

    expect(await bell(other, 'referral_code_decided')).toHaveLength(0);
    expect(await bell(bystander, 'referral_code_decided')).toHaveLength(0);
    expect(await bell(creator, 'referral_code_decided')).toHaveLength(0);
    // Marking everything read reaches only what is theirs.
    await request(app).post(path('/notifications/read')).set(other.H).send({ all: true });
    const reads = await db.sequelize.query('SELECT 1 FROM platform_notification_reads WHERE user_id = :userId', {
      replacements: { userId: other.userId },
      type: 'SELECT',
    });
    expect(reads).toHaveLength(0);
    expect(await unread(owner)).toBe(1);
  });

  it('says so when the reviewer edited it on the way', async () => {
    const creator = await makePlatformUser('creator');
    const owner = await makePlatformUser('agent');
    const { id } = (await makeOwn(owner, { code: 'BELL-6', commissionRateBp: 5000 })).body.code;
    await approve(creator, id, { commissionRateBp: 1000 });
    expect((await bell(owner, 'referral_code_decided'))[0].data).toMatchObject({ decision: 'approved', edited: true });
  });

  it('does not call it edited when the form sent the same values back', async () => {
    const creator = await makePlatformUser('creator');
    const owner = await makePlatformUser('agent');
    const { id } = (await makeOwn(owner, { code: 'BELL-7', commissionRateBp: 5000 })).body.code;
    await approve(creator, id, { commissionRateBp: 5000, discountType: 'none', discountValue: null, discountCurrency: null, label: null });
    expect((await bell(owner, 'referral_code_decided'))[0].data).toMatchObject({ decision: 'approved', edited: false });
  });
});

describe('a store agent link', () => {
  const store = async (name) => {
    const owner = await registerAndActivate();
    return (await request(app).post('/api/v1/workspaces').set('Authorization', `Bearer ${owner.accessToken}`).send({ name })).body.workspace.id;
  };

  it('tells whoever can approve, then only whoever asked', async () => {
    env.billing.referralCodesV2.enabled = true;
    const creator = await makePlatformUser('creator');
    const manager = await holding(MANAGER);
    const bystander = await holding(MANAGER);
    const agent = await makePlatformUser('agent', { fullName: 'Linked Agent' });
    const wid = await store('Bell Store');

    const asked = await linkStore(manager, wid, { agentId: agent.userId, terms: rateOf(2000) });
    const [row] = await bell(creator, 'agent_link_review');
    expect(row).toMatchObject({ link: `/workspaces/${wid}?tab=subscription`, data: { name: 'Bell Store', kind: 'link', agentName: 'Linked Agent' } });
    expect(row.title).toContain('Bell Store');
    expect(await bell(manager, 'agent_link_review')).toHaveLength(0);

    await rejectLink(creator, asked.body.request.id, 'Not this one');
    expect(await bell(creator, 'agent_link_review')).toHaveLength(0);
    expect((await bell(manager, 'agent_link_decided'))[0]).toMatchObject({ body: 'Not this one', data: { name: 'Bell Store', decision: 'rejected' } });
    expect(await bell(bystander, 'agent_link_decided')).toHaveLength(0);
    expect(await bell(agent, 'agent_link_decided')).toHaveLength(0);

    const again = await linkStore(manager, wid, { agentId: agent.userId, terms: rateOf(2000) });
    await approveLink(creator, again.body.request.id);
    expect((await bell(manager, 'agent_link_decided'))[0].data.decision).toBe('approved');
  });
});

describe('the settings list', () => {
  it('offers each account only the types it can be told about', async () => {
    const prefs = async (who) => (await request(app).get(path('/notification-prefs')).set(who.H)).body.prefs.map((p) => p.type);
    const agent = await prefs(await makePlatformUser('agent'));
    expect(agent).toEqual(['referral_code_decided']);
    const manager = await prefs(await holding(MANAGER));
    expect(manager).toEqual(expect.arrayContaining(['referral_code_decided', 'agent_link_decided']));
    expect(manager).not.toContain('referral_code_review');
    const reviewer = await prefs(await holding(REVIEWER));
    expect(reviewer).toEqual(expect.arrayContaining(['referral_code_review', 'agent_link_review']));
  });
});
