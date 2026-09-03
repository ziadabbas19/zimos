'use strict';

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');

// A minimal but valid Section -> Row -> Column -> Element tree. `marker` goes
// into the single text element so tests can prove which version is live.
function tree(marker = 'Hello world') {
  return {
    version: 1,
    sections: [
      {
        id: 's1',
        type: 'section',
        settings: {},
        rows: [
          {
            id: 'r1',
            type: 'row',
            settings: {},
            columns: [
              {
                id: 'c1',
                type: 'column',
                span: 12,
                settings: {},
                elements: [{ id: 'e1', type: 'text', props: { text: marker } }],
              },
            ],
          },
        ],
      },
    ],
  };
}

const markerOf = (renderBody) => renderBody.page.tree.sections[0].rows[0].columns[0].elements[0].props.text;

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Acme Store');
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const base = `/api/v1/workspaces/${workspace.id}/websites`;
  const store = `/api/v1/store/${workspace.id}/pages`;

  const wRes = await request(app).post(base).set(H).send({ name: 'Acme Store' });
  if (wRes.status !== 201) throw new Error(`createWebsite failed: ${wRes.status} ${JSON.stringify(wRes.body)}`);
  const website = wRes.body.website;

  return {
    auth,
    workspace,
    website,
    H,
    site: `${base}/${website.id}`,
    store,
    createPage: (body) => request(app).post(`${base}/${website.id}/pages`).set(H).send(body),
    patchPage: (pageId, body) => request(app).patch(`${base}/${website.id}/pages/${pageId}`).set(H).send(body),
    publish: (note) => request(app).post(`${base}/${website.id}/publish`).set(H).send(note ? { note } : {}),
    revisions: () => request(app).get(`${base}/${website.id}/revisions`).set(H),
    rollback: (revId) => request(app).post(`${base}/${website.id}/revisions/${revId}/rollback`).set(H).send({}),
    getWebsite: () => request(app).get(`${base}/${website.id}`).set(H),
    getPage: (pageId) => request(app).get(`${base}/${website.id}/pages/${pageId}`).set(H),
    getPublic: (slug) => request(app).get(slug ? `${store}/${slug}` : store).redirects(0),
  };
}

describe('Page engine — website & page CRUD', () => {
  it('creates a draft website with an auto subdomain and a page scoped to the workspace', async () => {
    const ctx = await setup();
    expect(ctx.website.status).toBe('draft');
    expect(ctx.website.subdomain).toMatch(/^acme-store/);

    const pRes = await ctx.createPage({ path: '/', title: 'Home', draftData: tree('HELLO') });
    expect(pRes.status).toBe(201);
    expect(pRes.body.page.path).toBe('/');

    const wRes = await ctx.getWebsite();
    expect(wRes.status).toBe(200);
    expect(wRes.body.pages).toHaveLength(1);
    expect(wRes.body.pages[0].isLive).toBe(false);
    expect(wRes.body.publishedRevision).toBeNull();
  });

  it('rejects storing a page as a raw HTML string, with an actionable message', async () => {
    const ctx = await setup();
    const p = (await ctx.createPage({ path: '/', title: 'Home' })).body.page;

    const res = await ctx.patchPage(p.id, { draftData: '<section><h1>hi</h1></section>' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body.error.details)).toMatch(/raw HTML string/i);
  });

  it('rejects an unknown / raw-html element type inside an otherwise valid tree', async () => {
    const ctx = await setup();
    const p = (await ctx.createPage({ path: '/', title: 'Home' })).body.page;

    const bad = tree('x');
    bad.sections[0].rows[0].columns[0].elements[0] = { id: 'e1', type: 'html', props: { html: '<b>x</b>' } };

    const res = await ctx.patchPage(p.id, { draftData: bad });
    expect(res.status).toBe(422);
    const detailText = JSON.stringify(res.body.error.details);
    expect(detailText).toMatch(/Unknown element type/i);
    expect(detailText).toMatch(/html/i);
  });

  it("refuses another workspace's website (404, same as tenant isolation)", async () => {
    const a = await setup();
    const outsider = await registerAndActivate();
    const res = await request(app)
      .get(`/api/v1/workspaces/${a.workspace.id}/websites/${a.website.id}`)
      .set({ Authorization: `Bearer ${outsider.accessToken}` });
    expect(res.status).toBe(404);
  });
});

describe('Page engine — pre-publish validation', () => {
  it('refuses to publish an empty page tree with a specific message', async () => {
    const ctx = await setup();
    await ctx.createPage({ path: '/', title: 'Home' }); // defaults to empty tree

    const res = await ctx.publish();
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body.error.details)).toMatch(/empty page/i);
  });

  it('refuses to publish a site with no home page', async () => {
    const ctx = await setup();
    await ctx.createPage({ path: '/about', title: 'About', draftData: tree('ABOUT') });

    const res = await ctx.publish();
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/no home page/i);
  });
});

describe('Page engine — publish + public render', () => {
  it('publishes and serves the tree + non-empty OG defaults with no staff auth', async () => {
    const ctx = await setup();
    await ctx.createPage({ path: '/', title: 'Welcome', draftData: tree('LIVE HOME') });

    const pub = await ctx.publish('first publish');
    expect(pub.status).toBe(201);
    expect(pub.body.revision.revisionNumber).toBe(1);

    const res = await ctx.getPublic();
    expect(res.status).toBe(200);
    expect(markerOf(res.body)).toBe('LIVE HOME');
    expect(res.body.site.name).toBe('Acme Store');

    const og = res.body.page.og;
    expect(og.title.length).toBeGreaterThan(0);
    expect(og.description.length).toBeGreaterThan(0);
    expect(og.image.length).toBeGreaterThan(0);
    expect(og.image).toMatch(/og-default\.png$/);
    expect(og.url.length).toBeGreaterThan(0);
  });

  it('404s the public endpoint when the workspace has no published website', async () => {
    const ctx = await setup();
    await ctx.createPage({ path: '/', title: 'Home', draftData: tree('X') });
    const res = await ctx.getPublic();
    expect(res.status).toBe(404);
  });

  it('404s a page that exists but was never included in a publish; live pages are unaffected', async () => {
    const ctx = await setup();
    await ctx.createPage({ path: '/', title: 'Home', draftData: tree('HOME') });
    await ctx.publish();

    // Created after the publish -> not in the live snapshot.
    await ctx.createPage({ path: '/draft-page', title: 'Draft', draftData: tree('SECRET') });

    const miss = await ctx.getPublic('draft-page');
    expect(miss.status).toBe(404);
    expect(miss.body.error.code).toBe('NOT_FOUND');

    const home = await ctx.getPublic();
    expect(home.status).toBe(200);
    expect(markerOf(home.body)).toBe('HOME');
  });

  it('draft edits after publish never change what the public endpoint serves', async () => {
    const ctx = await setup();
    const home = (await ctx.createPage({ path: '/', title: 'Home', draftData: tree('V1') })).body.page;
    await ctx.publish();

    const edit = await ctx.patchPage(home.id, { draftData: tree('V2-DRAFT') });
    expect(edit.status).toBe(200);

    const res = await ctx.getPublic();
    expect(markerOf(res.body)).toBe('V1'); // still the published snapshot
  });
});

describe('Page engine — rollback', () => {
  it('publish -> rollback restores the earlier live state and leaves revision history intact', async () => {
    const ctx = await setup();
    const home = (await ctx.createPage({ path: '/', title: 'Home', draftData: tree('HOME V1') })).body.page;
    await ctx.publish('v1');

    // v2: add a promo page, change the home content.
    await ctx.createPage({ path: '/promo', title: 'Promo', draftData: tree('PROMO') });
    await ctx.patchPage(home.id, { draftData: tree('HOME V2') });
    const pub2 = await ctx.publish('v2');
    expect(pub2.body.revision.revisionNumber).toBe(2);

    expect((await ctx.getPublic('promo')).status).toBe(200);
    expect(markerOf((await ctx.getPublic()).body)).toBe('HOME V2');

    const revList = (await ctx.revisions()).body.revisions;
    expect(revList.map((r) => r.revisionNumber)).toEqual([2, 1]);
    const rev1 = revList.find((r) => r.revisionNumber === 1);

    const rb = await ctx.rollback(rev1.id);
    expect(rb.status).toBe(200);
    expect(rb.body.rolledBackTo.revisionNumber).toBe(1);

    // Live state is back to v1: promo gone, home content reverted.
    expect((await ctx.getPublic('promo')).status).toBe(404);
    expect(markerOf((await ctx.getPublic()).body)).toBe('HOME V1');

    // History is untouched — rollback is not a publish.
    const revList2 = (await ctx.revisions()).body.revisions;
    expect(revList2.map((r) => r.revisionNumber)).toEqual([2, 1]);

    const w = await ctx.getWebsite();
    expect(w.body.publishedRevision.revisionNumber).toBe(1);

    // Drafts are NOT touched by rollback.
    const homeAfter = await ctx.getPage(home.id);
    expect(homeAfter.body.page.draftData.sections[0].rows[0].columns[0].elements[0].props.text).toBe('HOME V2');

    // Nothing else in the workspace was disturbed.
    expect(await db.Order.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);
  });
});

describe('Page engine — slug-change redirects', () => {
  it('renaming a published page keeps the old URL working as a permanent 301', async () => {
    const ctx = await setup();
    await ctx.createPage({ path: '/', title: 'Home', draftData: tree('HOME') });
    const about = (await ctx.createPage({ path: '/about', title: 'About Us', draftData: tree('ABOUT') })).body.page;
    await ctx.publish('v1');

    expect((await ctx.getPublic('about')).status).toBe(200);

    const rename = await ctx.patchPage(about.id, { path: '/about-us' });
    expect(rename.status).toBe(200);
    expect(rename.body.page.redirectCreated.fromPath).toBe('/about');
    expect(rename.body.page.redirectCreated.toPath).toBe('/about-us');

    // Rename is a draft edit — the redirect goes live only after republish.
    await ctx.publish('v2');

    const moved = await ctx.getPublic('about');
    expect(moved.status).toBe(301);
    expect(moved.headers.location).toBe('/about-us');
    expect(moved.body.redirect.to).toBe('/about-us');

    expect((await ctx.getPublic('about-us')).status).toBe(200);
  });

  it('renaming a draft-only (never published) page creates no redirect', async () => {
    const ctx = await setup();
    const p = (await ctx.createPage({ path: '/x', title: 'X', draftData: tree('X') })).body.page;

    const res = await ctx.patchPage(p.id, { path: '/y' });
    expect(res.status).toBe(200);
    expect(res.body.page.redirectCreated).toBeNull();
    expect(await db.WebsitePageRedirect.count({ where: { websiteId: ctx.website.id } })).toBe(0);
  });
});
