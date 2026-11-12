'use strict';

// Store fonts end to end: the public catalog, the store's fonts in
// themeSettings, and a product's own font — each takes catalog ids only, and
// a store that never picked a font is untouched.

const { app, request, registerAndActivate, createWorkspace, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Fonts Co');
  return { wid: workspace.id, H: bearer(auth.accessToken) };
}

const patchTheme = (H, wid, themeSettings) => request(app).patch(`/api/v1/workspaces/${wid}`).set(H).send({ themeSettings });

describe('GET /api/v1/fonts', () => {
  it('answers the catalog to anyone, cacheable', async () => {
    const res = await request(app).get('/api/v1/fonts');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/public/);
    expect(res.body.version).toMatch(/^[0-9a-f]{12}$/);
    expect(res.body.fonts.length).toBeGreaterThanOrEqual(80);
    expect(res.body.fonts.find((f) => f.id === 'cairo')).toMatchObject({ family: 'Cairo', script: 'both' });
  });
});

describe("PATCH /workspaces/:id — themeSettings.fonts", () => {
  it('saves catalog fonts for the store, its header and its products', async () => {
    const { wid, H } = await setup();
    const fonts = { primaryAr: 'cairo', primaryEn: 'inter', header: { ar: 'reem-kufi', en: null }, products: { en: 'lora' } };
    const res = await patchTheme(H, wid, { primaryColor: '#123456', fonts });
    expect(res.status).toBe(200);
    const saved = await db.Workspace.findByPk(wid);
    expect(saved.themeSettings.fonts).toEqual(fonts);
    expect(saved.themeSettings.primaryColor).toBe('#123456');
  });

  it('refuses a font id that is not in the catalog, or is for the other script, and saves nothing', async () => {
    const { wid, H } = await setup();
    const before = (await db.Workspace.findByPk(wid)).themeSettings;
    for (const fonts of [
      { primaryAr: 'Comic Sans MS' },
      { primaryEn: 'amiri' },
      { header: { ar: 'inter' } },
      { products: { en: 'x;}body{display:none}' } },
      { primaryAr: 'cairo', css: 'font-family:evil' },
    ]) {
      const res = await patchTheme(H, wid, { fonts });
      expect({ fonts, status: res.status }).toEqual({ fonts, status: 422 });
      expect(res.body.error.details[0].field).toMatch(/^themeSettings\.fonts/);
    }
    expect((await db.Workspace.findByPk(wid)).themeSettings).toEqual(before);
  });

  it('keeps every store without fonts saving exactly as before', async () => {
    const { wid, H } = await setup();
    const res = await patchTheme(H, wid, { primaryColor: '#abcdef', fontFamily: 'modern' });
    expect(res.status).toBe(200);
    expect((await db.Workspace.findByPk(wid)).themeSettings).toEqual({ primaryColor: '#abcdef', fontFamily: 'modern' });
    // null clears them.
    expect((await patchTheme(H, wid, { fonts: null })).status).toBe(200);
  });

  it('leaves a value saved before the check alone until it is changed', async () => {
    const { wid, H } = await setup();
    await db.Workspace.update({ themeSettings: { fonts: { primaryAr: 'retired-font' } } }, { where: { id: wid } });
    expect((await patchTheme(H, wid, { fonts: { primaryAr: 'retired-font' }, primaryColor: '#111111' })).status).toBe(200);
    expect((await patchTheme(H, wid, { fonts: { primaryAr: 'another-unknown' } })).status).toBe(422);
  });
});

describe("a product's own font (pageSettings.font)", () => {
  it('is saved from the catalog and refused otherwise', async () => {
    const { auth, workspace, product } = await setupWorkspaceWithProduct();
    const H = bearer(auth.accessToken);
    const url = `/api/v1/workspaces/${workspace.id}/catalog/products/${product.id}`;

    const ok = await request(app).patch(url).set(H).send({ pageSettings: { font: { ar: 'amiri', en: 'playfair-display' } } });
    expect(ok.status).toBe(200);
    expect((await db.Product.findByPk(product.id)).pageSettings.font).toEqual({ ar: 'amiri', en: 'playfair-display' });

    const bad = await request(app).patch(url).set(H).send({ pageSettings: { font: { ar: 'playfair-display' } } });
    expect(bad.status).toBe(422);
    expect((await db.Product.findByPk(product.id)).pageSettings.font).toEqual({ ar: 'amiri', en: 'playfair-display' });
  });
});
