'use strict';

// GET / PUT / DELETE /workspaces/:id/home-shortcuts: each member's own row in
// each store, only from the catalogue, only what they may open.

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct, addMemberWithRole, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { DEFAULT_HOME_SHORTCUTS, HOME_SHORTCUT_IDS } = require('../../src/modules/dashboard/homeShortcuts');

const ORIGINAL = { growth: env.growth.requirePlanFeature, enforcement: env.planFeatures.enforcement };
afterEach(() => {
  env.growth.requirePlanFeature = ORIGINAL.growth;
  env.planFeatures.enforcement = ORIGINAL.enforcement;
  env.storeFeatures.length = 0;
});

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const url = (workspaceId) => `/api/v1/workspaces/${workspaceId}/home-shortcuts`;
const read = (token, workspaceId) => request(app).get(url(workspaceId)).set(bearer(token));
const save = (token, workspaceId, body) => request(app).put(url(workspaceId)).set(bearer(token)).send(body);
const reset = (token, workspaceId) => request(app).delete(url(workspaceId)).set(bearer(token));
const code = (res) => res.body && res.body.error && res.body.error.code;

async function storedRow(workspaceId, userId) {
  const [row] = await db.sequelize.query('SELECT home_shortcuts FROM memberships WHERE workspace_id = :workspaceId AND user_id = :userId', {
    replacements: { workspaceId, userId },
    type: db.Sequelize.QueryTypes.SELECT,
  });
  return row.home_shortcuts;
}

async function onPlan(workspaceId, features) {
  const plan = await db.Plan.create({
    key: `hs-${crypto.randomBytes(4).toString('hex')}`,
    name: 'Plan',
    currency: 'EGP',
    monthlyPriceAmount: 10000,
    yearlyPriceAmount: 100000,
    trialDays: 14,
    isActive: true,
    isPublic: true,
    features,
  });
  await db.Subscription.update({ planId: plan.id }, { where: { workspaceId } });
}

describe('/workspaces/:id/home-shortcuts', () => {
  let ctx;
  let ws;
  let token;

  beforeEach(async () => {
    ctx = await setupWorkspaceWithProduct({ workspaceName: 'Shortcuts Co' });
    ws = ctx.workspace.id;
    token = ctx.auth.accessToken;
  });

  describe('reading', () => {
    it('a member who never arranged the row gets the default one', async () => {
      const res = await read(token, ws);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.body.homeShortcuts.customized).toBe(false);
      expect(res.body.homeShortcuts.shortcuts).toEqual([...DEFAULT_HOME_SHORTCUTS]);
      expect(res.body.homeShortcuts.defaults).toEqual([...DEFAULT_HOME_SHORTCUTS]);
      expect(res.body.homeShortcuts.max).toBe(12);
      expect(res.body.homeShortcuts.available).toEqual(expect.arrayContaining(['orders', 'customers', 'new_order']));
    });

    it('stores nothing until the member saves', async () => {
      await read(token, ws);
      expect(await storedRow(ws, ctx.auth.user.id)).toBeNull();
    });

    it('narrows the default row and the catalogue by role', async () => {
      const editor = await addMemberWithRole(token, ws, 'editor', 'Ed Itor');
      const { homeShortcuts } = (await read(editor.accessToken, ws)).body;
      expect(homeShortcuts.shortcuts).toEqual(['add_product', 'website', 'store_settings']);
      expect(homeShortcuts.available).toContain('products');
      expect(homeShortcuts.available).not.toContain('orders');
      expect(homeShortcuts.available).not.toContain('confirmation_queue');
    });
  });

  describe('saving', () => {
    it('keeps the order given, hidden defaults stay off, and the answer is what a read then says', async () => {
      const list = ['customers', 'new_order', 'media'];
      const res = await save(token, ws, { shortcuts: list });
      expect(res.status).toBe(200);
      expect(res.body.homeShortcuts.customized).toBe(true);
      expect(res.body.homeShortcuts.shortcuts).toEqual(list);
      expect(await storedRow(ws, ctx.auth.user.id)).toEqual(list);
      expect((await read(token, ws)).body).toEqual(res.body);
    });

    it('takes an empty row, and tells it from a row never arranged', async () => {
      const res = await save(token, ws, { shortcuts: [] });
      expect(res.status).toBe(200);
      expect(res.body.homeShortcuts).toMatchObject({ customized: true, shortcuts: [] });
      expect(await storedRow(ws, ctx.auth.user.id)).toEqual([]);
    });

    it('takes 12 and refuses a 13th', async () => {
      const allowed = (await read(token, ws)).body.homeShortcuts.available;
      expect((await save(token, ws, { shortcuts: allowed.slice(0, 12) })).status).toBe(200);
      const over = await save(token, ws, { shortcuts: allowed.slice(0, 13) });
      expect(over.status).toBe(422);
      expect(code(over)).toBe('VALIDATION_ERROR');
      expect(await storedRow(ws, ctx.auth.user.id)).toEqual(allowed.slice(0, 12));
    });

    it('refuses a repeated id', async () => {
      const res = await save(token, ws, { shortcuts: ['orders', 'customers', 'orders'] });
      expect(res.status).toBe(422);
      expect(await storedRow(ws, ctx.auth.user.id)).toBeNull();
    });

    it.each([
      ['an id outside the catalogue', { shortcuts: ['orders', 'nope'] }],
      ['a path instead of an id', { shortcuts: ['/orders'] }],
      ['an outside address', { shortcuts: ['https://example.com'] }],
      ['something other than strings', { shortcuts: [{ id: 'orders' }] }],
      ['not a list', { shortcuts: 'orders' }],
      ['no list at all', {}],
    ])('refuses %s', async (_label, body) => {
      const res = await save(token, ws, body);
      expect(res.status).toBe(422);
      expect(code(res)).toBe('VALIDATION_ERROR');
      expect(await storedRow(ws, ctx.auth.user.id)).toBeNull();
    });

    it('takes every id of the catalogue this deploy offers', async () => {
      const { available } = (await read(token, ws)).body.homeShortcuts;
      for (const id of available) expect(HOME_SHORTCUT_IDS).toContain(id);
      expect((await save(token, ws, { shortcuts: available.slice(-12) })).status).toBe(200);
    });

    it('records who changed what in the audit log', async () => {
      await save(token, ws, { shortcuts: ['orders'] });
      const entry = await db.AuditLog.findOne({ where: { workspaceId: ws, action: 'membership.home_shortcuts_set' } });
      expect(entry).not.toBeNull();
      expect(entry.actorUserId).toBe(ctx.auth.user.id);
    });
  });

  describe('permissions', () => {
    it('refuses what the role may not open, and stores nothing', async () => {
      const editor = await addMemberWithRole(token, ws, 'editor', 'Ed Itor');
      const res = await save(editor.accessToken, ws, { shortcuts: ['website', 'orders'] });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('HOME_SHORTCUT_NOT_ALLOWED');
      expect(res.body.error.details).toEqual({ ids: ['orders'] });
      expect(await storedRow(ws, editor.userId)).toBeNull();
    });

    it('takes what the role may open', async () => {
      const agent = await addMemberWithRole(token, ws, 'confirmation_agent', 'Con Firm');
      const res = await save(agent.accessToken, ws, { shortcuts: ['confirmation_queue', 'inbox', 'customers'] });
      expect(res.status).toBe(200);
      expect(res.body.homeShortcuts.shortcuts).toEqual(['confirmation_queue', 'inbox', 'customers']);
    });

    it('a role that shrinks loses the page from the row, and gets it back with the permission', async () => {
      const operator = await addMemberWithRole(token, ws, 'order_operator', 'Op Erator');
      expect((await save(operator.accessToken, ws, { shortcuts: ['customers', 'orders'] })).status).toBe(200);

      const editorRole = await db.Role.findOne({ where: { workspaceId: ws, key: 'editor' } });
      const operatorRole = await db.Role.findOne({ where: { workspaceId: ws, key: 'order_operator' } });
      await db.Membership.update({ roleId: editorRole.id }, { where: { workspaceId: ws, userId: operator.userId } });
      expect((await read(operator.accessToken, ws)).body.homeShortcuts.shortcuts).toEqual([]);
      expect(await storedRow(ws, operator.userId)).toEqual(['customers', 'orders']);

      await db.Membership.update({ roleId: operatorRole.id }, { where: { workspaceId: ws, userId: operator.userId } });
      expect((await read(operator.accessToken, ws)).body.homeShortcuts.shortcuts).toEqual(['customers', 'orders']);
    });
  });

  describe('the plan', () => {
    it('with the gate off, a plan without the key loses nothing', async () => {
      await onPlan(ws, []);
      expect((await save(token, ws, { shortcuts: ['reviews', 'web_analytics'] })).status).toBe(200);
    });

    it('with the gate on, the page leaves the catalogue and the row, and cannot be saved', async () => {
      expect((await save(token, ws, { shortcuts: ['reviews', 'web_analytics', 'orders'] })).status).toBe(200);
      await onPlan(ws, []);
      env.planFeatures.enforcement = true;
      env.growth.requirePlanFeature = true;

      const { homeShortcuts } = (await read(token, ws)).body;
      expect(homeShortcuts.shortcuts).toEqual(['orders']);
      expect(homeShortcuts.available).not.toContain('reviews');
      expect(homeShortcuts.available).not.toContain('web_analytics');

      const refused = await save(token, ws, { shortcuts: ['reviews'] });
      expect(refused.status).toBe(403);
      expect(code(refused)).toBe('HOME_SHORTCUT_NOT_ALLOWED');
    });

    it('a plan that holds the key keeps the page with the gate on', async () => {
      await onPlan(ws, ['advanced_analytics']);
      env.planFeatures.enforcement = true;
      expect((await save(token, ws, { shortcuts: ['web_analytics', 'visitors'] })).status).toBe(200);
    });

    it('the default row is the same on a plan with nothing, with every gate on', async () => {
      await onPlan(ws, []);
      env.planFeatures.enforcement = true;
      env.growth.requirePlanFeature = true;
      expect((await read(token, ws)).body.homeShortcuts.shortcuts).toEqual([...DEFAULT_HOME_SHORTCUTS]);
    });
  });

  describe('a feature switched off for this deploy', () => {
    it('is not offered and cannot be saved; on, it is', async () => {
      const off = await save(token, ws, { shortcuts: ['size_charts'] });
      expect(off.status).toBe(403);
      expect((await read(token, ws)).body.homeShortcuts.available).not.toContain('size_charts');

      env.storeFeatures.push('size_charts');
      expect((await read(token, ws)).body.homeShortcuts.available).toContain('size_charts');
      expect((await save(token, ws, { shortcuts: ['size_charts'] })).status).toBe(200);
    });
  });

  describe('going back to the default', () => {
    it('forgets the list, and the member follows the default row again', async () => {
      await save(token, ws, { shortcuts: ['customers'] });
      const res = await reset(token, ws);
      expect(res.status).toBe(200);
      expect(res.body.homeShortcuts.customized).toBe(false);
      expect(res.body.homeShortcuts.shortcuts).toEqual([...DEFAULT_HOME_SHORTCUTS]);
      // SQL NULL, not a JSON null: "never arranged".
      const [row] = await db.sequelize.query('SELECT home_shortcuts IS NULL AS empty FROM memberships WHERE workspace_id = :ws AND user_id = :user', {
        replacements: { ws, user: ctx.auth.user.id },
        type: db.Sequelize.QueryTypes.SELECT,
      });
      expect(row.empty).toBe(true);
      expect((await read(token, ws)).body).toEqual(res.body);
    });

    it('with nothing to forget it still answers, and writes no audit entry', async () => {
      const res = await reset(token, ws);
      expect(res.status).toBe(200);
      expect(res.body.homeShortcuts.customized).toBe(false);
      expect(await db.AuditLog.count({ where: { workspaceId: ws, action: 'membership.home_shortcuts_reset' } })).toBe(0);
    });

    it('a reset of one member leaves another\'s row alone', async () => {
      const operator = await addMemberWithRole(token, ws, 'order_operator', 'Op Erator');
      await save(token, ws, { shortcuts: ['customers'] });
      await save(operator.accessToken, ws, { shortcuts: ['orders'] });
      await reset(operator.accessToken, ws);
      expect((await read(token, ws)).body.homeShortcuts.shortcuts).toEqual(['customers']);
    });
  });

  describe('isolation', () => {
    it('two members of one store each have their own row', async () => {
      const manager = await addMemberWithRole(token, ws, 'workspace_manager', 'Man Ager');
      await save(token, ws, { shortcuts: ['customers', 'orders'] });
      await save(manager.accessToken, ws, { shortcuts: ['media'] });
      expect((await read(token, ws)).body.homeShortcuts.shortcuts).toEqual(['customers', 'orders']);
      expect((await read(manager.accessToken, ws)).body.homeShortcuts.shortcuts).toEqual(['media']);
    });

    it('one person has a separate row in each of their stores', async () => {
      const other = await createWorkspace(token, 'Second Store');
      await save(token, ws, { shortcuts: ['customers'] });
      expect((await read(token, other.id)).body.homeShortcuts.customized).toBe(false);
      await save(token, other.id, { shortcuts: ['media'] });
      expect((await read(token, ws)).body.homeShortcuts.shortcuts).toEqual(['customers']);
      expect((await read(token, other.id)).body.homeShortcuts.shortcuts).toEqual(['media']);
    });

    it('someone outside the store can neither read, write nor reset, and learns nothing about it', async () => {
      await save(token, ws, { shortcuts: ['customers'] });
      const stranger = await registerAndActivate({ fullName: 'Stranger' });
      await createWorkspace(stranger.accessToken, 'Stranger Co');

      for (const res of [await read(stranger.accessToken, ws), await save(stranger.accessToken, ws, { shortcuts: ['orders'] }), await reset(stranger.accessToken, ws)]) {
        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain('customers');
      }
      expect(await storedRow(ws, ctx.auth.user.id)).toEqual(['customers']);
    });

    it('a suspended member is refused, and no session is refused', async () => {
      const member = await addMemberWithRole(token, ws, 'editor', 'Gone Soon');
      await db.Membership.update({ status: 'suspended' }, { where: { workspaceId: ws, userId: member.userId } });
      expect((await read(member.accessToken, ws)).status).toBe(404);
      expect((await save(member.accessToken, ws, { shortcuts: [] })).status).toBe(404);
      expect((await request(app).get(url(ws))).status).toBe(401);
      expect((await request(app).put(url(ws)).send({ shortcuts: [] })).status).toBe(401);
      expect((await request(app).delete(url(ws))).status).toBe(401);
    });

    it('nothing in the body picks another member: an extra field is dropped', async () => {
      const operator = await addMemberWithRole(token, ws, 'order_operator', 'Op Erator');
      const res = await save(token, ws, { shortcuts: ['customers'], userId: operator.userId, workspaceId: 'other', membershipId: 'other' });
      expect(res.status).toBe(200);
      expect(await storedRow(ws, ctx.auth.user.id)).toEqual(['customers']);
      expect(await storedRow(ws, operator.userId)).toBeNull();
    });

    it('the team list never carries a teammate\'s row', async () => {
      const manager = await addMemberWithRole(token, ws, 'workspace_manager', 'Man Ager');
      await save(manager.accessToken, ws, { shortcuts: ['media'] });
      const res = await request(app).get(`/api/v1/workspaces/${ws}/members`).set(bearer(token));
      expect(res.status).toBe(200);
      expect(res.body.members.length).toBeGreaterThan(1);
      for (const row of res.body.members) expect(row).not.toHaveProperty('homeShortcuts');
    });

    it('refuses an id that is not a store id', async () => {
      expect((await read(token, 'not-a-uuid')).status).toBe(422);
      expect((await save(token, 'not-a-uuid', { shortcuts: [] })).status).toBe(422);
      expect((await reset(token, 'not-a-uuid')).status).toBe(422);
    });
  });

  describe('in the bootstrap', () => {
    const boot = async (accessToken) => (await request(app).get(`/api/v1/workspaces/${ws}/bootstrap`).set(bearer(accessToken))).body.bootstrap;

    it('is the same answer as its own endpoint, arranged or not, for any role', async () => {
      expect((await boot(token)).homeShortcuts).toEqual((await read(token, ws)).body.homeShortcuts);

      await save(token, ws, { shortcuts: ['customers', 'orders'] });
      const arranged = (await boot(token)).homeShortcuts;
      expect(arranged.shortcuts).toEqual(['customers', 'orders']);
      expect(arranged).toEqual((await read(token, ws)).body.homeShortcuts);

      const editor = await addMemberWithRole(token, ws, 'editor', 'Ed Itor');
      expect((await boot(editor.accessToken)).homeShortcuts).toEqual((await read(editor.accessToken, ws)).body.homeShortcuts);
    });

    it('follows the plan', async () => {
      await save(token, ws, { shortcuts: ['web_analytics', 'orders'] });
      await onPlan(ws, []);
      env.planFeatures.enforcement = true;
      expect((await boot(token)).homeShortcuts.shortcuts).toEqual(['orders']);
    });
  });
});
