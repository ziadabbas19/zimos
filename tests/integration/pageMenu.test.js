'use strict';

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const { publicNavPages } = require('../../src/modules/pages/pageFlags');

const tree = () => ({
  version: 1,
  sections: [
    {
      id: 's1',
      type: 'section',
      rows: [{ id: 'r1', type: 'row', columns: [{ id: 'c1', type: 'column', span: 12, elements: [{ id: 'e1', type: 'text', props: { text: 'Hello' } }] }] }],
    },
  ],
});

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Menu Store');
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const base = `/api/v1/workspaces/${workspace.id}/websites`;
  const created = await request(app).post(base).set(H).send({ name: 'Site' });
  const website = created.body.website;
  const pages = `${base}/${website.id}/pages`;
  await request(app).post(pages).set(H).send({ path: '/', title: 'Home', pageType: 'home', draftData: tree() });
  return {
    workspace,
    website,
    createPage: (body) => request(app).post(pages).set(H).send(body),
    patchPage: (id, body) => request(app).patch(`${pages}/${id}`).set(H).send(body),
    publish: () => request(app).post(`${base}/${website.id}/publish`).set(H).send({}),
  };
}

describe("the store's menu pages", () => {
  it('keeps the order the merchant chose, with unordered pages after them by address', async () => {
    const ctx = await setup();
    const make = async (path) => (await ctx.createPage({ path, title: path, draftData: tree(), showInHeader: true })).body.page;
    const about = await make('/about');
    const contact = await make('/contact');
    const faq = await make('/faq');
    await make('/zebra');
    expect((await ctx.publish()).status).toBeLessThan(300);

    expect((await publicNavPages(ctx.workspace.id)).map((p) => p.path)).toEqual(['/about', '/contact', '/faq', '/zebra']);

    for (const [page, menuOrder] of [[faq, 0], [about, 1], [contact, 2]]) {
      const res = await ctx.patchPage(page.id, { menuOrder });
      expect(res.status).toBe(200);
      expect(res.body.page.menuOrder).toBe(menuOrder);
    }
    expect((await publicNavPages(ctx.workspace.id)).map((p) => p.path)).toEqual(['/faq', '/about', '/contact', '/zebra']);
  });

  it('takes a page out of the menu with its switch', async () => {
    const ctx = await setup();
    const page = (await ctx.createPage({ path: '/about', title: 'About', draftData: tree(), showInHeader: true })).body.page;
    await ctx.publish();
    expect((await publicNavPages(ctx.workspace.id)).map((p) => p.path)).toEqual(['/about']);
    await ctx.patchPage(page.id, { showInHeader: false });
    expect(await publicNavPages(ctx.workspace.id)).toEqual([]);
  });

  it.each([[-1], [1.5], ['first'], [100001]])('refuses %j as a place in the menu', async (menuOrder) => {
    const ctx = await setup();
    const page = (await ctx.createPage({ path: '/about', title: 'About', draftData: tree() })).body.page;
    expect((await ctx.patchPage(page.id, { menuOrder })).status).toBe(422);
  });

  it.each(['account', 'search', 'blog', 'compare', 'gift-card', 'login', 'register', 'unsubscribe'])('keeps /%s for the store itself', async (segment) => {
    const ctx = await setup();
    const res = await ctx.createPage({ path: `/${segment}`, title: 'Shadowed', draftData: tree() });
    expect([res.status, res.body.error.code]).toEqual([422, 'PAGE_PATH_RESERVED']);
    expect(await db.WebsitePage.count({ where: { websiteId: ctx.website.id, path: `/${segment}` } })).toBe(0);
  });

  it('sends the old address of a published page to its new one', async () => {
    const ctx = await setup();
    const page = (await ctx.createPage({ path: '/about', title: 'About', draftData: tree() })).body.page;
    await ctx.publish();
    const res = await ctx.patchPage(page.id, { path: '/about-us' });
    expect(res.body.page.redirectCreated).toMatchObject({ fromPath: '/about', toPath: '/about-us', statusCode: 301 });
  });
});
