'use strict';

// Own referral codes and a creator's review (migration 742): who reaches which
// code, when a merchant can enter one, what a change does to it, and who may
// add an agent.

const { app, request, registerAndActivate, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const billingService = require('../../src/modules/billing/billingService');
const agentLinks = require('../../src/modules/referrals/agentLinkService');

const ORIGINAL_V2 = env.billing.referralCodesV2.enabled;

beforeEach(async () => {
  await billingService.seedDefaultPlans();
});

afterEach(() => {
  env.billing.referralCodesV2.enabled = ORIGINAL_V2;
});

const v2On = () => {
  env.billing.referralCodesV2.enabled = true;
};

const path = (rest) => `/api/v1/admin${rest}`;
const get = (who, rest) => request(app).get(path(rest)).set(who.H);
const makeOwn = (who, body) => request(app).post(path('/my/referral-codes')).set(who.H).send(body);
const editOwn = (who, id, body) => request(app).patch(path(`/my/referral-codes/${id}`)).set(who.H).send(body);
const editCode = (who, id, body) => request(app).patch(path(`/referral-codes/${id}`)).set(who.H).send(body);
const approve = (who, id, body = {}) => request(app).post(path(`/referral-codes/${id}/approve`)).set(who.H).send(body);
const reject = (who, id, reason) => request(app).post(path(`/referral-codes/${id}/reject`)).set(who.H).send({ reason });
const grant = (who, body) => request(app).post(path('/admins')).set(who.H).send(body);
const editAdmin = (who, id, body) => request(app).patch(path(`/admins/${id}`)).set(who.H).send(body);
const addAgent = (who, body) => request(app).post(path('/agents')).set(who.H).send(body);
const addCode = (who, agentId, body) => request(app).post(path(`/agents/${agentId}/codes`)).set(who.H).send(body);
const linkStore = (who, wid, body) => request(app).post(path(`/workspaces/${wid}/agent-links`)).set(who.H).send(body);
const editLink = (who, id, body) => request(app).patch(path(`/agent-links/${id}`)).set(who.H).send(body);
const endLink = (who, id) => request(app).post(path(`/agent-links/${id}/end`)).set(who.H).send({});
const approveLink = (who, id) => request(app).post(path(`/agent-link-requests/${id}/approve`)).set(who.H).send({});
const rejectLink = (who, id, reason) => request(app).post(path(`/agent-link-requests/${id}/reject`)).set(who.H).send({ reason });
const rateOf = (rateBp) => ({ monthly: [{ count: null, rateBp }], yearly: [{ count: null, rateBp }] });
const linkNow = (wid) => agentLinks.linkAt(wid, new Date());
const MANAGER = ['agents.view', 'agents.manage'];
const REVIEWER = [...MANAGER, 'referral_codes.approve'];

function expectOwnWork(res) {
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe('REVIEW_OF_OWN_WORK');
}

async function holding(permissions) {
  const who = await makePlatformUser('admin');
  await db.User.update({ platformPermissions: permissions }, { where: { id: who.userId } });
  return who;
}

async function openStoreWith(referralCode) {
  const owner = await registerAndActivate();
  return request(app).post('/api/v1/workspaces').set('Authorization', `Bearer ${owner.accessToken}`).send({ name: 'Store', referralCode });
}

function expectRefused(res) {
  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe('REFERRAL_CODE_INVALID');
}

/** An agent with an approved code taking 10% off, and a creator. */
async function approvedCode() {
  const creator = await makePlatformUser('creator');
  const person = await registerAndActivate();
  const res = await addAgent(creator, { email: person.email, firstCode: { code: 'LIVE-1', discountType: 'percentage', discountValue: 1000 } });
  expect(res.status).toBe(201);
  const agent = { ...person, H: { Authorization: `Bearer ${person.accessToken}` } };
  return { creator, agent, id: res.body.code.id };
}

describe('who reaches which code', () => {
  it("answers 404 for another agent's code, and shows each agent only their own", async () => {
    const mine = await makePlatformUser('agent');
    const other = await makePlatformUser('agent');
    const made = await makeOwn(mine, { code: 'MINE-1', discountType: 'percentage', discountValue: 1000 });
    expect(made.status).toBe(201);
    const { id } = made.body.code;

    expect((await get(mine, `/my/referral-codes/${id}`)).status).toBe(200);
    expect((await get(other, `/my/referral-codes/${id}`)).status).toBe(404);
    expect((await editOwn(other, id, { label: 'Taken' })).status).toBe(404);
    expect((await db.ReferralCode.findByPk(id)).label).toBeNull();

    expect((await get(mine, '/my/referrals')).body.agent.codes.map((c) => c.id)).toEqual([id]);
    expect((await get(other, '/my/referrals')).body.agent.codes).toEqual([]);

    for (const rest of ['/referral-codes', `/referral-codes/${id}`, `/referral-codes/${id}/redemptions`, '/agents', `/agents/${mine.userId}`, '/commissions']) {
      expect([rest, (await get(other, rest)).status]).toEqual([rest, 403]);
    }
    expect((await approve(other, id)).status).toBe(403);
    expect((await reject(other, id, 'No')).status).toBe(403);
  });

  it('takes the owner from the session, whatever the body says, for any role with the key', async () => {
    const other = await makePlatformUser('agent');
    const mine = await holding(['referrals.view_own']);
    const made = await makeOwn(mine, { code: 'MINE-2', agentId: other.userId, active: true });
    expect(made.status).toBe(201);
    expect(made.body.code).toMatchObject({ agentId: mine.userId, approvalStatus: 'pending', active: false });
  });
});

describe('a code waiting for review', () => {
  it('is refused at a merchant until it is approved', async () => {
    const creator = await makePlatformUser('creator');
    const agent = await makePlatformUser('agent');
    const { id } = (await makeOwn(agent, { code: 'WAIT-1', discountType: 'percentage', discountValue: 1000 })).body.code;

    expectRefused(await openStoreWith('WAIT-1'));
    // Nor later, from billing, on a store that has no code.
    const owner = await registerAndActivate();
    const H = { Authorization: `Bearer ${owner.accessToken}` };
    const store = await request(app).post('/api/v1/workspaces').set(H).send({ name: 'Later' });
    expect(store.status).toBe(201);
    const starter = await db.Plan.findOne({ where: { key: 'starter' } });
    await db.Subscription.update({ planId: starter.id }, { where: { workspaceId: store.body.workspace.id } });
    const attach = () => request(app).post(`/api/v1/workspaces/${store.body.workspace.id}/billing/referral-code`).set(H).send({ code: 'WAIT-1' });
    expectRefused(await attach());

    const approved = await approve(creator, id);
    expect(approved.status).toBe(200);
    expect(approved.body.code).toMatchObject({ approvalStatus: 'approved', active: true });
    expect((await attach()).status).toBe(201);

    const entered = await openStoreWith('WAIT-1');
    expect(entered.status).toBe(201);
    expect((await db.Subscription.findOne({ where: { workspaceId: entered.body.workspace.id } })).referralCodeId).toBe(id);
  });

  it('stays refused once rejected; its owner reads why, and a change sends it back', async () => {
    const creator = await makePlatformUser('creator');
    const agent = await makePlatformUser('agent');
    const { id } = (await makeOwn(agent, { code: 'WAIT-2' })).body.code;

    const rejected = await reject(creator, id, 'Too generous');
    expect(rejected.body.code).toMatchObject({ approvalStatus: 'rejected', active: false, approvalNote: 'Too generous' });
    expectRefused(await openStoreWith('WAIT-2'));
    expect((await get(agent, `/my/referral-codes/${id}`)).body.code.approvalNote).toBe('Too generous');
    expect((await approve(creator, id)).body.error.code).toBe('REFERRAL_CODE_NOT_PENDING');

    // The name alone sends nothing back.
    expect((await editOwn(agent, id, { label: 'Giza' })).body.code).toMatchObject({ label: 'Giza', approvalStatus: 'rejected' });
    const again = await editOwn(agent, id, { commissionRateBp: 1000 });
    expect(again.body.code).toMatchObject({ approvalStatus: 'pending', approvalNote: null, commissionRateBp: 1000, active: false });
  });

  it("can't be switched on from the console, even by a creator", async () => {
    const creator = await makePlatformUser('creator');
    const agent = await makePlatformUser('agent');
    const { id } = (await makeOwn(agent, { code: 'WAIT-3' })).body.code;
    const on = await editCode(creator, id, { active: true });
    expect(on.status).toBe(409);
    expect(on.body.error.code).toBe('REFERRAL_CODE_NOT_APPROVED');
  });

  it('lets a creator change it on the way to approving it', async () => {
    const creator = await makePlatformUser('creator');
    const agent = await makePlatformUser('agent');
    const { id } = (await makeOwn(agent, { code: 'WAIT-4', commissionRateBp: 5000 })).body.code;
    const approved = await approve(creator, id, { commissionRateBp: 1000 });
    expect(approved.body.code).toMatchObject({ commissionRateBp: 1000, approvalStatus: 'approved', active: true });
  });
});

describe('a money change to an approved code', () => {
  it('waits for review from agents.manage: the code stays as approved, for stores already on it', async () => {
    const { creator, id } = await approvedCode();
    const manager = await holding(['agents.view', 'agents.manage']);
    const store = await openStoreWith('LIVE-1');
    expect(store.status).toBe(201);

    const changed = await editCode(manager, id, { discountValue: 5000 });
    expect(changed.status).toBe(200);
    expect(changed.body.code).toMatchObject({ approvalStatus: 'pending', active: true, discountValue: 1000 });
    expect(changed.body.code.proposed.discountValue).toBe(5000);
    expect(Number((await db.ReferralCode.findByPk(id)).discountValue)).toBe(1000);

    expectRefused(await openStoreWith('LIVE-1'));
    expect((await db.Subscription.findOne({ where: { workspaceId: store.body.workspace.id } })).referralCodeId).toBe(id);

    const approved = await approve(creator, id);
    expect(approved.body.code).toMatchObject({ approvalStatus: 'approved', active: true, discountValue: 5000, proposed: null });
    expect((await openStoreWith('LIVE-1')).status).toBe(201);
    expect(await db.AuditLog.count({ where: { action: 'referral_code.submit_changes' } })).toBe(1);
    expect(await db.AuditLog.count({ where: { action: 'referral_code.approve' } })).toBe(1);
  });

  it('goes the same way from My referrals', async () => {
    const { agent, id } = await approvedCode();
    const changed = await editOwn(agent, id, { commissionRateBp: 9000 });
    expect(changed.body.code).toMatchObject({ approvalStatus: 'pending', active: true, commissionRateBp: null });
    expect(changed.body.code.proposed.commissionRateBp).toBe(9000);
    expect((await db.ReferralCode.findByPk(id)).commissionRateBp).toBeNull();
  });

  it('waits for review from someone who can approve, too: only a creator skips it', async () => {
    const { id } = await approvedCode();
    const reviewer = await holding(['agents.view', 'agents.manage', 'referral_codes.approve']);
    expect((await editCode(reviewer, id, { discountValue: 2000 })).body.code).toMatchObject({ approvalStatus: 'pending', discountValue: 1000 });
  });

  it('applies at once from a creator', async () => {
    const { creator, id } = await approvedCode();
    expect((await editCode(creator, id, { discountValue: 2000 })).body.code).toMatchObject({ approvalStatus: 'approved', discountValue: 2000, proposed: null });
    expect(await db.AuditLog.count({ where: { action: 'referral_code.submit_changes' } })).toBe(0);
  });

  it('leaves out the name, the switch, and values sent unchanged', async () => {
    const { id } = await approvedCode();
    const manager = await holding(['agents.view', 'agents.manage']);
    expect((await editCode(manager, id, { label: 'Renamed' })).body.code).toMatchObject({ label: 'Renamed', approvalStatus: 'approved' });
    const form = { discountType: 'percentage', discountValue: 1000, discountCurrency: null, commissionRateBp: null };
    expect((await editCode(manager, id, form)).body.code).toMatchObject({ approvalStatus: 'approved', proposed: null });
    expect((await editCode(manager, id, { active: false })).body.code).toMatchObject({ active: false, approvalStatus: 'approved' });
  });

  it('clears the wait when changed back', async () => {
    const { agent, id } = await approvedCode();
    await editOwn(agent, id, { discountValue: 2000 });
    expect((await editOwn(agent, id, { discountValue: 1000 })).body.code).toMatchObject({ approvalStatus: 'approved', proposed: null });
  });

  it('is dropped on rejection, and the code goes on as approved', async () => {
    const { creator, agent, id } = await approvedCode();
    await editOwn(agent, id, { discountValue: 2000 });
    const rejected = await reject(creator, id, 'Too much');
    expect(rejected.body.code).toMatchObject({ approvalStatus: 'approved', active: true, discountValue: 1000, changesRejected: true, approvalNote: 'Too much', proposed: null });
    expect((await openStoreWith('LIVE-1')).status).toBe(201);
    expect(await db.AuditLog.count({ where: { action: 'referral_code.reject' } })).toBe(1);
  });
});

describe('a new code from anyone but a creator', () => {
  it('waits for review from agents.manage, on the console routes and as a first code', async () => {
    v2On();
    const creator = await makePlatformUser('creator');
    const manager = await holding([...MANAGER, 'agents.create']);
    const agent = await makePlatformUser('agent');

    const made = await addCode(manager, agent.userId, { code: 'NEW-1', discountType: 'percentage', discountValue: 5000 });
    expect(made.status).toBe(201);
    expect(made.body.code).toMatchObject({ approvalStatus: 'pending', active: false });
    expectRefused(await openStoreWith('NEW-1'));

    const standalone = await request(app).post(path('/referral-codes')).set(manager.H).send({ code: 'NEW-2', audience: 'any' });
    expect(standalone.body.code).toMatchObject({ approvalStatus: 'pending', active: false });
    expectRefused(await openStoreWith('NEW-2'));

    const person = await registerAndActivate();
    const first = await addAgent(manager, { email: person.email, firstCode: { code: 'NEW-3', audience: 'any' } });
    expect(first.status).toBe(201);
    expect(first.body.code).toMatchObject({ approvalStatus: 'pending', active: false });
    expectRefused(await openStoreWith('NEW-3'));

    expect((await approve(creator, standalone.body.code.id)).body.code).toMatchObject({ approvalStatus: 'approved', active: true });
    expect((await openStoreWith('NEW-2')).status).toBe(201);
  });

  it('is live at once from a creator', async () => {
    const creator = await makePlatformUser('creator');
    const agent = await makePlatformUser('agent');
    const made = await addCode(creator, agent.userId, { code: 'NEW-4' });
    expect(made.body.code).toMatchObject({ approvalStatus: 'approved', active: true });
    expect((await openStoreWith('NEW-4')).status).toBe(201);
  });
});

describe('a change to a code\'s agent', () => {
  it('waits for review from anyone but a creator', async () => {
    v2On();
    const { creator, agent, id } = await approvedCode();
    const other = await makePlatformUser('agent');
    const manager = await holding(MANAGER);

    const changed = await editCode(manager, id, { agentId: other.userId });
    expect(changed.status).toBe(200);
    expect(changed.body.code).toMatchObject({ approvalStatus: 'pending', agentId: agent.userId });
    expect(changed.body.code.proposed.agentId).toBe(other.userId);
    expect((await db.ReferralCode.findByPk(id)).agentId).toBe(agent.userId);

    expect((await approve(creator, id)).body.code).toMatchObject({ approvalStatus: 'approved', agentId: other.userId });

    const back = await editCode(creator, id, { agentId: agent.userId });
    expect(back.body.code).toMatchObject({ approvalStatus: 'approved', agentId: agent.userId });
  });
});

describe("a change to a store's agent link", () => {
  async function store() {
    const res = await openStoreWith(undefined);
    expect(res.status).toBe(201);
    return res.body.workspace.id;
  }

  it('waits for review from anyone but a creator: nothing earns until it is approved', async () => {
    v2On();
    const creator = await makePlatformUser('creator');
    const manager = await holding(MANAGER);
    const agent = await makePlatformUser('agent');
    const wid = await store();

    const asked = await linkStore(manager, wid, { agentId: agent.userId, terms: rateOf(2000) });
    expect(asked.status).toBe(202);
    expect(asked.body.request).toMatchObject({ status: 'pending', kind: 'link', agent: { id: agent.userId }, requestedBy: { id: manager.userId } });
    expect(asked.body.link).toBeUndefined();
    expect(await db.AgentLink.count({ where: { workspaceId: wid } })).toBe(0);
    expect(await linkNow(wid)).toBeNull();

    // Where a reviewer finds it.
    const list = await get(manager, '/agent-link-requests');
    expect(list.body.requests.map((r) => r.id)).toEqual([asked.body.request.id]);
    const page = await get(manager, `/workspaces/${wid}/referrals`);
    expect(page.body).toMatchObject({ openLink: null, linkRequests: [{ id: asked.body.request.id, status: 'pending' }] });

    const approved = await approveLink(creator, asked.body.request.id);
    expect(approved.status).toBe(200);
    expect(approved.body.request.status).toBe('approved');
    expect(approved.body.link).toMatchObject({ open: true, agent: { id: agent.userId }, createdBy: { id: manager.userId } });
    expect((await linkNow(wid)).agentId).toBe(agent.userId);
    expect(await db.AuditLog.count({ where: { action: 'agent_link.request' } })).toBe(1);
    expect(await db.AuditLog.count({ where: { action: 'agent_link.approve' } })).toBe(1);
    expect(await db.AuditLog.count({ where: { action: 'agent_link.create' } })).toBe(1);
  });

  it('keeps the link as it stands until a change, a move or an end is approved', async () => {
    v2On();
    const creator = await makePlatformUser('creator');
    const manager = await holding(MANAGER);
    const agentA = await makePlatformUser('agent');
    const agentB = await makePlatformUser('agent');
    const wid = await store();

    // A creator's applies at once.
    const first = await linkStore(creator, wid, { agentId: agentA.userId, terms: rateOf(2000) });
    expect(first.status).toBe(201);
    const linkId = first.body.link.id;
    const rateNow = async () => (await linkNow(wid)).terms.monthly[0].rateBp;

    const raise = await editLink(manager, linkId, { terms: rateOf(9000) });
    expect(raise.status).toBe(202);
    expect(await rateNow()).toBe(2000);
    // One waiting per store.
    const second = await endLink(manager, linkId);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('AGENT_LINK_REQUEST_PENDING');

    const rejected = await rejectLink(creator, raise.body.request.id, 'Too much');
    expect(rejected.body.request).toMatchObject({ status: 'rejected', reason: 'Too much' });
    expect(await rateNow()).toBe(2000);
    expect((await rejectLink(creator, raise.body.request.id, 'Again')).body.error.code).toBe('AGENT_LINK_REQUEST_NOT_PENDING');

    const again = await editLink(manager, linkId, { terms: rateOf(3000) });
    expect(await rateNow()).toBe(2000);
    expect((await approveLink(creator, again.body.request.id)).status).toBe(200);
    expect(await rateNow()).toBe(3000);

    const move = await linkStore(manager, wid, { agentId: agentB.userId, terms: rateOf(5000) });
    expect(move.status).toBe(202);
    expect((await linkNow(wid)).agentId).toBe(agentA.userId);
    const moved = await approveLink(creator, move.body.request.id);
    expect(moved.body.link.agent.id).toBe(agentB.userId);
    expect(await db.AgentLink.findByPk(linkId)).toMatchObject({ endReason: 'replaced', endedByUserId: manager.userId });

    const end = await endLink(manager, moved.body.link.id);
    expect(end.status).toBe(202);
    expect((await linkNow(wid)).agentId).toBe(agentB.userId);
    const ended = await approveLink(creator, end.body.request.id);
    expect(ended.body.link).toMatchObject({ open: false, endReason: 'ended', endedBy: { id: manager.userId } });
    expect(await linkNow(wid)).toBeNull();
  });

  it('stays closed to whoever holds only the view', async () => {
    v2On();
    const viewer = await holding(['agents.view']);
    const manager = await holding(MANAGER);
    const agent = await makePlatformUser('agent');
    const wid = await store();
    expect((await linkStore(viewer, wid, { agentId: agent.userId, terms: rateOf(2000) })).status).toBe(403);
    const asked = await linkStore(manager, wid, { agentId: agent.userId, terms: rateOf(2000) });
    expect((await approveLink(manager, asked.body.request.id)).status).toBe(403);
    expect((await rejectLink(viewer, asked.body.request.id, 'No')).status).toBe(403);
    expect((await get(agent, '/agent-link-requests')).status).toBe(403);
  });
});

describe('nobody but a creator reviews their own work', () => {
  it('refuses a code they made, whoever else may review it', async () => {
    const reviewer = await holding(REVIEWER);
    const other = await holding(REVIEWER);
    const agent = await makePlatformUser('agent');
    const made = await addCode(reviewer, agent.userId, { code: 'OWN-1' });
    expect(made.body.code.authorIds).toEqual([reviewer.userId]);
    expectOwnWork(await approve(reviewer, made.body.code.id));
    expectOwnWork(await reject(reviewer, made.body.code.id, 'No'));
    expect((await db.ReferralCode.findByPk(made.body.code.id)).approvalStatus).toBe('pending');
    expect((await approve(other, made.body.code.id)).status).toBe(200);
  });

  it('refuses a change they made, or had a hand in, and only for as long as it waits', async () => {
    const { id } = await approvedCode();
    const reviewer = await holding(REVIEWER);
    const other = await holding(REVIEWER);
    const manager = await holding(MANAGER);

    await editCode(reviewer, id, { discountValue: 2000 });
    await editCode(manager, id, { commissionRateBp: 1000 });
    expectOwnWork(await approve(reviewer, id));
    expectOwnWork(await reject(reviewer, id, 'No'));
    expect((await reject(other, id, 'Too much')).status).toBe(200);

    // Their change is gone: someone else's is theirs to review.
    await editCode(manager, id, { discountValue: 3000 });
    expect((await approve(reviewer, id)).body.code).toMatchObject({ approvalStatus: 'approved', discountValue: 3000 });
  });

  it('still refuses someone who changed a code never approved, after it is rejected and sent again', async () => {
    const reviewer = await holding(REVIEWER);
    const other = await holding(REVIEWER);
    const agent = await makePlatformUser('agent');
    const { id } = (await makeOwn(agent, { code: 'OWN-2' })).body.code;
    await editCode(reviewer, id, { commissionRateBp: 1000 });
    await reject(other, id, 'No');
    await editOwn(agent, id, { commissionRateBp: 2000 });
    expectOwnWork(await approve(reviewer, id));
  });

  it('refuses a change to a store link they asked for, or on a link they made', async () => {
    v2On();
    const reviewer = await holding(REVIEWER);
    const other = await holding(REVIEWER);
    const manager = await holding(MANAGER);
    const agent = await makePlatformUser('agent');
    const res = await openStoreWith(undefined);
    const wid = res.body.workspace.id;

    const asked = await linkStore(reviewer, wid, { agentId: agent.userId, terms: rateOf(2000) });
    expect(asked.body.request.authorIds).toEqual([reviewer.userId]);
    expectOwnWork(await approveLink(reviewer, asked.body.request.id));
    expectOwnWork(await rejectLink(reviewer, asked.body.request.id, 'No'));
    const approved = await approveLink(other, asked.body.request.id);
    expect(approved.status).toBe(200);

    const change = await editLink(manager, approved.body.link.id, { terms: rateOf(3000) });
    expectOwnWork(await approveLink(reviewer, change.body.request.id));
    expect((await approveLink(other, change.body.request.id)).status).toBe(200);
  });

  it('lets a creator through, on what they changed too', async () => {
    const creator = await makePlatformUser('creator');
    const agent = await makePlatformUser('agent');
    const { id } = (await makeOwn(agent, { code: 'OWN-3' })).body.code;
    await editCode(creator, id, { commissionRateBp: 1000 });
    expect((await approve(creator, id)).body.code).toMatchObject({ approvalStatus: 'approved', commissionRateBp: 1000 });
  });
});

describe('agents.create is the one way to the agent role', () => {
  it('refuses admins.manage on the admin users list, on a new account and on another role', async () => {
    const manager = await holding(['admins.view', 'admins.manage']);
    const person = await registerAndActivate();
    expect((await grant(manager, { email: person.email, role: 'agent' })).status).toBe(403);
    expect((await db.User.findByPk(person.userId)).platformRole).toBeNull();

    const within = await holding(['admins.view']);
    expect((await editAdmin(manager, within.userId, { role: 'agent' })).status).toBe(403);
    expect((await db.User.findByPk(within.userId)).platformRole).toBe('admin');
  });

  it('refuses agents.manage and the agent key on the Agents page', async () => {
    const person = await registerAndActivate();
    expect((await addAgent(await holding(['agents.view', 'agents.manage']), { email: person.email })).status).toBe(403);
    expect((await addAgent(await makePlatformUser('agent'), { email: person.email })).status).toBe(403);
    expect((await db.User.findByPk(person.userId)).platformRole).toBeNull();
  });

  it('opens both for whoever holds it, without a first code unless they hold agents.manage', async () => {
    const manager = await holding(['admins.view', 'admins.manage', 'agents.create']);
    const person = await registerAndActivate();
    expect((await grant(manager, { email: person.email, role: 'agent' })).status).toBe(201);
    const within = await holding(['admins.view']);
    expect((await editAdmin(manager, within.userId, { role: 'agent' })).status).toBe(200);

    const adder = await holding(['agents.create']);
    const next = await registerAndActivate();
    expect((await addAgent(adder, { email: next.email, firstCode: { code: 'FIRST-1' } })).status).toBe(403);
    expect((await addAgent(adder, { email: next.email })).status).toBe(201);
  });

  it('lets a creator through', async () => {
    const creator = await makePlatformUser('creator');
    const person = await registerAndActivate();
    expect((await grant(creator, { email: person.email, role: 'agent' })).status).toBe(201);
  });
});
