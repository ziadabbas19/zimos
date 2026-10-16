'use strict';

// The imported store templates ("xs" looks, pages/xsElements.js) end to end:
// the platform console adds a version made of xs_* bands, a merchant builds a
// store from it and takes its look, the editor saves a page of them, and the
// published page and the store's settings are served as they were saved.
// The template is a fixture (tests/helpers/xsTemplate.js), not a frontend file.

const { app, request, registerAndActivate, createWorkspace, setPlatformRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const { XS_ELEMENT_TYPES, xsPage, xsThemeSettings, xsTemplateVersion } = require('../helpers/xsTemplate');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

const elementTypes = (tree) => tree.sections.flatMap((s) => s.rows.flatMap((r) => r.columns.flatMap((c) => c.elements.map((e) => e.type))));
const firstElement = (tree) => tree.sections[0].rows[0].columns[0].elements[0];
const elementOfType = (tree, type) =>
  tree.sections.flatMap((s) => s.rows.flatMap((r) => r.columns.flatMap((c) => c.elements))).find((e) => e.type === type);
const unknownTypeIn = (res, type) =>
  expect(res.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining(`Unknown element type "${type}"`) })]));

/** A platform admin, as the console's Templates page is used. */
async function setupAdmin() {
  const auth = await registerAndActivate();
  await setPlatformRole(auth.userId, 'admin');
  return bearer(auth.accessToken);
}

/** The console's two steps: New template with its gallery card, then its first version. */
async function addXsTemplate(H, version = xsTemplateVersion()) {
  const created = await request(app)
    .post('/api/v1/admin/templates')
    .set(H)
    .send({ name: 'XS 01', kind: 'store', category: 'fashion', tags: ['xs'], rtl: false, primaryColor: '#717FE0' });
  expect(created.status).toBe(201);
  const added = await request(app).post(`/api/v1/admin/templates/${created.body.template.id}/versions`).set(H).send(version);
  return { template: created.body.template, added };
}

/** A merchant's store built from a template version. */
async function storeFrom(versionId) {
  const auth = await registerAndActivate();
  const ws = await createWorkspace(auth.accessToken, 'XS Store');
  const H = bearer(auth.accessToken);
  const res = await request(app).post(`/api/v1/workspaces/${ws.id}/websites`).set(H).send({ name: 'XS Store', templateVersionId: versionId });
  return { ws, H, res, base: res.body.website ? `/api/v1/workspaces/${ws.id}/websites/${res.body.website.id}` : null };
}

describe('an xs template in the platform console', () => {
  it('adds a version made of xs_* bands, stores it exactly as sent, and publishes it to the gallery', async () => {
    const H = await setupAdmin();
    const body = xsTemplateVersion();
    const { template, added } = await addXsTemplate(H, body);
    expect(added.status).toBe(201);
    expect(added.body.version).toMatchObject({ version: 1, isActive: true, pageCount: 3 });

    const one = await request(app).get(`/api/v1/admin/templates/${template.id}/versions/${added.body.version.id}`).set(H);
    expect(one.status).toBe(200);
    expect(one.body.version.pages.map((p) => p.builderData)).toEqual(body.pages.map((p) => p.builderData));
    expect(one.body.version.globalStyles).toEqual(body.globalStyles);
    expect([...new Set(elementTypes(one.body.version.pages[0].builderData))].sort()).toEqual(XS_ELEMENT_TYPES);

    await request(app).post(`/api/v1/admin/templates/${template.id}/publish`).set(H).expect(200);
    const card = (await request(app).get('/api/v1/templates')).body.templates.find((t) => t.id === template.id);
    expect(card).toMatchObject({ category: 'fashion', tags: ['xs'], rtl: false, primaryColor: '#717FE0', templateVersionId: added.body.version.id });
  });

  it('still refuses a version with an element type nobody knows, and keeps nothing of it', async () => {
    const H = await setupAdmin();
    const body = xsTemplateVersion();
    firstElement(body.pages[0].builderData).type = 'xs_bogus';
    const { template, added } = await addXsTemplate(H, body);
    expect(added.status).toBe(422);
    expect(added.body.error.code).toBe('VALIDATION_ERROR');
    unknownTypeIn(added, 'xs_bogus');
    expect(await db.TemplateVersion.count({ where: { templateId: template.id } })).toBe(0);
  });
});

describe('a store built from an xs template', () => {
  it('gets every page, band and the look as the version holds them', async () => {
    const H = await setupAdmin();
    const body = xsTemplateVersion();
    const { added } = await addXsTemplate(H, body);

    const { ws, res } = await storeFrom(added.body.version.id);
    expect(res.status).toBe(201);
    expect(res.body.website.sourceTemplateVersionId).toBe(added.body.version.id);
    expect(res.body.website.globalStyles).toEqual(body.globalStyles);
    const byPath = Object.fromEntries(res.body.pages.map((p) => [p.path, p]));
    for (const page of body.pages) {
      expect(byPath[page.path].pageType).toBe(page.pageType);
      expect(byPath[page.path].draftData).toEqual(page.builderData);
    }
    expect(await db.WebsitePage.count({ where: { websiteId: res.body.website.id, workspaceId: ws.id } })).toBe(3);
  });

  it("takes the look's shell into the store's settings, which the storefront reads back whole", async () => {
    const auth = await registerAndActivate();
    const ws = await createWorkspace(auth.accessToken, 'XS Shell');
    const themeSettings = xsThemeSettings();

    const res = await request(app).patch(`/api/v1/workspaces/${ws.id}`).set(bearer(auth.accessToken)).send({ themeSettings });
    expect(res.status).toBe(200);
    expect(res.body.workspace.themeSettings).toEqual(themeSettings);

    const meta = await request(app).get(`/api/v1/store/${ws.id}`);
    expect(meta.status).toBe(200);
    expect(meta.body.store.themeSettings).toEqual(themeSettings);
  });
});

describe('the editor saving a page of xs bands', () => {
  it('saves it as sent, refuses an unknown type without touching the saved page, and serves it once published', async () => {
    const admin = await setupAdmin();
    const { added } = await addXsTemplate(admin);
    const { ws, H, res, base } = await storeFrom(added.body.version.id);
    expect(res.status).toBe(201);
    const home = res.body.pages.find((p) => p.path === '/');

    const edited = xsPage('home', XS_ELEMENT_TYPES);
    elementOfType(edited, 'xs_slider').props.slides[0].heading = 'SUMMER';
    const saved = await request(app).patch(`${base}/pages/${home.id}`).set(H).send({ draftData: edited });
    expect(saved.status).toBe(200);
    expect((await request(app).get(`${base}/pages/${home.id}`).set(H)).body.page.draftData).toEqual(edited);

    const bad = xsPage('home', ['xs_hero']);
    firstElement(bad).type = 'xs_bogus';
    const refused = await request(app).patch(`${base}/pages/${home.id}`).set(H).send({ draftData: bad });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('VALIDATION_ERROR');
    unknownTypeIn(refused, 'xs_bogus');
    expect((await request(app).get(`${base}/pages/${home.id}`).set(H)).body.page.draftData).toEqual(edited);

    const published = await request(app).post(`${base}/publish`).set(H).send({});
    expect(published.status).toBe(201);
    const live = await request(app).get(`/api/v1/store/${ws.id}/pages`);
    expect(live.status).toBe(200);
    expect(live.body.page.tree).toEqual(edited);
  });

  it('saves a new page of xs bands too', async () => {
    const admin = await setupAdmin();
    const { added } = await addXsTemplate(admin);
    const { H, res, base } = await storeFrom(added.body.version.id);
    expect(res.status).toBe(201);

    const draftData = xsPage('services', ['xs_title', 'xs_features', 'xs_quotes']);
    const created = await request(app).post(`${base}/pages`).set(H).send({ path: '/services', title: 'Services', pageType: 'static', draftData });
    expect(created.status).toBe(201);
    expect(created.body.page.draftData).toEqual(draftData);
  });
});
