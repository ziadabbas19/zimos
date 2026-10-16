'use strict';

const { app, request, registerAndActivate, createWorkspace, createProductWithVariant } = require('../helpers/factories');
const db = require('../../src/db/models');
const { keyOf } = require('../../src/modules/translations/contentTranslations');

/**
 * The store's default language for shoppers (themeSettings.shopperDisplay.locale,
 * the dashboard's Languages tab): a shopper who hasn't picked a language
 * (no X-Store-Locale) reads the store's products, collections and pages in it,
 * where the store has them translated. The shopper's own pick still wins, and
 * a store that never chose reads exactly as before.
 */

function tree(text) {
  return {
    version: 1,
    sections: [
      {
        id: 's1',
        type: 'section',
        settings: {},
        rows: [{ id: 'r1', type: 'row', settings: {}, columns: [{ id: 'c1', type: 'column', span: 12, settings: {}, elements: [{ id: 'e1', type: 'text', props: { text } }] }] }],
      },
    ],
  };
}

const textOf = (body) => body.page.tree.sections[0].rows[0].columns[0].elements[0].props.text;

/** An Arabic store offering English, with one product and a published home page, each translated. */
async function setup(themeSettings) {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Nile Store');
  const H = { Authorization: `Bearer ${auth.accessToken}` };

  const row = await db.Workspace.findByPk(workspace.id);
  await row.update({ settings: { ...(row.settings || {}), store_languages: ['en'] } });
  if (themeSettings) {
    // Through the dashboard's own save, so the setting is proven to survive the validation.
    const saved = await request(app).patch(`/api/v1/workspaces/${workspace.id}`).set(H).send({ themeSettings });
    expect(saved.status).toBe(200);
    expect(saved.body.workspace.themeSettings).toEqual(themeSettings);
  }

  const { product } = await createProductWithVariant(auth.accessToken, workspace.id);
  await db.Translation.create({ workspaceId: workspace.id, entityType: 'product', entityId: product.id, locale: 'en', field: 'name', value: 'Blue Shirt' });

  const base = `/api/v1/workspaces/${workspace.id}/websites`;
  const site = await request(app).post(base).set(H).send({ name: 'Nile Store' });
  expect(site.status).toBe(201);
  const page = await request(app).post(`${base}/${site.body.website.id}/pages`).set(H).send({ path: '/', title: 'الرئيسية', draftData: tree('أهلاً بيك') });
  expect(page.status).toBe(201);
  expect((await request(app).post(`${base}/${site.body.website.id}/publish`).set(H).send({})).status).toBe(201);
  await db.Translation.create({ workspaceId: workspace.id, entityType: 'page', entityId: page.body.page.id, locale: 'en', field: keyOf('أهلاً بيك'), value: 'Welcome' });

  const product$ = (locale) => {
    const req = request(app).get(`/api/v1/store/${workspace.id}/products/${product.id}`);
    return locale ? req.set('X-Store-Locale', locale) : req;
  };
  const home = (locale) => {
    const req = request(app).get(`/api/v1/store/${workspace.id}/pages`);
    return locale ? req.set('X-Store-Locale', locale) : req;
  };
  return { product: product$, home };
}

describe("the store's default language for shoppers", () => {
  it('answers a shopper who has not picked a language in the store default', async () => {
    const store = await setup({ shopperDisplay: { locale: 'en', localeSwitch: true } });

    const product = await store.product();
    expect(product.status).toBe(200);
    expect(product.body.product.name).toBe('Blue Shirt');
    const home = await store.home();
    expect(home.status).toBe(200);
    expect(textOf(home.body)).toBe('Welcome');
  });

  it("lets the shopper's own pick win over it", async () => {
    const store = await setup({ shopperDisplay: { locale: 'en' } });

    expect((await store.product('ar')).body.product.name).toBe('Test Product');
    expect(textOf((await store.home('ar')).body)).toBe('أهلاً بيك');
    expect((await store.product('en')).body.product.name).toBe('Blue Shirt');
  });

  it('reads as before for a store that never chose, or chose its own language', async () => {
    const never = await setup();
    expect((await never.product()).body.product.name).toBe('Test Product');
    expect(textOf((await never.home()).body)).toBe('أهلاً بيك');
    // The translations are there: asking for them still works.
    expect((await never.product('en')).body.product.name).toBe('Blue Shirt');

    const arabic = await setup({ shopperDisplay: { locale: 'ar' } });
    expect((await arabic.product()).body.product.name).toBe('Test Product');
    expect(textOf((await arabic.home()).body)).toBe('أهلاً بيك');
  });

  it('ignores a default the store does not offer, or one that is not a language', async () => {
    const french = await setup({ shopperDisplay: { locale: 'fr' } });
    expect((await french.product()).body.product.name).toBe('Test Product');

    const junk = await setup({ shopperDisplay: { locale: 42 } });
    expect((await junk.product()).body.product.name).toBe('Test Product');
    expect(textOf((await junk.home()).body)).toBe('أهلاً بيك');
  });
});
