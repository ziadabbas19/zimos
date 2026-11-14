'use strict';

// The cart rewards bar's look (cartRewards/barAppearance.js, migration 750)
// and each reward's icon: saved with the cart rewards settings, checked on
// the server (known modes, shapes, sizes and icons only, strict hex colours,
// 3:1 contrast while the custom look is the one in use), served with the
// public config and the quote, and dropped from the store's cache on save.
// A store that never chose keeps the look it always had.

const { app, request, setupWorkspaceWithProduct, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const cloudflarePurge = require('../../src/modules/storefront/cloudflarePurge');
const look = require('../../src/modules/cartRewards/barAppearance');

const ORIGINAL = { enabled: env.cartRewards.enabled };
beforeEach(() => {
  env.cartRewards.enabled = true;
});
afterEach(() => {
  env.cartRewards.enabled = ORIGINAL.enabled;
  jest.restoreAllMocks();
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const CAIRO = 'القاهرة (Cairo)';
const TIERS = [
  { thresholdAmount: 50000, type: 'free_shipping' },
  { thresholdAmount: 100000, type: 'percent', value: 5 },
  { thresholdAmount: 150000, type: 'fixed', value: 2000 },
];
const TODAY = {
  shape: 'thick',
  corners: 'rounded',
  fillColor: null,
  trackColor: null,
  marker: 'circle',
  markerSize: 'md',
  showAmounts: true,
  reachedPop: true,
  showMessage: true,
  messageAlign: 'start',
};

async function store() {
  const ctx = await setupWorkspaceWithProduct({ price: 50000, stock: 50 });
  const ws = ctx.workspace.id;
  const put = (body, token = ctx.auth.accessToken) => request(app).put(`/api/v1/workspaces/${ws}/cart-rewards`).set(bearer(token)).send(body);
  const get = (token = ctx.auth.accessToken) => request(app).get(`/api/v1/workspaces/${ws}/cart-rewards`).set(bearer(token));
  const pub = async () => (await request(app).get(`/api/v1/store/${ws}/cart-rewards`)).body.cartRewards;
  const base = { enabled: true, allowCouponStacking: false, tiers: TIERS, trustItems: [] };
  return { ...ctx, ws, put, get, pub, base };
}

describe('the bar’s look', () => {
  it('is the theme’s for a store that never chose, and each reward shows its kind’s icon', async () => {
    const s = await store();
    const fresh = await s.get();
    expect(fresh.status).toBe(200);
    expect(fresh.body.cartRewards.appearance).toEqual({ mode: 'inherit', custom: null });
    expect(fresh.body.cartRewards.cartSpeed).toBe('fast');

    expect((await s.put(s.base)).status).toBe(200);
    const saved = (await s.get()).body.cartRewards;
    expect(saved.appearance).toEqual({ mode: 'inherit', custom: null });
    expect(saved.tiers.map((t) => [t.icon, t.shownIcon])).toEqual([
      [null, 'truck'],
      [null, 'percent'],
      [null, 'tag'],
    ]);
    const shown = await s.pub();
    expect(shown.appearance).toEqual({ mode: 'inherit' });
    expect(shown.tiers.map((t) => t.icon)).toEqual(['truck', 'percent', 'tag']);
    // A row from before migration 750 (no look stored) reads the same.
    const row = await db.CartRewardSettings.findByPk(s.ws);
    expect(row.barAppearance).toBeNull();
  });

  it('keeps each reward’s own icon, in either mode, on the config and the quote', async () => {
    const s = await store();
    const tiers = [{ ...TIERS[0], icon: 'gift' }, { ...TIERS[1], icon: 'crown' }, TIERS[2]];
    expect((await s.put({ ...s.base, tiers })).status).toBe(200);
    expect((await s.pub()).tiers.map((t) => t.icon)).toEqual(['gift', 'crown', 'tag']);
    const quote = await request(app)
      .post(`/api/v1/store/${s.ws}/shipping-quote`)
      .send({ governorate: CAIRO, items: [{ variantId: s.variant.id, quantity: 1 }] });
    expect(quote.status).toBe(200);
    expect(quote.body.quote.rewards.tiers.map((t) => t.icon)).toEqual(['gift', 'crown', 'tag']);
  });

  it('saves a custom look, and keeps it unused while the store goes back to its theme’s', async () => {
    const s = await store();
    const custom = { ...TODAY, shape: 'segmented', corners: 'square', fillColor: '#1D4ED8', trackColor: '#E5E7EB', marker: 'rounded_square', markerSize: 'lg', showAmounts: false, reachedPop: false, showMessage: true, messageAlign: 'center' };
    const res = await s.put({ ...s.base, appearance: { mode: 'custom', custom } });
    expect(res.status).toBe(200);
    expect(res.body.cartRewards.appearance).toEqual({ mode: 'custom', custom: { ...custom, fillColor: '#1d4ed8', trackColor: '#e5e7eb' } });
    expect(await s.pub()).toMatchObject({ appearance: { mode: 'custom', shape: 'segmented', fillColor: '#1d4ed8', marker: 'rounded_square', markerSize: 'lg', messageAlign: 'center' } });

    const back = await s.put({ ...s.base, appearance: { mode: 'inherit', custom: res.body.cartRewards.appearance.custom } });
    expect(back.status).toBe(200);
    expect(back.body.cartRewards.appearance.mode).toBe('inherit');
    expect(back.body.cartRewards.appearance.custom.fillColor).toBe('#1d4ed8');
    expect((await s.pub()).appearance).toEqual({ mode: 'inherit' });

    // A dashboard from before the look sends none: what is saved stays.
    expect((await s.put(s.base)).status).toBe(200);
    expect((await s.get()).body.cartRewards.appearance.custom.fillColor).toBe('#1d4ed8');

    // Reset: the theme's, the custom values cleared.
    const reset = await s.put({ ...s.base, appearance: { mode: 'inherit', custom: null } });
    expect(reset.body.cartRewards.appearance).toEqual({ mode: 'inherit', custom: null });
  });

  it('starts "Customize" from today’s look when nothing custom was saved', async () => {
    const s = await store();
    const res = await s.put({ ...s.base, appearance: { mode: 'custom' } });
    expect(res.status).toBe(200);
    expect(res.body.cartRewards.appearance).toEqual({ mode: 'custom', custom: TODAY });
    expect(look.CUSTOM_DEFAULTS).toEqual(TODAY);
  });

  it('refuses modes, shapes, sizes, icons and colours it does not know', async () => {
    const s = await store();
    const bad = [
      { appearance: { mode: 'fancy' } },
      { appearance: { mode: 'custom', custom: { shape: 'wavy' } } },
      { appearance: { mode: 'custom', custom: { corners: 'bevelled' } } },
      { appearance: { mode: 'custom', custom: { marker: 'triangle' } } },
      { appearance: { mode: 'custom', custom: { markerSize: 'xl' } } },
      { appearance: { mode: 'custom', custom: { messageAlign: 'end' } } },
      { appearance: { mode: 'custom', custom: { fillColor: 'red' } } },
      { appearance: { mode: 'custom', custom: { fillColor: '#fff' } } },
      { appearance: { mode: 'custom', custom: { fillColor: '#12345g' } } },
      { appearance: { mode: 'custom', custom: { trackColor: '#1234567' } } },
      { appearance: { mode: 'custom', custom: { trackColor: 'rgb(0,0,0)' } } },
      { appearance: { mode: 'custom', custom: { showAmounts: 'yes' } } },
      // Even unused (inherit), a custom value must read.
      { appearance: { mode: 'inherit', custom: { fillColor: 'blue' } } },
      { tiers: [{ ...TIERS[0], icon: 'rocket' }] },
      { tiers: [{ ...TIERS[0], icon: '<svg/>' }] },
    ];
    for (const change of bad) {
      const res = await s.put({ ...s.base, ...change });
      expect({ change, status: res.status }).toEqual({ change, status: 422 });
    }
    expect((await s.get()).body.cartRewards.appearance).toEqual({ mode: 'inherit', custom: null });
  });

  it('checks the custom colours’ contrast (3:1) only while the custom look is in use', async () => {
    const s = await store();
    // A pale fill on a pale track: 1.07:1.
    const pale = { ...TODAY, fillColor: '#e0e0e0', trackColor: '#eeeeee' };
    const refused = await s.put({ ...s.base, appearance: { mode: 'custom', custom: pale } });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('VALIDATION_ERROR');
    const detail = refused.body.error.details.find((d) => d.field === 'appearance.custom.fillColor');
    expect(detail.message).toMatch(/fill \(#e0e0e0\) and the track \(#eeeeee\).*3:1/);
    expect((await s.get()).body.cartRewards.appearance.mode).toBe('inherit');

    // Against the theme's track (#dcdace): a custom fill must still reach 3:1.
    const themeTrack = await s.put({ ...s.base, appearance: { mode: 'custom', custom: { ...TODAY, fillColor: '#c8c8c8' } } });
    expect(themeTrack.status).toBe(422);
    expect(themeTrack.body.error.details[0].message).toMatch(/track \(theme\)/);

    // The same pale colours are kept while unused: the theme's look is the one shown.
    const kept = await s.put({ ...s.base, appearance: { mode: 'inherit', custom: pale } });
    expect(kept.status).toBe(200);
    expect(kept.body.cartRewards.appearance).toEqual({ mode: 'inherit', custom: pale });

    // A pair that passes.
    const fine = await s.put({ ...s.base, appearance: { mode: 'custom', custom: { ...TODAY, fillColor: '#1d4ed8', trackColor: '#e5e7eb' } } });
    expect(fine.status).toBe(200);
  });

  it('takes the store’s accent for a fill left to the theme', async () => {
    const s = await store();
    // The default accent (#1f5d5b) on a white track: fine.
    expect((await s.put({ ...s.base, appearance: { mode: 'custom', custom: { ...TODAY, trackColor: '#ffffff' } } })).status).toBe(200);
    // A pale yellow accent on the same white track: refused, naming the theme's side.
    const theme = await request(app).patch(`/api/v1/workspaces/${s.ws}`).set(bearer(s.auth.accessToken)).send({ themeSettings: { primaryColor: '#ffe066' } });
    expect(theme.status).toBe(200);
    const pale = await s.put({ ...s.base, appearance: { mode: 'custom', custom: { ...TODAY, trackColor: '#ffffff' } } });
    expect(pale.status).toBe(422);
    expect(pale.body.error.details[0]).toMatchObject({ field: 'appearance.custom.trackColor' });
    expect(pale.body.error.details[0].message).toMatch(/fill \(theme\) and the track \(#ffffff\)/);
  });

  it('needs discounts.manage, never touches another store’s, and drops the store’s cache on save', async () => {
    const s = await store();
    const other = await store();
    const editor = await addMemberWithRole(s.auth.accessToken, s.ws, 'editor');
    const custom = { mode: 'custom', custom: { ...TODAY, fillColor: '#1d4ed8' } };
    expect((await s.put({ ...s.base, appearance: custom }, editor.accessToken)).status).toBe(403);

    const purge = jest.spyOn(cloudflarePurge, 'purgeStore').mockImplementation(() => undefined);
    expect((await s.put({ ...s.base, appearance: custom })).status).toBe(200);
    expect(purge).toHaveBeenCalledWith(s.ws, expect.anything());
    expect(purge).not.toHaveBeenCalledWith(other.ws, expect.anything());

    const foreign = await request(app).put(`/api/v1/workspaces/${other.ws}/cart-rewards`).set(bearer(s.auth.accessToken)).send({ ...s.base, appearance: custom });
    expect([403, 404]).toContain(foreign.status);
    expect((await other.get()).body.cartRewards.appearance).toEqual({ mode: 'inherit', custom: null });
  });
});
