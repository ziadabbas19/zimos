'use strict';

// The motion section types added to the page engine (shader_hero, product_3d,
// orbit_gallery, scroll_story, marquee, comparison): they save, they publish,
// they survive into the public render with their section-level settings, and
// the "structured props, never markup" guarantees still hold — unknown types
// are refused and no href/src prop may carry a javascript: URL.

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');

const NEW_TYPES = ['shader_hero', 'product_3d', 'orbit_gallery', 'scroll_story', 'marquee', 'comparison'];

const PROPS = {
  shader_hero: { title: 'Built to move', subtitle: 'A hero that reacts', ctaLabel: 'Shop', ctaHref: '/products', height: 'large' },
  product_3d: { title: 'Spin it', productId: '11111111-1111-1111-1111-111111111111', modelUrl: 'https://cdn.example.com/m.glb' },
  orbit_gallery: { title: 'In orbit', limit: 8, collectionId: '22222222-2222-2222-2222-222222222222' },
  scroll_story: {
    title: 'How it is made',
    steps: [
      { title: 'Sourced', body: 'Picked by hand.', image: 'https://cdn.example.com/1.jpg' },
      { title: 'Shipped', body: 'To your door.', image: '/uploads/2.jpg' },
    ],
  },
  marquee: { items: ['Free delivery', 'Made locally', '30-day returns'], speed: 'slow', tone: 'primary' },
  comparison: {
    title: 'Why us',
    usLabel: 'Zimos',
    themLabel: 'The rest',
    rows: [
      { label: 'Setup time', us: '5 minutes', them: 'A week' },
      { label: 'COD built in', us: true, them: false },
    ],
  },
};

const SECTION_SETTINGS = { background: 'primary-soft', padding: 'roomy', width: 'wide' };

/** One section per element type, each carrying section-level settings. */
function motionTree() {
  return {
    version: 1,
    sections: NEW_TYPES.map((type, i) => ({
      id: `s${i}`,
      type: 'section',
      settings: SECTION_SETTINGS,
      rows: [
        {
          id: `r${i}`,
          type: 'row',
          columns: [
            { id: `c${i}`, type: 'column', span: 12, elements: [{ id: `e${i}`, type, props: PROPS[type] }] },
          ],
        },
      ],
    })),
  };
}

/** A minimal one-element tree, for the negative cases. */
function treeWith(element, settings) {
  return {
    version: 1,
    sections: [
      {
        id: 's1',
        type: 'section',
        ...(settings ? { settings } : {}),
        rows: [{ id: 'r1', type: 'row', columns: [{ id: 'c1', type: 'column', span: 12, elements: [element] }] }],
      },
    ],
  };
}

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Motion Store');
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const base = `/api/v1/workspaces/${workspace.id}/websites`;
  const store = `/api/v1/store/${workspace.id}/pages`;

  const wRes = await request(app).post(base).set(H).send({ name: 'Motion Store' });
  if (wRes.status !== 201) throw new Error(`createWebsite failed: ${wRes.status} ${JSON.stringify(wRes.body)}`);
  const website = wRes.body.website;

  return {
    auth,
    workspace,
    website,
    H,
    createPage: (body) => request(app).post(`${base}/${website.id}/pages`).set(H).send(body),
    patchPage: (pageId, body) => request(app).patch(`${base}/${website.id}/pages/${pageId}`).set(H).send(body),
    publish: () => request(app).post(`${base}/${website.id}/publish`).set(H).send({}),
    getPublic: () => request(app).get(store).redirects(0),
  };
}

describe('page engine — motion section types', () => {
  it('saves and publishes a page built from every new section type, settings and all', async () => {
    const ctx = await setup();
    const created = await ctx.createPage({ path: '/', title: 'Home', draftData: motionTree() });
    expect(created.status).toBe(201);

    const published = await ctx.publish();
    expect(published.status).toBe(201);

    const live = await ctx.getPublic();
    expect(live.status).toBe(200);

    const sections = live.body.page.tree.sections;
    expect(sections.map((s) => s.rows[0].columns[0].elements[0].type)).toEqual(NEW_TYPES);

    // Props survive the round trip untouched.
    const byType = Object.fromEntries(
      sections.map((s) => {
        const el = s.rows[0].columns[0].elements[0];
        return [el.type, el.props];
      })
    );
    for (const type of NEW_TYPES) expect(byType[type]).toEqual(PROPS[type]);
  });

  it('round-trips section-level settings through draft, publish and the public render', async () => {
    const ctx = await setup();
    const page = (await ctx.createPage({ path: '/', title: 'Home', draftData: motionTree() })).body.page;

    const draft = await request(app)
      .get(`/api/v1/workspaces/${ctx.workspace.id}/websites/${ctx.website.id}/pages/${page.id}`)
      .set(ctx.H);
    expect(draft.body.page.draftData.sections[0].settings).toEqual(SECTION_SETTINGS);

    expect((await ctx.publish()).status).toBe(201);

    const live = await ctx.getPublic();
    expect(live.body.page.tree.sections[0].settings).toEqual(SECTION_SETTINGS);
    for (const section of live.body.page.tree.sections) {
      expect(section.settings).toEqual(SECTION_SETTINGS);
    }
  });

  it('still rejects an unknown element type', async () => {
    const ctx = await setup();
    const page = (await ctx.createPage({ path: '/', title: 'Home' })).body.page;

    const res = await ctx.patchPage(page.id, {
      draftData: treeWith({ id: 'e1', type: 'shader_heroo', props: {} }),
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/Unknown element type/i);
  });

  it('refuses a javascript: URL in any href/src prop of the new types', async () => {
    const ctx = await setup();
    const page = (await ctx.createPage({ path: '/', title: 'Home' })).body.page;

    const cases = [
      [{ id: 'e1', type: 'shader_hero', props: { ctaHref: 'javascript:alert(1)' } }, /ctaHref/],
      [{ id: 'e1', type: 'product_3d', props: { modelUrl: 'data:text/html;base64,PHN2Zz4=' } }, /modelUrl/],
      [
        { id: 'e1', type: 'scroll_story', props: { steps: [{ title: 'a', body: 'b', image: 'JaVaScRiPt:alert(1)' }] } },
        /image/,
      ],
    ];

    for (const [element, field] of cases) {
      const res = await ctx.patchPage(page.id, { draftData: treeWith(element) });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body.error.details)).toMatch(field);
    }

    // Same-site paths, anchors and https URLs are fine.
    const ok = await ctx.patchPage(page.id, {
      draftData: treeWith({ id: 'e1', type: 'shader_hero', props: { ctaHref: '/collections/new' } }),
    });
    expect(ok.status).toBe(200);
  });

  it('polices the shape and size of the new props without demanding any of them', async () => {
    const ctx = await setup();
    const page = (await ctx.createPage({ path: '/', title: 'Home' })).body.page;

    // A half-filled section the builder autosaved is valid.
    const partial = await ctx.patchPage(page.id, {
      draftData: treeWith({ id: 'e1', type: 'marquee', props: { items: ['one'] } }),
    });
    expect(partial.status).toBe(200);

    const tooMany = await ctx.patchPage(page.id, {
      draftData: treeWith({
        id: 'e1',
        type: 'marquee',
        props: { items: Array.from({ length: 31 }, (_, i) => `item ${i}`), speed: 'warp' },
      }),
    });
    expect(tooMany.status).toBe(422);
    const details = JSON.stringify(tooMany.body.error.details);
    expect(details).toMatch(/at most 30 items/);
    expect(details).toMatch(/slow, normal, fast/);

    const tooManySteps = await ctx.patchPage(page.id, {
      draftData: treeWith({
        id: 'e1',
        type: 'scroll_story',
        props: { steps: Array.from({ length: 13 }, (_, i) => ({ title: `s${i}`, body: 'b' })) },
      }),
    });
    expect(tooManySteps.status).toBe(422);
    expect(JSON.stringify(tooManySteps.body.error.details)).toMatch(/at most 12 items/);

    const tooManyRows = await ctx.patchPage(page.id, {
      draftData: treeWith({
        id: 'e1',
        type: 'comparison',
        props: { rows: Array.from({ length: 21 }, (_, i) => ({ label: `r${i}`, us: true, them: false })) },
      }),
    });
    expect(tooManyRows.status).toBe(422);
    expect(JSON.stringify(tooManyRows.body.error.details)).toMatch(/at most 20 items/);
  });
});

describe('funnel steps use the same page validator', () => {
  async function funnelCtx() {
    const auth = await registerAndActivate();
    const workspace = await createWorkspace(auth.accessToken, 'Motion Funnels');
    const H = { Authorization: `Bearer ${auth.accessToken}` };
    const base = `/api/v1/workspaces/${workspace.id}/funnels`;
    return {
      workspace,
      H,
      createFunnel: (body) => request(app).post(base).set(H).send(body),
      createStep: (id, body) => request(app).post(`${base}/${id}/steps`).set(H).send(body),
      createEdge: (id, body) => request(app).post(`${base}/${id}/edges`).set(H).send(body),
      publish: (id) => request(app).post(`${base}/${id}/publish`).set(H).send({}),
      startSession: (id, body) => request(app).post(`/api/v1/store/${workspace.id}/funnels/${id}/sessions`).send(body),
    };
  }

  it('accepts the new section types in a funnel step and serves them to the runtime', async () => {
    const ctx = await funnelCtx();
    const funnel = (await ctx.createFunnel({ name: 'Motion Funnel' })).body.funnel;

    const landing = await ctx.createStep(funnel.id, {
      key: 'landing',
      stepType: 'landing',
      name: 'Landing',
      builderData: motionTree(),
    });
    expect(landing.status).toBe(201);

    await ctx.createStep(funnel.id, {
      key: 'thanks',
      stepType: 'thank_you',
      name: 'Thanks',
      builderData: treeWith({ id: 'e1', type: 'text', props: { text: 'done' } }),
    });
    await ctx.createEdge(funnel.id, { fromStepKey: 'landing', toStepKey: 'thanks', condition: { type: 'always' } });
    expect((await ctx.publish(funnel.id)).status).toBe(201);

    const start = await ctx.startSession(funnel.id, { visitorId: 'motion-1' });
    expect(start.status).toBe(201);
    const elements = start.body.step.tree.sections.map((s) => s.rows[0].columns[0].elements[0].type);
    expect(elements).toEqual(NEW_TYPES);
    expect(start.body.step.tree.sections[0].settings).toEqual(SECTION_SETTINGS);
  });

  it('refuses an unsafe URL in a funnel step too', async () => {
    const ctx = await funnelCtx();
    const funnel = (await ctx.createFunnel({ name: 'Unsafe Funnel' })).body.funnel;

    const res = await ctx.createStep(funnel.id, {
      key: 'landing',
      stepType: 'landing',
      name: 'Landing',
      builderData: treeWith({ id: 'e1', type: 'shader_hero', props: { ctaHref: 'javascript:alert(1)' } }),
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error.details)).toMatch(/ctaHref/);
  });
});

describe('template page trees go through the same validator', () => {
  it('copies a template built from the new types into a website', async () => {
    const auth = await registerAndActivate();
    const workspace = await createWorkspace(auth.accessToken, 'Template Store');
    const H = { Authorization: `Bearer ${auth.accessToken}` };

    const template = await db.Template.create({ name: 'Motion Template', isPublished: true });
    const version = await db.TemplateVersion.create({
      templateId: template.id,
      version: 1,
      globalStyles: {},
      pages: [{ path: '/', title: 'Home', pageType: 'home', builderData: motionTree() }],
      sections: [],
      isActive: true,
    });

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/websites`)
      .set(H)
      .send({ name: 'From Template', templateVersionId: version.id });
    expect(res.status).toBe(201);

    const pages = await db.WebsitePage.findAll({ where: { websiteId: res.body.website.id } });
    expect(pages).toHaveLength(1);
    const types = pages[0].draftData.sections.map((s) => s.rows[0].columns[0].elements[0].type);
    expect(types).toEqual(NEW_TYPES);
    expect(pages[0].draftData.sections[0].settings).toEqual(SECTION_SETTINGS);
  });
});
