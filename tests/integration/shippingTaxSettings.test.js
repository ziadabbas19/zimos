'use strict';

// Configurable shipping & tax: zone/rate is_active filtering, the positive
// `regions` zone filter, the free-shipping threshold, the default fallback
// rate, estimated-delivery storage, and the tax_enabled gate — all driven off
// workspaces.settings via the existing PATCH /workspaces/:id path.

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const { calculateShippingAmount } = require('../../src/modules/shipping/shippingPricing');
const { calculateTax } = require('../../src/modules/tax/taxService');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function freshWorkspace() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Ship/Tax Co');
  return { auth, workspace, H: bearer(auth.accessToken) };
}

async function makeZone(workspaceId, over = {}) {
  return db.ShippingZone.create({
    workspaceId,
    name: 'Zone',
    countries: ['EG'],
    regions: [],
    excludedRegions: [],
    ...over,
  });
}

async function makeFlatRate(workspaceId, zoneId, amount, over = {}) {
  return db.ShippingRate.create({
    workspaceId,
    zoneId,
    name: 'Flat',
    rateType: 'flat',
    config: { amount },
    ...over,
  });
}

const dest = (over = {}) => ({
  country: 'EG',
  region: 'Cairo',
  subtotal: 20000,
  totalWeightGrams: 100,
  totalQuantity: 1,
  ...over,
});

describe('shipping pricing — is_active filtering', () => {
  it('ignores inactive rates and inactive zones when choosing a rate', async () => {
    const { workspace } = await freshWorkspace();
    const zone = await makeZone(workspace.id);
    await makeFlatRate(workspace.id, zone.id, 1000, { name: 'cheap-inactive', isActive: false });
    await makeFlatRate(workspace.id, zone.id, 4000, { name: 'active' });

    // the 1000 rate is inactive -> the 4000 active rate is used
    expect(await calculateShippingAmount(workspace.id, dest())).toBe(4000);

    // deactivating the whole zone -> no match -> free fallback (nothing configured)
    await zone.update({ isActive: false });
    expect(await calculateShippingAmount(workspace.id, dest())).toBe(0);
  });
});

describe('shipping pricing — positive regions filter', () => {
  it('matches only listed regions when regions is non-empty, still not excludedRegions', async () => {
    const { workspace } = await freshWorkspace();
    const zone = await makeZone(workspace.id, { regions: ['Cairo', 'Giza'], excludedRegions: ['Giza'] });
    await makeFlatRate(workspace.id, zone.id, 7000);

    expect(await calculateShippingAmount(workspace.id, dest({ region: 'Cairo' }))).toBe(7000);
    // in `regions` but also excluded -> no match -> fallback
    expect(await calculateShippingAmount(workspace.id, dest({ region: 'Giza' }))).toBe(0);
    // not in `regions` -> no match -> fallback
    expect(await calculateShippingAmount(workspace.id, dest({ region: 'Aswan' }))).toBe(0);
  });

  it('an excludedRegions-only zone keeps its original country-wide behaviour', async () => {
    const { workspace } = await freshWorkspace();
    const zone = await makeZone(workspace.id, { regions: [], excludedRegions: ['Sinai'] });
    await makeFlatRate(workspace.id, zone.id, 6000);

    expect(await calculateShippingAmount(workspace.id, dest({ region: 'Cairo' }))).toBe(6000);
    expect(await calculateShippingAmount(workspace.id, dest({ region: 'Sinai' }))).toBe(0);
    expect(await calculateShippingAmount(workspace.id, dest({ region: undefined }))).toBe(6000);
  });
});

describe('shipping pricing — free-shipping threshold', () => {
  it('returns 0 at/above the configured threshold and prices normally below it', async () => {
    const { workspace, H } = await freshWorkspace();
    const zone = await makeZone(workspace.id);
    await makeFlatRate(workspace.id, zone.id, 9000);

    await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}`)
      .set(H)
      .send({ settings: { free_shipping_threshold_amount: 50000 } })
      .expect(200);

    expect(await calculateShippingAmount(workspace.id, dest({ subtotal: 49999 }))).toBe(9000);
    expect(await calculateShippingAmount(workspace.id, dest({ subtotal: 50000 }))).toBe(0);

    // clearing the threshold restores normal pricing
    await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}`)
      .set(H)
      .send({ settings: { free_shipping_threshold_amount: null } })
      .expect(200);
    expect(await calculateShippingAmount(workspace.id, dest({ subtotal: 50000 }))).toBe(9000);
  });
});

describe('shipping pricing — default fallback rate', () => {
  it('uses default_shipping_rate_amount when no zone/rate matches, else free', async () => {
    const { workspace, H } = await freshWorkspace();

    // nothing configured -> free
    expect(await calculateShippingAmount(workspace.id, dest({ country: 'DE', region: 'Berlin' }))).toBe(0);

    await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}`)
      .set(H)
      .send({ settings: { default_shipping_rate_amount: 3500 } })
      .expect(200);

    expect(await calculateShippingAmount(workspace.id, dest({ country: 'DE', region: 'Berlin' }))).toBe(3500);

    // an active matching zone still wins over the fallback
    const zone = await makeZone(workspace.id, { countries: ['DE'] });
    await makeFlatRate(workspace.id, zone.id, 1200);
    expect(await calculateShippingAmount(workspace.id, dest({ country: 'DE', region: 'Berlin' }))).toBe(1200);
  });
});

describe('tax — tax_enabled gate', () => {
  it('returns zero tax until tax_enabled is true, regardless of tax_rate rows', async () => {
    const { workspace, H } = await freshWorkspace();
    await db.TaxRate.create({ workspaceId: workspace.id, name: 'VAT', country: 'EG', rateBasisPoints: 1400 });
    const lines = [{ productId: null, lineTotal: 100000 }];

    expect(await calculateTax(workspace.id, { country: 'EG', region: 'Cairo', lines, shippingAmount: 0 })).toEqual({
      taxAmount: 0,
      pricesIncludeTax: false,
    });

    await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}`)
      .set(H)
      .send({ settings: { tax_enabled: true } })
      .expect(200);

    const enabled = await calculateTax(workspace.id, { country: 'EG', region: 'Cairo', lines, shippingAmount: 0 });
    expect(enabled.taxAmount).toBe(14000);
  });
});

describe('PATCH /workspaces/:id — merchant settings', () => {
  it('round-trips the three settings, merges partial patches, and clears with null', async () => {
    const { workspace, H } = await freshWorkspace();
    const url = `/api/v1/workspaces/${workspace.id}`;

    const full = await request(app)
      .patch(url)
      .set(H)
      .send({ settings: { free_shipping_threshold_amount: 20000, default_shipping_rate_amount: 4000, tax_enabled: true } });
    expect(full.status).toBe(200);
    expect(full.body.workspace.settings).toEqual({
      free_shipping_threshold_amount: 20000,
      default_shipping_rate_amount: 4000,
      tax_enabled: true,
    });

    // a themeSettings-only patch must not disturb settings
    await request(app).patch(url).set(H).send({ themeSettings: { accent: 'blue' } }).expect(200);
    let reread = await db.Workspace.findByPk(workspace.id);
    expect(reread.settings).toEqual({
      free_shipping_threshold_amount: 20000,
      default_shipping_rate_amount: 4000,
      tax_enabled: true,
    });

    // partial patch merges; null clears just that key
    const cleared = await request(app)
      .patch(url)
      .set(H)
      .send({ settings: { free_shipping_threshold_amount: null } });
    expect(cleared.body.workspace.settings).toEqual({ default_shipping_rate_amount: 4000, tax_enabled: true });

    // an audit row captures the change
    const audit = await db.AuditLog.findOne({
      where: { workspaceId: workspace.id, action: 'workspace.update' },
      order: [['createdAt', 'DESC']],
    });
    expect(audit).not.toBeNull();
    expect(audit.afterState.settings).toEqual({ default_shipping_rate_amount: 4000, tax_enabled: true });
  });

  it('rejects a negative amount', async () => {
    const { workspace, H } = await freshWorkspace();
    const res = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}`)
      .set(H)
      .send({ settings: { default_shipping_rate_amount: -1 } });
    expect(res.status).toBe(422);
  });
});

describe('shipping rate — is_active + estimated delivery via CRUD', () => {
  it('accepts and returns is_active and estimated delivery days; PATCH is a true partial update', async () => {
    const { workspace, H } = await freshWorkspace();
    const base = `/api/v1/workspaces/${workspace.id}/shipping`;

    const zone = await request(app).post(`${base}/zones`).set(H).send({ name: 'Z', countries: ['EG'] });
    expect(zone.status).toBe(201);

    const rate = await request(app)
      .post(`${base}/zones/${zone.body.zone.id}/rates`)
      .set(H)
      .send({
        name: 'Std',
        rateType: 'flat',
        config: { amount: 5000 },
        isActive: false,
        estimatedDeliveryMinDays: 2,
        estimatedDeliveryMaxDays: 5,
      });
    expect(rate.status).toBe(201);
    expect(rate.body.rate).toMatchObject({
      isActive: false,
      estimatedDeliveryMinDays: 2,
      estimatedDeliveryMaxDays: 5,
    });

    // toggling isActive must not wipe the config or the delivery estimate
    const patched = await request(app)
      .patch(`${base}/rates/${rate.body.rate.id}`)
      .set(H)
      .send({ isActive: true });
    expect(patched.status).toBe(200);
    expect(patched.body.rate.isActive).toBe(true);
    expect(patched.body.rate.config).toEqual({ amount: 5000 });
    expect(patched.body.rate.estimatedDeliveryMinDays).toBe(2);
  });

  it('deactivating a zone via PATCH does not clear its countries', async () => {
    const { workspace, H } = await freshWorkspace();
    const base = `/api/v1/workspaces/${workspace.id}/shipping`;
    const zone = await request(app).post(`${base}/zones`).set(H).send({ name: 'Z', countries: ['EG', 'SA'] });

    const patched = await request(app)
      .patch(`${base}/zones/${zone.body.zone.id}`)
      .set(H)
      .send({ isActive: false });
    expect(patched.status).toBe(200);
    expect(patched.body.zone.isActive).toBe(false);
    expect(patched.body.zone.countries).toEqual(['EG', 'SA']);
  });
});
