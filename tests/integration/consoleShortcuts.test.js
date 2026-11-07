'use strict';

// The rows a person arranges for themselves, besides the dashboard's Home row
// (homeShortcuts.test.js): the console's shortcuts and phone bar per console
// account (platformAdmin/consoleShortcuts.js), and the dashboard's phone bar per
// member and store (dashboard/homeShortcuts.js MOBILE_NAV). Migration 746.

const { app, request, makePlatformUser, registerAndActivate, createWorkspace, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const { PLATFORM_PERMISSIONS: P } = require('../../src/core/security/platformPermissions');

const keep = (account, keys) => db.User.update({ platformPermissions: keys }, { where: { id: account.userId } });

describe("the console's shortcuts row", () => {
  it('starts on the defaults it may open, saves an order, refuses a page it cannot open, and resets', async () => {
    const account = await makePlatformUser('admin');
    await keep(account, [P.WORKSPACES_VIEW, P.SUPPORT_VIEW]);

    const first = await request(app).get('/api/v1/admin/me/home-shortcuts').set(account.H);
    expect(first.status).toBe(200);
    expect(first.body.homeShortcuts).toMatchObject({ customized: false, shortcuts: ['workspaces', 'users', 'tickets', 'notifications'], max: 12 });
    expect(first.body.homeShortcuts.available).not.toContain('admin_users');

    const refused = await request(app).put('/api/v1/admin/me/home-shortcuts').set(account.H).send({ shortcuts: ['tickets', 'admin_users'] });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('HOME_SHORTCUT_NOT_ALLOWED');

    const saved = await request(app).put('/api/v1/admin/me/home-shortcuts').set(account.H).send({ shortcuts: ['tickets', 'workspaces'] });
    expect(saved.body.homeShortcuts).toMatchObject({ customized: true, shortcuts: ['tickets', 'workspaces'] });

    // A permission taken away takes its page off the row; given back, it comes back.
    await keep(account, [P.WORKSPACES_VIEW]);
    const narrowed = await request(app).get('/api/v1/admin/me/home-shortcuts').set(account.H);
    expect(narrowed.body.homeShortcuts.shortcuts).toEqual(['workspaces']);
    await keep(account, [P.WORKSPACES_VIEW, P.SUPPORT_VIEW]);
    const back = await request(app).get('/api/v1/admin/me/home-shortcuts').set(account.H);
    expect(back.body.homeShortcuts.shortcuts).toEqual(['tickets', 'workspaces']);

    const reset = await request(app).delete('/api/v1/admin/me/home-shortcuts').set(account.H);
    expect(reset.body.homeShortcuts).toMatchObject({ customized: false, shortcuts: ['workspaces', 'users', 'tickets', 'notifications'] });
  });

  it("is each account's own", async () => {
    const one = await makePlatformUser('creator');
    const two = await makePlatformUser('creator');
    await request(app).put('/api/v1/admin/me/home-shortcuts').set(one.H).send({ shortcuts: ['plans'] });
    const other = await request(app).get('/api/v1/admin/me/home-shortcuts').set(two.H);
    expect(other.body.homeShortcuts.customized).toBe(false);
  });

  it('is refused to an account with no console role', async () => {
    const merchant = await registerAndActivate();
    const res = await request(app).get('/api/v1/admin/me/home-shortcuts').set({ Authorization: `Bearer ${merchant.accessToken}` });
    expect(res.status).toBe(403);
  });
});

describe("the console's phone bar", () => {
  it('is the bar it always was until arranged, four slots at most', async () => {
    const account = await makePlatformUser('creator');
    const first = await request(app).get('/api/v1/admin/me/mobile-nav').set(account.H);
    expect(first.body.mobileNav).toMatchObject({ customized: false, shortcuts: ['overview', 'workspaces', 'subscriptions', 'tickets'], max: 4 });

    const tooMany = await request(app).put('/api/v1/admin/me/mobile-nav').set(account.H).send({ shortcuts: ['overview', 'workspaces', 'tickets', 'plans', 'agents'] });
    expect(tooMany.status).toBe(422);

    const saved = await request(app).put('/api/v1/admin/me/mobile-nav').set(account.H).send({ shortcuts: ['agents', 'overview'] });
    expect(saved.body.mobileNav).toMatchObject({ customized: true, shortcuts: ['agents', 'overview'] });
    // The Home row is a separate one.
    const home = await request(app).get('/api/v1/admin/me/home-shortcuts').set(account.H);
    expect(home.body.homeShortcuts.customized).toBe(false);
  });
});

describe("the dashboard's phone bar", () => {
  it('per member and store: the old bar until arranged, only pages the role opens, reset', async () => {
    const owner = await registerAndActivate();
    const workspace = await createWorkspace(owner.accessToken);
    const H = { Authorization: `Bearer ${owner.accessToken}` };
    const url = `/api/v1/workspaces/${workspace.id}/mobile-nav`;

    const first = await request(app).get(url).set(H);
    expect(first.body.mobileNav).toMatchObject({ customized: false, shortcuts: ['home', 'orders', 'confirmation_queue', 'products'], max: 4 });

    const saved = await request(app).put(url).set(H).send({ shortcuts: ['home', 'discounts', 'customers'] });
    expect(saved.body.mobileNav).toMatchObject({ customized: true, shortcuts: ['home', 'discounts', 'customers'] });
    const boot = await request(app).get(`/api/v1/workspaces/${workspace.id}/bootstrap`).set(H);
    expect(boot.body.bootstrap.mobileNav.shortcuts).toEqual(['home', 'discounts', 'customers']);

    const reset = await request(app).delete(url).set(H);
    expect(reset.body.mobileNav.customized).toBe(false);
  });

  it("refuses a page the member's role cannot open", async () => {
    const owner = await registerAndActivate();
    const workspace = await createWorkspace(owner.accessToken);
    const editor = await addMemberWithRole(owner.accessToken, workspace.id, 'editor');
    const H = { Authorization: `Bearer ${editor.accessToken}` };
    const url = `/api/v1/workspaces/${workspace.id}/mobile-nav`;
    const first = await request(app).get(url).set(H);
    expect(first.body.mobileNav.shortcuts).not.toContain('orders');
    const refused = await request(app).put(url).set(H).send({ shortcuts: ['home', 'orders'] });
    expect(refused.status).toBe(403);
  });
});
