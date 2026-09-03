'use strict';

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');

async function setup(name = 'API Store') {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, name);
  return { auth, workspace, wid: workspace.id, H: { Authorization: `Bearer ${auth.accessToken}` } };
}

const addProduct = (wid, H, over = {}) =>
  request(app)
    .post(`/api/v1/workspaces/${wid}/quickstart`)
    .set(H)
    .type('form')
    .send({ productName: 'Thing', price: '100.00', description: 'A thing', imageUrl: 'https://cdn.example.com/thing.jpg', ...over });

describe('storefront JSON API', () => {
  it('PATCH /quickstart/branding round-trips branding + opaque themeSettings, and GET /store/:id reads it back', async () => {
    const { wid, H } = await setup('Before');
    const theme = { templateKey: 'modern-01', primaryColor: '#ff6600', nested: { showBadges: true } };

    const patch = await request(app)
      .patch(`/api/v1/workspaces/${wid}/quickstart/branding`)
      .set(H)
      .send({ name: 'Ahmed Store', logoUrl: 'https://cdn.example.com/logo.png', tagline: 'The best', themeSettings: theme });
    expect(patch.status).toBe(200);
    expect(patch.body.workspace.name).toBe('Ahmed Store');
    expect(patch.body.workspace.logoUrl).toBe('https://cdn.example.com/logo.png');
    expect(patch.body.workspace.themeSettings).toEqual(theme);

    // stored as-is
    const ws = await db.Workspace.findByPk(wid);
    expect(ws.themeSettings).toEqual(theme);

    // public read endpoint returns everything a frontend page shell needs
    const store = await request(app).get(`/api/v1/store/${wid}`);
    expect(store.status).toBe(200);
    expect(store.body.store).toMatchObject({
      id: wid,
      name: 'Ahmed Store',
      logoUrl: 'https://cdn.example.com/logo.png',
      tagline: 'The best',
      themeSettings: theme,
      currency: 'EGP',
    });
    expect(store.body.store.slug).toBeDefined();
  });

  it('GET /store/:id works before any product exists and defaults themeSettings to {}', async () => {
    const { wid } = await setup('Fresh Co');
    const res = await request(app).get(`/api/v1/store/${wid}`);
    expect(res.status).toBe(200);
    expect(res.body.store.name).toBe('Fresh Co');
    expect(res.body.store.themeSettings).toEqual({});
    expect(res.body.store.logoUrl).toBeNull();
  });

  it('the public product-list JSON has everything to render a storefront: image, price, description', async () => {
    const { wid, H } = await setup();
    await addProduct(wid, H, { productName: 'Alpha', price: '50.00', description: 'Alpha desc' });
    await addProduct(wid, H, { productName: 'Beta', price: '75.00', description: 'Beta desc' });

    const res = await request(app).get(`/api/v1/store/${wid}/products`);
    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);
    const names = res.body.products.map((p) => p.name).sort();
    expect(names).toEqual(['Alpha', 'Beta']);

    const alpha = res.body.products.find((p) => p.name === 'Alpha');
    expect(alpha.description).toBe('Alpha desc');
    expect(alpha.media[0].url).toBe('https://cdn.example.com/thing.jpg');
    // price is available via variant and/or default offer
    const priceMinor = (alpha.offers[0] && alpha.offers[0].priceAmount) || alpha.variants[0].priceAmount;
    expect(String(priceMinor)).toBe('5000');
    expect(alpha.variants[0].currency).toBe('EGP');
    expect(alpha.variants[0].inStock).toBe(true);
  });

  it('rejects an oversized themeSettings blob', async () => {
    const { wid, H } = await setup();
    const huge = { blob: 'x'.repeat(6000) };
    const res = await request(app)
      .patch(`/api/v1/workspaces/${wid}/quickstart/branding`)
      .set(H)
      .send({ themeSettings: huge });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a themeSettings-only PATCH leaves name/logo/tagline untouched', async () => {
    const { wid, H } = await setup('Keep Me');
    await request(app).patch(`/api/v1/workspaces/${wid}/quickstart/branding`).set(H).send({ tagline: 'original' });
    await request(app)
      .patch(`/api/v1/workspaces/${wid}/quickstart/branding`)
      .set(H)
      .send({ themeSettings: { templateKey: 'classic-03' } });

    const store = await request(app).get(`/api/v1/store/${wid}`);
    expect(store.body.store.name).toBe('Keep Me');
    expect(store.body.store.tagline).toBe('original');
    expect(store.body.store.themeSettings).toEqual({ templateKey: 'classic-03' });
  });
});
