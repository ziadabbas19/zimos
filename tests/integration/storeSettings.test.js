'use strict';

// Merchant-tunable store settings that the storefront reads back:
//  - themeSettings (fontFamily / cornerRadius) survives PATCH and is served
//    by GET /store/:workspaceId,
//  - settings.checkout_settings decides which optional checkout fields the
//    form shows, and is enforced server-side for the ones marked 'required'.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let phoneSeq = 0;
const nextPhone = () => `0101${String(10000000 + (phoneSeq += 1)).slice(-8)}`;

async function setup() {
  const ctx = await setupWorkspaceWithProduct({ price: 12000, stock: 20 });
  const wid = ctx.workspace.id;
  return {
    ...ctx,
    wid,
    H: bearer(ctx.auth.accessToken),
    patch: (body) => request(app).patch(`/api/v1/workspaces/${wid}`).set(bearer(ctx.auth.accessToken)).send(body),
    storeMeta: () => request(app).get(`/api/v1/store/${wid}`),
    checkout: (body) =>
      request(app)
        .post(`/api/v1/store/${wid}/checkout`)
        .set('Idempotency-Key', `cs-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        .send(body),
  };
}

const baseOrder = (variantId, overrides = {}) => ({
  item: { variantId, quantity: 1 },
  contact: { fullName: 'Settings Shopper', phone: nextPhone() },
  ...overrides,
});

describe('themeSettings', () => {
  it('persists fontFamily and cornerRadius through PATCH and serves them to the storefront', async () => {
    const ctx = await setup();

    const res = await ctx.patch({ themeSettings: { fontFamily: 'tajawal', cornerRadius: 'round', primaryColor: '#111' } });
    expect(res.status).toBe(200);
    expect(res.body.workspace.themeSettings.fontFamily).toBe('tajawal');
    expect(res.body.workspace.themeSettings.cornerRadius).toBe('round');

    const store = await ctx.storeMeta();
    expect(store.status).toBe(200);
    expect(store.body.store.themeSettings.fontFamily).toBe('tajawal');
    expect(store.body.store.themeSettings.cornerRadius).toBe('round');
    expect(store.body.store.themeSettings.primaryColor).toBe('#111');
  });

  it('accepts every documented fontFamily / cornerRadius value', async () => {
    const ctx = await setup();
    for (const fontFamily of ['classic', 'modern', 'tajawal', 'system']) {
      for (const cornerRadius of ['sharp', 'soft', 'round']) {
        const res = await ctx.patch({ themeSettings: { fontFamily, cornerRadius } });
        expect(res.status).toBe(200);
        expect(res.body.workspace.themeSettings).toEqual({ fontFamily, cornerRadius });
      }
    }
  });

  it('refuses a themeSettings blob over the ~5KB cap', async () => {
    const ctx = await setup();
    const res = await ctx.patch({ themeSettings: { fontFamily: 'modern', blob: 'x'.repeat(6000) } });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/too large/i);
  });
});

describe('checkout_settings', () => {
  it('defaults every field to optional, so an unconfigured store behaves exactly as before', async () => {
    const ctx = await setup();

    const store = await ctx.storeMeta();
    expect(store.body.store.checkout).toEqual({ email: 'optional', postal_code: 'optional', notes: 'optional' });

    // No email, no postal code, no notes — accepted, as it always was.
    const res = await ctx.checkout(baseOrder(ctx.variant.id, { paymentMethod: 'cod' }));
    expect(res.status).toBe(201);
  });

  it('persists through PATCH and comes back on the public store meta', async () => {
    const ctx = await setup();

    const res = await ctx.patch({
      settings: { checkout_settings: { email: 'required', postal_code: 'hidden', notes: 'hidden' } },
    });
    expect(res.status).toBe(200);
    expect(res.body.workspace.settings.checkout_settings).toEqual({
      email: 'required',
      postal_code: 'hidden',
      notes: 'hidden',
    });

    const store = await ctx.storeMeta();
    expect(store.body.store.checkout).toEqual({ email: 'required', postal_code: 'hidden', notes: 'hidden' });
  });

  it('merges one switch at a time and leaves the shipping/tax settings alone', async () => {
    const ctx = await setup();

    await ctx.patch({ settings: { tax_enabled: true, free_shipping_threshold_amount: 50000 } });
    await ctx.patch({ settings: { checkout_settings: { email: 'required' } } });
    const after = await ctx.patch({ settings: { checkout_settings: { postal_code: 'required' } } });

    expect(after.body.workspace.settings).toMatchObject({
      tax_enabled: true,
      free_shipping_threshold_amount: 50000,
      checkout_settings: { email: 'required', postal_code: 'required' },
    });

    // null on a sub-key restores that one default; null on the object clears all.
    const cleared = await ctx.patch({ settings: { checkout_settings: { email: null } } });
    expect(cleared.body.workspace.settings.checkout_settings).toEqual({ postal_code: 'required' });

    const gone = await ctx.patch({ settings: { checkout_settings: null } });
    expect(gone.body.workspace.settings.checkout_settings).toBeUndefined();
    const store = await ctx.storeMeta();
    expect(store.body.store.checkout).toEqual({ email: 'optional', postal_code: 'optional', notes: 'optional' });
  });

  it('rejects a mode the contract does not define', async () => {
    const ctx = await setup();
    const bad = await ctx.patch({ settings: { checkout_settings: { email: 'mandatory' } } });
    expect(bad.status).toBe(422);

    // `notes` has no 'required' — a note nobody is shown cannot be demanded.
    const notes = await ctx.patch({ settings: { checkout_settings: { notes: 'required' } } });
    expect(notes.status).toBe(422);
  });

  it("refuses a checkout missing a field the merchant marked 'required'", async () => {
    const ctx = await setup();
    await ctx.patch({ settings: { checkout_settings: { email: 'required', postal_code: 'required' } } });

    const missing = await ctx.checkout(
      baseOrder(ctx.variant.id, {
        paymentMethod: 'cod',
        shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 A St' },
      })
    );
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('VALIDATION_ERROR');
    const fields = missing.body.error.details.map((d) => d.field);
    expect(fields).toContain('contact.email');
    expect(fields).toContain('shippingAddress.postalCode');

    const complete = await ctx.checkout({
      item: { variantId: ctx.variant.id, quantity: 1 },
      contact: { fullName: 'Complete Shopper', phone: nextPhone(), email: 'shopper@example.com' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 A St', postalCode: '11511' },
      paymentMethod: 'cod',
    });
    expect(complete.status).toBe(201);
  });

  it("treats a blank string as missing, and enforces nothing for 'hidden' or 'optional'", async () => {
    const ctx = await setup();
    await ctx.patch({ settings: { checkout_settings: { email: 'required' } } });

    const blank = await ctx.checkout(
      baseOrder(ctx.variant.id, {
        paymentMethod: 'cod',
        contact: { fullName: 'Blank Email', phone: nextPhone(), email: '' },
      })
    );
    expect(blank.status).toBe(422);

    await ctx.patch({ settings: { checkout_settings: { email: 'hidden', postal_code: 'hidden' } } });
    const hidden = await ctx.checkout(baseOrder(ctx.variant.id, { paymentMethod: 'cod' }));
    expect(hidden.status).toBe(201);
    // A hidden field that arrives anyway is still stored, not stripped.
    const withEmail = await ctx.checkout(
      baseOrder(ctx.variant.id, {
        paymentMethod: 'cod',
        contact: { fullName: 'Hidden Field', phone: nextPhone(), email: 'anyway@example.com' },
      })
    );
    expect(withEmail.status).toBe(201);
    const order = await db.Order.findByPk(withEmail.body.order.id);
    expect(order.contactSnapshot.email).toBe('anyway@example.com');
  });
});
