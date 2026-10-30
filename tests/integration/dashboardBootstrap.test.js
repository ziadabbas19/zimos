'use strict';

// GET /workspaces/:id/bootstrap: the dashboard frame's reads in one answer.
// Each part must be exactly what its own endpoint answers (the dashboard hands
// it to the screen that would have asked), a part the role may not read is
// null, and nothing from another store ever comes back.

const { app, request, setupWorkspaceWithProduct, addMemberWithRole, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function get(token, path) {
  return request(app).get(`/api/v1${path}`).set(bearer(token));
}

async function placeOrder(token, workspaceId, variantId) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `boot-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: 1 }],
      contact: { fullName: 'Bootstrap Buyer', phone: '01055500022' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Boot St' },
      paymentMethod: 'cod',
    });
  expect(res.status).toBe(201);
  return res.body.order;
}

/** Every part next to the body of the endpoint it stands for. */
async function separateReads(token, ws) {
  const [me, ui, list, access, plan, summary, shortcuts, counts, pipeline, inbox] = await Promise.all([
    get(token, '/auth/me'),
    get(token, '/auth/me/ui-preferences'),
    get(token, '/workspaces'),
    get(token, `/workspaces/${ws}/access`),
    get(token, `/workspaces/${ws}/plan-features`),
    get(token, `/workspaces/${ws}/notifications/summary`),
    get(token, `/workspaces/${ws}/shortcuts`),
    get(token, `/workspaces/${ws}/confirmation-tasks/counts`),
    get(token, `/workspaces/${ws}/orders/pipeline`),
    get(token, `/workspaces/${ws}/inbox/conversations?status=open&unread=true&limit=1`),
  ]);
  return { me, ui, list, access, plan, summary, shortcuts, counts, pipeline, inbox };
}

describe('GET /workspaces/:id/bootstrap', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await setupWorkspaceWithProduct({ workspaceName: 'Boot Co' });
    await placeOrder(ctx.auth.accessToken, ctx.workspace.id, ctx.variant.id);
    await request(app)
      .put(`/api/v1/workspaces/${ctx.workspace.id}/shortcuts`)
      .set(bearer(ctx.auth.accessToken))
      .send({ shortcuts: ['/orders', '/catalog'] });
  });

  it('answers each part exactly as its own endpoint does, for the owner', async () => {
    const token = ctx.auth.accessToken;
    const ws = ctx.workspace.id;
    const res = await get(token, `/workspaces/${ws}/bootstrap`);
    expect(res.status).toBe(200);
    // One member's own data: never kept by a shared cache or the browser.
    expect(res.headers['cache-control']).toBe('private, no-store');
    const boot = res.body.bootstrap;

    const own = await separateReads(token, ws);
    for (const r of Object.values(own)) expect(r.status).toBe(200);

    expect(boot.me).toEqual(own.me.body);
    expect(boot.uiPreferences).toEqual(own.ui.body.uiPreferences);
    expect(boot.workspaces).toEqual(own.list.body.workspaces);
    expect(boot.access).toEqual(own.access.body.access);
    expect(boot.planFeatures).toEqual(own.plan.body.planFeatures);
    expect(boot.notifications).toEqual(own.summary.body);
    expect(boot.shortcuts).toEqual(own.shortcuts.body.shortcuts);
    expect(boot.shortcuts).toEqual(['/orders', '/catalog']);
    expect(boot.confirmationCounts).toEqual(own.counts.body.counts);
    expect(boot.inboxUnread).toEqual(own.inbox.body);
    // The pipeline is left to its own request (it counts every order of the store).
    expect(boot).not.toHaveProperty('orderPipeline');
    // The order placed above is in the counts, so the parity is not between two empty answers.
    expect(boot.confirmationCounts.pending + boot.confirmationCounts.inProgress).toBeGreaterThan(0);
  });

  it('leaves null the parts a role may not read, as those endpoints refuse it', async () => {
    const ws = ctx.workspace.id;
    const editor = await addMemberWithRole(ctx.auth.accessToken, ws, 'editor', 'Ed Itor');

    const res = await get(editor.accessToken, `/workspaces/${ws}/bootstrap`);
    expect(res.status).toBe(200);
    const boot = res.body.bootstrap;
    expect(boot.confirmationCounts).toBeNull();
    expect(boot.inboxUnread).toBeNull();

    const own = await separateReads(editor.accessToken, ws);
    expect(own.counts.status).toBe(403);
    expect(own.pipeline.status).toBe(403);
    expect(own.inbox.status).toBe(403);
    // What the editor may read still matches.
    expect(boot.me).toEqual(own.me.body);
    expect(boot.workspaces).toEqual(own.list.body.workspaces);
    expect(boot.access).toEqual(own.access.body.access);
    expect(boot.notifications).toEqual(own.summary.body);
    expect(boot.shortcuts).toEqual([]);
  });

  it('gives a confirmation agent the counts and the inbox badge it works from', async () => {
    const ws = ctx.workspace.id;
    const agent = await addMemberWithRole(ctx.auth.accessToken, ws, 'confirmation_agent', 'Con Firm');
    const boot = (await get(agent.accessToken, `/workspaces/${ws}/bootstrap`)).body.bootstrap;
    const own = await separateReads(agent.accessToken, ws);
    expect(boot.confirmationCounts).toEqual(own.counts.body.counts);
    expect(boot.inboxUnread).toEqual(own.inbox.body);
  });

  it('refuses a store the account is not a member of, the same way as every store route', async () => {
    const stranger = await registerAndActivate({ fullName: 'Stranger' });
    const theirs = await createWorkspace(stranger.accessToken, 'Stranger Co');

    const res = await get(stranger.accessToken, `/workspaces/${ctx.workspace.id}/bootstrap`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Boot Co');
    expect(res.body.bootstrap).toBeUndefined();

    // Their own store's answer names only their own store and nothing of the other one.
    const mine = await get(stranger.accessToken, `/workspaces/${theirs.id}/bootstrap`);
    expect(mine.status).toBe(200);
    expect(mine.body.bootstrap.workspaces.map((w) => w.workspace.id)).toEqual([theirs.id]);
    expect(JSON.stringify(mine.body)).not.toContain(ctx.workspace.id);
    expect(JSON.stringify(mine.body)).not.toContain('Boot Co');
    expect(mine.body.bootstrap.confirmationCounts.pending).toBe(0);
  });

  it('refuses a suspended member, and a request with no session', async () => {
    const ws = ctx.workspace.id;
    const member = await addMemberWithRole(ctx.auth.accessToken, ws, 'editor', 'Gone Soon');
    await db.Membership.update({ status: 'suspended' }, { where: { workspaceId: ws, userId: member.userId } });

    expect((await get(member.accessToken, `/workspaces/${ws}/bootstrap`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/workspaces/${ws}/bootstrap`)).status).toBe(401);
  });

  it('refuses an id that is not a store id', async () => {
    // The API's validation error (core/errors ValidationError), before any membership lookup.
    const res = await get(ctx.auth.accessToken, '/workspaces/not-a-uuid/bootstrap');
    expect(res.status).toBe(422);
  });
});
