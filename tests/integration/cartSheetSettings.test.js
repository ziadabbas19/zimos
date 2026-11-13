'use strict';

// How a store's cart opens (storefront/cartSheet.js): kept in
// workspaces.settings.cart_sheet, written through the store settings' PATCH
// (website.edit), served inside GET /store/:id for every store whatever its
// plan or the cart rewards switch, and checked on the server: known values
// only. Saving it is audited as a Workspace change, which drops the store's
// cached pages here and at the edge. The trust lines under the cart's
// checkout button reach every store's sheet, rewards or not.

const { app, request, setupWorkspaceWithProduct, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const cloudflarePurge = require('../../src/modules/storefront/cloudflarePurge');

const ORIGINAL = { rewards: env.cartRewards.enabled };
afterEach(() => {
  env.cartRewards.enabled = ORIGINAL.rewards;
  jest.restoreAllMocks();
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const DEFAULTS = { enabled: true, openOn: { addToCart: false, cartIcon: true, quickOrder: false }, presentation: 'auto', speed: 'fast' };

async function store() {
  const ctx = await setupWorkspaceWithProduct({ price: 10000, stock: 10 });
  const ws = ctx.workspace.id;
  const patch = (body, token = ctx.auth.accessToken) => request(app).patch(`/api/v1/workspaces/${ws}`).set(bearer(token)).send(body);
  const shown = async () => (await request(app).get(`/api/v1/store/${ws}`)).body.store.cartSheet;
  return { ...ctx, ws, patch, shown };
}

describe('cart sheet settings', () => {
  it('gives a store that never chose the defaults, with no trust lines', async () => {
    const s = await store();
    expect(await s.shown()).toEqual({ ...DEFAULTS, trustItems: [] });
  });

  it('saves what the merchant picks, whole, and serves it with the store', async () => {
    const s = await store();
    const chosen = { enabled: true, openOn: { addToCart: true, cartIcon: false, quickOrder: true }, presentation: 'popup', speed: 'none' };
    const res = await s.patch({ settings: { cart_sheet: chosen } });
    expect(res.status).toBe(200);
    expect(res.body.workspace.settings.cart_sheet).toEqual(chosen);
    expect(await s.shown()).toEqual({ ...chosen, trustItems: [] });

    // Part of it: the rest goes back to its default (sent whole, stored whole).
    await s.patch({ settings: { cart_sheet: { presentation: 'side_drawer' } } });
    expect(await s.shown()).toEqual({ ...DEFAULTS, presentation: 'side_drawer', trustItems: [] });

    // Off for all, then null: back to the defaults.
    await s.patch({ settings: { cart_sheet: { enabled: false } } });
    expect((await s.shown()).enabled).toBe(false);
    await s.patch({ settings: { cart_sheet: null } });
    expect(await s.shown()).toEqual({ ...DEFAULTS, trustItems: [] });
  });

  it('refuses values it does not know and drops keys it does not know', async () => {
    const s = await store();
    for (const bad of [
      { presentation: 'sideways' },
      { speed: 'slow' },
      { speed: 260 },
      { enabled: 'maybe' },
      { openOn: { cartIcon: 'sometimes' } },
      { openOn: 'all' },
    ]) {
      const res = await s.patch({ settings: { cart_sheet: bad } });
      expect({ bad, status: res.status }).toEqual({ bad, status: 422 });
    }
    expect(await s.shown()).toEqual({ ...DEFAULTS, trustItems: [] });

    const res = await s.patch({ settings: { cart_sheet: { speed: 'normal', colour: 'red', openOn: { cartIcon: true, wiggle: true } } } });
    expect(res.status).toBe(200);
    expect(res.body.workspace.settings.cart_sheet).toEqual({ ...DEFAULTS, speed: 'normal' });
  });

  it('reads a stored value it cannot read as the defaults', async () => {
    const s = await store();
    const ws = await db.Workspace.findByPk(s.ws);
    ws.settings = { ...(ws.settings || {}), cart_sheet: { presentation: 'hologram', speed: 'fast' } };
    ws.changed('settings', true);
    await ws.save();
    expect(await s.shown()).toEqual({ ...DEFAULTS, trustItems: [] });
  });

  it('takes the permission that edits the store settings, and never another store’s', async () => {
    const s = await store();
    const other = await store();
    const accountant = await addMemberWithRole(s.auth.accessToken, s.ws, 'accountant');
    const editor = await addMemberWithRole(s.auth.accessToken, s.ws, 'editor');

    expect((await s.patch({ settings: { cart_sheet: { speed: 'none' } } }, accountant.accessToken)).status).toBe(403);
    expect((await s.shown()).speed).toBe('fast');
    expect((await s.patch({ settings: { cart_sheet: { speed: 'none' } } }, editor.accessToken)).status).toBe(200);
    expect((await s.shown()).speed).toBe('none');

    // The first store's owner cannot write the second store's.
    const foreign = await request(app)
      .patch(`/api/v1/workspaces/${other.ws}`)
      .set(bearer(s.auth.accessToken))
      .send({ settings: { cart_sheet: { enabled: false } } });
    expect([403, 404]).toContain(foreign.status);
    expect(await other.shown()).toEqual({ ...DEFAULTS, trustItems: [] });
  });

  it('is audited as a store change, which drops the store’s cached pages and edge copies', async () => {
    const s = await store();
    const purge = jest.spyOn(cloudflarePurge, 'purgeStore').mockImplementation(() => undefined);
    const res = await s.patch({ settings: { cart_sheet: { presentation: 'bottom_sheet' } } });
    expect(res.status).toBe(200);
    expect(purge).toHaveBeenCalledWith(s.ws, expect.anything());
    const audit = await db.AuditLog.findOne({ where: { workspaceId: s.ws, action: 'workspace.update' }, order: [['createdAt', 'DESC']] });
    expect(audit).not.toBeNull();
    expect(audit.entityType).toBe('Workspace');
    expect(audit.afterState.settings.cart_sheet.presentation).toBe('bottom_sheet');
  });

  it('is the same for every shopper, so the store stays cacheable', async () => {
    const s = await store();
    await s.patch({ settings: { cart_sheet: { presentation: 'popup' } } });
    const a = await request(app).get(`/api/v1/store/${s.ws}`).set('Cookie', 'visitor=one').set('X-Cart-Token', 'aaa');
    const b = await request(app).get(`/api/v1/store/${s.ws}`).set('Cookie', 'visitor=two');
    expect(a.status).toBe(200);
    expect(a.headers['set-cookie']).toBeUndefined();
    expect(a.body.store.cartSheet).toEqual(b.body.store.cartSheet);
  });
});

describe('the lines under the cart’s checkout button', () => {
  it('reach every store’s sheet, with rewards off and the rewards switch off', async () => {
    env.cartRewards.enabled = false;
    const s = await store();
    await db.CartRewardSettings.create({
      workspaceId: s.ws,
      enabled: false,
      tiers: [],
      trustItems: [
        { text: { ar: 'دفع عند الاستلام', en: ' Cash on delivery ' }, enabled: true },
        { text: { ar: 'مخفي', en: 'Hidden' }, enabled: false },
        { text: { ar: '  ', en: '' }, enabled: true },
        { text: { ar: '', en: 'Free returns' } },
      ],
    });
    expect((await s.shown()).trustItems).toEqual([{ text: { ar: 'دفع عند الاستلام', en: 'Cash on delivery' } }, { text: { ar: '', en: 'Free returns' } }]);
  });

  it('change with the cart rewards save, which drops the store’s cache too', async () => {
    env.cartRewards.enabled = true;
    const s = await store();
    const purge = jest.spyOn(cloudflarePurge, 'purgeStore').mockImplementation(() => undefined);
    const saved = await request(app)
      .put(`/api/v1/workspaces/${s.ws}/cart-rewards`)
      .set(bearer(s.auth.accessToken))
      .send({ enabled: false, tiers: [], trustItems: [{ text: { ar: 'شحن سريع', en: 'Fast delivery' }, enabled: true }] });
    expect(saved.status).toBe(200);
    expect(purge).toHaveBeenCalledWith(s.ws, expect.anything());
    expect((await s.shown()).trustItems).toEqual([{ text: { ar: 'شحن سريع', en: 'Fast delivery' } }]);
  });
});

describe('“you saved” for every store', () => {
  it('the quote says what the lines sell below their compare-at price, rewards or not', async () => {
    env.cartRewards.enabled = false;
    const s = await store();
    // EGP 100 a piece, listed at EGP 150.
    await db.ProductVariant.update({ compareAtAmount: 15000 }, { where: { id: s.variant.id } });
    const res = await request(app)
      .post(`/api/v1/store/${s.ws}/shipping-quote`)
      .send({ governorate: 'القاهرة (Cairo)', items: [{ variantId: s.variant.id, quantity: 2 }] });
    expect(res.status).toBe(200);
    expect(res.body.quote.rewards).toBeUndefined();
    expect(res.body.quote.lineSavingsAmount).toBe(10000);

    await db.ProductVariant.update({ compareAtAmount: null }, { where: { id: s.variant.id } });
    const plain = await request(app).post(`/api/v1/store/${s.ws}/shipping-quote`).send({ items: [{ variantId: s.variant.id, quantity: 2 }] });
    expect(plain.body.quote.lineSavingsAmount).toBe(0);
  });
});
