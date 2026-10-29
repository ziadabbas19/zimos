'use strict';

const fs = require('fs');
const path = require('path');
const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const { pngWithAlpha } = require('../helpers/images');
const db = require('../../src/db/models');
const { UPLOAD_ROOT } = require('../../src/modules/media/mediaService');
const { keyOf } = require('../../src/modules/translations/contentTranslations');

/**
 * The store's story in pictures (page element `story_gallery`, pages/pageTree.js):
 * photos from the media library, each with an optional title and description,
 * placed on the About page. Added, reordered and removed by saving the page;
 * its words translated like every page text; refused when it carries markup,
 * a script link or too many photos; a file that is not a picture never reaches
 * the media library it takes its photos from.
 */

afterAll(() => {
  fs.rmSync(UPLOAD_ROOT, { recursive: true, force: true });
});

const gallery = (items, extra = {}) => ({ id: 'g1', type: 'story_gallery', props: { title: 'قصتنا', columns: 3, items, ...extra } });
function tree(elements) {
  return {
    version: 1,
    sections: [{ id: 's1', type: 'section', settings: {}, rows: [{ id: 'r1', type: 'row', settings: {}, columns: [{ id: 'c1', type: 'column', span: 12, settings: {}, elements }] }] }],
  };
}

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Story Store');
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const row = await db.Workspace.findByPk(workspace.id);
  await row.update({ settings: { ...(row.settings || {}), store_languages: ['en'] } });
  const base = `/api/v1/workspaces/${workspace.id}/websites`;
  const site = await request(app).post(base).set(H).send({ name: 'Story Store' });
  const websiteId = site.body.website.id;
  // A site publishes only with a home page.
  const heading = { id: 'h1', type: 'heading', props: { text: 'أهلاً' } };
  expect((await request(app).post(`${base}/${websiteId}/pages`).set(H).send({ path: '/', title: 'الرئيسية', draftData: tree([heading]) })).status).toBe(201);
  const media = async () => {
    const res = await request(app).post(`/api/v1/workspaces/${workspace.id}/media`).set(H).attach('file', await pngWithAlpha(), { filename: 'p.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    return res.body.url;
  };
  return {
    workspace,
    H,
    media,
    // The gallery after a heading: a page needs words to be published.
    create: (elements) => request(app).post(`${base}/${websiteId}/pages`).set(H).send({ path: '/about', title: 'من نحن', draftData: tree([heading, ...elements]) }),
    patch: (pageId, elements) => request(app).patch(`${base}/${websiteId}/pages/${pageId}`).set(H).send({ draftData: tree([heading, ...elements]) }),
    publish: () => request(app).post(`${base}/${websiteId}/publish`).set(H).send({}),
    live: (locale) => {
      const req = request(app).get(`/api/v1/store/${workspace.id}/pages`).query({ path: '/about' });
      return locale ? req.set('X-Store-Locale', locale) : req;
    },
  };
}

const itemsOf = (res) => res.body.page.tree.sections[0].rows[0].columns[0].elements[1].props.items;

describe('the story gallery', () => {
  it('is added, reordered and trimmed by saving the About page', async () => {
    const ctx = await setup();
    const [a, b, c] = [await ctx.media(), await ctx.media(), await ctx.media()];
    const page = await ctx.create([gallery([{ src: a, title: 'المحل', description: 'من 2010' }, { src: b, title: 'الورشة' }, { src: c }])]);
    expect(page.status).toBe(201);
    expect((await ctx.publish()).status).toBe(201);
    expect(itemsOf(await ctx.live()).map((i) => i.src)).toEqual([a, b, c]);

    // Moved: c first; removed: b.
    expect((await ctx.patch(page.body.page.id, [gallery([{ src: c }, { src: a, title: 'المحل', description: 'من 2010' }])])).status).toBe(200);
    await ctx.publish();
    expect(itemsOf(await ctx.live())).toEqual([{ src: c }, { src: a, title: 'المحل', description: 'من 2010' }]);
  });

  it("offers its title and descriptions to translate, and shows them in the shopper's language", async () => {
    const ctx = await setup();
    const a = await ctx.media();
    const page = await ctx.create([gallery([{ src: a, title: 'المحل', description: 'بدأنا من محل صغير' }])]);
    await ctx.publish();

    const offered = await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/translations/content`).query({ entityType: 'page', locale: 'en' }).set(ctx.H);
    const sources = offered.body.items.flatMap((item) => item.texts.map((t) => t.source));
    expect(sources).toEqual(expect.arrayContaining(['قصتنا', 'المحل', 'بدأنا من محل صغير']));

    const texts = { [keyOf('المحل')]: 'The shop', [keyOf('بدأنا من محل صغير')]: 'We started in a small shop' };
    expect((await request(app).put(`/api/v1/workspaces/${ctx.workspace.id}/translations/content`).set(ctx.H).send({ locale: 'en', entityType: 'page', entityId: page.body.page.id, texts })).status).toBe(200);
    expect(itemsOf(await ctx.live('en'))[0]).toEqual({ src: a, title: 'The shop', description: 'We started in a small shop' });
    expect(itemsOf(await ctx.live('ar'))[0].title).toBe('المحل');
  });

  it('refuses markup, a script link, hidden characters and more than 24 photos', async () => {
    const ctx = await setup();
    const a = await ctx.media();
    const refused = [
      gallery([{ src: a, title: '<img src=x onerror=alert(1)>' }]),
      gallery([{ src: 'javascript:alert(1)' }]),
      gallery([{ src: a, description: `abc${String.fromCharCode(0x202e)}def` }]),
      gallery(Array.from({ length: 25 }, () => ({ src: a }))),
    ];
    for (const element of refused) {
      const res = await ctx.create([element]);
      expect(res.status).toBe(422);
    }
    expect((await ctx.create([gallery(Array.from({ length: 24 }, () => ({ src: a })))])).status).toBe(201);
  });

  it('takes no file that is not a picture into the media library', async () => {
    const ctx = await setup();
    const res = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/media`)
      .set(ctx.H)
      .attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { filename: 'x.svg', contentType: 'image/svg+xml' });
    expect(res.status).toBe(415);
  });

  it('a gallery with no photos is kept as the merchant saved it (the storefront hides it)', async () => {
    const ctx = await setup();
    expect((await ctx.create([gallery([])])).status).toBe(201);
    await ctx.publish();
    expect(itemsOf(await ctx.live())).toEqual([]);
  });

  it('is written only by a teammate who may edit the website', async () => {
    const ctx = await setup();
    const { addMemberWithRole } = require('../helpers/factories');
    const member = await addMemberWithRole(ctx.H.Authorization.slice(7), ctx.workspace.id, 'order_operator', 'No Website');
    const site = await db.Website.findOne({ where: { workspaceId: ctx.workspace.id } });
    const res = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/websites/${site.id}/pages`)
      .set({ Authorization: `Bearer ${member.accessToken}` })
      .send({ path: '/about', title: 'من نحن', draftData: tree([gallery([])]) });
    expect(res.status).toBe(403);
  });
});
