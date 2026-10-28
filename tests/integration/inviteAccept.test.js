'use strict';

// Accepting an invite sent to someone without an account yet
// (workspaces/inviteAcceptance.js): the link's token, who may accept it and
// with which role, and the invitee who signs up through Google while a plan
// is required at sign-up.

jest.mock('../../src/modules/auth/googleClient', () => ({
  getAuthUrl: jest.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?mock=1'),
  fetchProfile: jest.fn(),
}));
const googleClient = require('../../src/modules/auth/googleClient');

const { app, request, uniqueEmail, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const { render: renderTemplate } = require('../../src/modules/notifications/emailTemplates');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const ORIGINAL_SIGNUP = { ...env.signup };

let emailSpy;
beforeEach(() => {
  emailSpy = jest.spyOn(notify, 'email');
});
afterEach(() => {
  emailSpy.mockRestore();
  Object.assign(env.signup, ORIGINAL_SIGNUP);
  googleClient.fetchProfile.mockReset();
});

/** The token of the last invite email sent to `email`. */
function lastInviteToken(email) {
  const calls = emailSpy.mock.calls.filter(([arg]) => arg.template === 'workspace_invite' && arg.recipient === email);
  return calls.length ? calls[calls.length - 1][0].data.token : undefined;
}

async function storeWithInvite({ roleKey = 'order_operator', email = uniqueEmail('invitee') } = {}) {
  const owner = await registerAndActivate({ fullName: 'Store Owner' });
  const workspace = await createWorkspace(owner.accessToken, 'Invite Co');
  const role = await db.Role.findOne({ where: { workspaceId: workspace.id, key: roleKey } });
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspace.id}/members`)
    .set(bearer(owner.accessToken))
    .send({ email, roleId: role.id });
  expect(res.status).toBe(201);
  return { owner, workspace, role, email, membershipId: res.body.membership.id, token: lastInviteToken(email) };
}

/** A new account, signed in and not confirmed yet (REQUIRE_SIGNUP_VERIFICATION off). */
async function signUp(email) {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ phone: '01012345678', email, password: 'Passw0rd!123', fullName: 'New Teammate' });
  expect(res.status).toBe(201);
  return res.body.accessToken;
}

const accept = (token, accessToken, body) =>
  request(app).post(`/api/v1/invites/${token}/accept`).set(bearer(accessToken)).send(body || {});

describe('the invite link', () => {
  it('describes a pending invite without an account, and never shows its hash', async () => {
    const { owner, workspace, email, token } = await storeWithInvite({ roleKey: 'editor' });
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const res = await request(app).get(`/api/v1/invites/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.invite).toMatchObject({
      state: 'pending',
      workspace: { name: 'Invite Co' },
      role: { key: 'editor' },
      email,
    });
    expect(new Date(res.body.invite.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);

    const H = bearer(owner.accessToken);
    const invites = await request(app).get(`/api/v1/workspaces/${workspace.id}/invites`).set(H);
    const members = await request(app).get(`/api/v1/workspaces/${workspace.id}/members`).set(H);
    expect(JSON.stringify(invites.body)).not.toMatch(/inviteTokenHash|invite_token_hash/);
    expect(JSON.stringify(members.body)).not.toMatch(/inviteTokenHash|invite_token_hash/);
    // Only the hash is stored.
    const row = await db.Membership.findOne({ where: { workspaceId: workspace.id, status: 'invited' } });
    expect(row.inviteTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.inviteTokenHash).not.toBe(token);
  });

  it('a new account signs up with the invited address and joins with the invited role', async () => {
    const { workspace, role, email, token } = await storeWithInvite({ roleKey: 'order_operator' });
    const accessToken = await signUp(email);

    const res = await accept(token, accessToken);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ workspace: { id: workspace.id, name: 'Invite Co' }, role: { key: 'order_operator' } });

    const user = await db.User.findOne({ where: { email } });
    const membership = await db.Membership.findOne({ where: { workspaceId: workspace.id, userId: user.id } });
    expect(membership).toMatchObject({ status: 'active', roleId: role.id, invitedEmail: null });
    expect(membership.inviteAcceptedAt).toBeTruthy();

    const list = await request(app).get('/api/v1/workspaces').set(bearer(accessToken));
    expect(list.body.workspaces.map((w) => [w.workspace.id, w.role.key])).toEqual([[workspace.id, 'order_operator']]);
    expect(await db.AuditLog.count({ where: { action: 'membership.invite_accept', entityId: membership.id } })).toBe(1);
  });

  it('an account made after the invite signs in and accepts', async () => {
    const { workspace, email, token } = await storeWithInvite();
    const existing = await registerAndActivate({ email });
    expect((await accept(token, existing.accessToken)).status).toBe(200);
    const membership = await db.Membership.findOne({ where: { workspaceId: workspace.id, userId: existing.userId } });
    expect(membership.status).toBe('active');
  });

  it('matches the address whatever its case', async () => {
    const lower = uniqueEmail('mixedcase');
    const { owner, workspace, token } = await storeWithInvite({ email: lower.toUpperCase() });
    expect((await db.Membership.findOne({ where: { workspaceId: workspace.id, status: 'invited' } })).invitedEmail).toBe(lower);
    // The pending-invite check sees the same address in another case.
    const role = await db.Role.findOne({ where: { workspaceId: workspace.id, key: 'editor' } });
    const again = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/members`)
      .set(bearer(owner.accessToken))
      .send({ email: lower, roleId: role.id });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_INVITED');

    const accessToken = await signUp(lower);
    expect((await accept(token, accessToken)).status).toBe(200);
  });

  it('works once: a used link says it was already accepted', async () => {
    const { email, token } = await storeWithInvite();
    const accessToken = await signUp(email);
    expect((await accept(token, accessToken)).status).toBe(200);

    const second = await accept(token, accessToken);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('INVITE_ALREADY_ACCEPTED');
    const read = await request(app).get(`/api/v1/invites/${token}`);
    expect(read.status).toBe(200);
    expect(read.body.invite).toMatchObject({ state: 'accepted', email: null });
  });

  it('refuses an expired link, and a resend gives a new one that works', async () => {
    const { owner, workspace, membershipId, email, token } = await storeWithInvite();
    await db.Membership.update({ inviteExpiresAt: new Date(Date.now() - 1000) }, { where: { id: membershipId } });
    const accessToken = await signUp(email);

    expect((await request(app).get(`/api/v1/invites/${token}`)).body.invite.state).toBe('expired');
    const late = await accept(token, accessToken);
    expect(late.status).toBe(410);
    expect(late.body.error.code).toBe('INVITE_EXPIRED');
    expect((await db.Membership.findByPk(membershipId)).status).toBe('invited');

    const resend = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/invites/${membershipId}/resend`)
      .set(bearer(owner.accessToken));
    expect(resend.status).toBe(200);
    const fresh = lastInviteToken(email);
    expect(fresh).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh).not.toBe(token);
    // The old link is gone; the new one works.
    expect((await accept(token, accessToken)).body.error.code).toBe('INVITE_INVALID');
    expect((await accept(fresh, accessToken)).status).toBe(200);
  });

  it('refuses a wrong or malformed token', async () => {
    const accessToken = await signUp(uniqueEmail('nobody'));
    const wrong = 'a'.repeat(64);
    for (const token of [wrong, 'not-a-token', 'A'.repeat(64)]) {
      const read = await request(app).get(`/api/v1/invites/${token}`);
      expect(read.status).toBe(404);
      expect(read.body.error.code).toBe('INVITE_INVALID');
      const res = await accept(token, accessToken);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('INVITE_INVALID');
    }
  });

  it('refuses an account with another address, and leaves the invite pending', async () => {
    const { membershipId, token } = await storeWithInvite();
    const other = await signUp(uniqueEmail('other'));
    const res = await accept(token, other);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVITE_EMAIL_MISMATCH');
    const row = await db.Membership.findByPk(membershipId);
    expect(row).toMatchObject({ status: 'invited', userId: null });
  });

  it('needs a signed-in account to accept', async () => {
    const { token } = await storeWithInvite();
    const res = await request(app).post(`/api/v1/invites/${token}/accept`).send({});
    expect(res.status).toBe(401);
  });

  it('gives the invited role only, whatever the request says', async () => {
    const { workspace, email, token } = await storeWithInvite({ roleKey: 'confirmation_agent' });
    const ownerRole = await db.Role.findOne({ where: { workspaceId: workspace.id, key: 'owner' } });
    const accessToken = await signUp(email);

    const res = await accept(token, accessToken, { roleId: ownerRole.id, role: 'owner', status: 'active' });
    expect(res.status).toBe(200);
    expect(res.body.role.key).toBe('confirmation_agent');

    const H = bearer(accessToken);
    // An owner's route stays closed to the new member.
    expect((await request(app).get(`/api/v1/workspaces/${workspace.id}/members`).set(H)).status).toBe(403);
    const user = await db.User.findOne({ where: { email } });
    const membership = await db.Membership.findOne({ where: { workspaceId: workspace.id, userId: user.id }, include: ['role'] });
    expect(membership.role.key).toBe('confirmation_agent');
  });

  it('tells a member they are already in the store', async () => {
    const { owner, workspace, email, token } = await storeWithInvite();
    const existing = await registerAndActivate({ email: uniqueEmail('twice') });
    // The pending row's address is changed to an account already in the store.
    await db.Membership.update({ invitedEmail: existing.email }, { where: { workspaceId: workspace.id, invitedEmail: email } });
    const role = await db.Role.findOne({ where: { workspaceId: workspace.id, key: 'editor' } });
    expect(
      (await request(app).post(`/api/v1/workspaces/${workspace.id}/members`).set(bearer(owner.accessToken)).send({ email: existing.email, roleId: role.id })).status
    ).toBe(201);
    const res = await accept(token, existing.accessToken);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_MEMBER');
  });
});

describe('the invite email', () => {
  it('links to /invites with the token for a new address, and escapes the names', () => {
    const out = renderTemplate('workspace_invite', {
      workspaceName: '<b>Shop</b>',
      roleName: 'Editor',
      email: 'new@example.com',
      token: 'f'.repeat(64),
      expiresInDays: 7,
    });
    expect(out.html).toContain(`/invites?token=${'f'.repeat(64)}`);
    expect(out.html).toContain('&lt;b&gt;Shop&lt;/b&gt;');
    expect(out.html).not.toContain('<b>Shop</b>');
    expect(out.text).toContain('7 days');
  });

  it('sends an account added at once to its stores, with no token', async () => {
    const owner = await registerAndActivate();
    const workspace = await createWorkspace(owner.accessToken, 'Added Co');
    const member = await registerAndActivate();
    const role = await db.Role.findOne({ where: { workspaceId: workspace.id, key: 'editor' } });
    await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/members`)
      .set(bearer(owner.accessToken))
      .send({ email: member.email, roleId: role.id })
      .expect(201);
    const call = emailSpy.mock.calls.find(([arg]) => arg.template === 'workspace_invite' && arg.recipient === member.email);
    expect(call[0].data.token).toBeUndefined();
    const out = renderTemplate('workspace_invite', call[0].data);
    expect(out.subject).toMatch(/added to Added Co/);
    expect(out.html).toContain('/workspaces');
    expect(out.html).not.toContain('/invites');
  });
});

describe('an invitee who signs up through Google', () => {
  it('is not asked for a plan while one is required, and joins through the link', async () => {
    await db.Plan.create({
      key: `invite-plan-${Date.now()}`,
      name: 'Invite plan',
      monthlyPriceAmount: 29900,
      yearlyPriceAmount: 299000,
      currency: 'EGP',
      trialDays: 14,
      features: [],
      isActive: true,
      isPublic: true,
    });
    const { workspace, email, token } = await storeWithInvite();
    env.signup.requirePlan = true;

    googleClient.fetchProfile.mockResolvedValueOnce({ googleId: `g-${email}`, email, emailVerified: true, fullName: 'G Teammate' });
    const callback = await require('../helpers/googleSignIn').googleCallback('code=x');
    const accessToken = new URL(callback.headers.location, 'http://x').searchParams.get('accessToken');
    const me = await request(app).get('/api/v1/auth/me').set(bearer(accessToken));
    expect(me.body.needsPlan).toBe(false);

    expect((await accept(token, accessToken)).status).toBe(200);
    const list = await request(app).get('/api/v1/workspaces').set(bearer(accessToken));
    expect(list.body.workspaces.map((w) => w.workspace.id)).toEqual([workspace.id]);
  });
});
