'use strict';

// Own referral codes and a creator's review (migration 742): who reaches which
// code, when a merchant can enter one, what a change does to it, and who may
// add an agent.

const { app, request, registerAndActivate, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const billingService = require('../../src/modules/billing/billingService');

beforeEach(async () => {
  await billingService.seedDefaultPlans();
});

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
