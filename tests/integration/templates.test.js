'use strict';

// Ready-made website templates: the public gallery, creating a website from a
// template (deep one-time copy), and the workspace settings PATCH.

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

// A minimal but valid page tree (see src/modules/pages/pageTree.js).
const tree = (headingText) => ({
  version: 1,
  sections: [
    {
      id: 's1',
      type: 'section',
      rows: [
        {
          id: 'r1',
          type: 'row',
          columns: [
            { id: 'c1', type: 'column', span: 12, elements: [{ id: 'e1', type: 'heading', props: { text: headingText } }] },
          ],
        },
      ],
    },
  ],
});

async function makeTemplate({
  name = 'Blue Minimal',
  category = 'general',
  published = true,
  active = true,
  pages,
  styles,
  gallery = {},
} = {}) {
  const template = await db.Template.create({
    name,
    category,
    thumbnailUrl: `https://media.zimos.co/templates/${name.replace(/\s+/g, '-').toLowerCase()}.png`,
    isPublished: published,
    ...gallery,
  });
  const version = await db.TemplateVersion.create({
    templateId: template.id,
    version: 1,
    globalStyles: styles || { primaryColor: '#2563EB', fontFamily: 'Cairo' },
    pages: pages || [
      { path: '/', title: 'Home', pageType: 'home', builderData: tree('Welcome'), seo: {} },
      { path: '/about', title: 'About', builderData: tree('About us'), seo: {} },
    ],
    sections: [],
    isActive: active,
  });
  return { template, version };
}

/** A platform admin, for the /api/v1/admin/templates suites below. */
async function setupAdmin() {
  const auth = await registerAndActivate();
  await db.User.update({ platformAdmin: true }, { where: { id: auth.userId } });
  return { H: { Authorization: `Bearer ${auth.accessToken}` }, userId: auth.userId };
}

describe('GET /api/v1/templates', () => {
  it('lists only published templates that have an active version, no auth needed', async () => {
    const a = await makeTemplate({ name: 'Alpha', category: 'fashion' });
    await makeTemplate({ name: 'Draft One', published: false });
    const noVersion = await db.Template.create({ name: 'Empty', isPublished: true });

    const res = await request(app).get('/api/v1/templates');
    expect(res.status).toBe(200);

    const ids = res.body.templates.map((t) => t.id);
    expect(ids).toContain(a.template.id);
    expect(ids).not.toContain(noVersion.id); // published but no active version

    const item = res.body.templates.find((t) => t.id === a.template.id);
    expect(item).toEqual({
      id: a.template.id,
      name: 'Alpha',
      category: 'fashion',
      thumbnailUrl: a.template.thumbnailUrl,
      kind: 'store',
      priceAmount: 0,
      isFree: true,
      // no primary_color on the row — falls back to the version's styles
      primaryColor: '#2563EB',
      tags: [],
      rtl: true,
      templateVersionId: a.version.id,
    });
  });

  it('carries the gallery fields through to the card, priceAmount as a number', async () => {
    const paid = await makeTemplate({
      name: 'Paid Funnel',
      category: 'single_product',
      gallery: {
        kind: 'funnel',
        priceAmount: 49900,
        isFree: false,
        primaryColor: '#DC2626',
        tags: ['upsell', 'cod'],
        rtl: false,
      },
    });

    const res = await request(app).get('/api/v1/templates');
    const item = res.body.templates.find((t) => t.id === paid.template.id);
    expect(item).toMatchObject({
      kind: 'funnel',
      priceAmount: 49900, // BIGINT column, emitted as a number not a string
      isFree: false,
      primaryColor: '#DC2626', // the column wins over the version's styles
      tags: ['upsell', 'cod'],
      rtl: false,
    });
    expect(typeof item.priceAmount).toBe('number');

    // and the same fields are on the detail response
    const detail = await request(app).get(`/api/v1/templates/${paid.template.id}`);
    expect(detail.body.template).toMatchObject({ kind: 'funnel', priceAmount: 49900, tags: ['upsell', 'cod'] });
  });

  it('rejects a kind outside store/funnel/landing', async () => {
    await expect(makeTemplate({ name: 'Bad Kind', gallery: { kind: 'newsletter' } })).rejects.toThrow();
  });

  it('GET /api/v1/templates/:id returns the full latest-version data', async () => {
    const { template, version } = await makeTemplate({ name: 'Detailed' });

    const res = await request(app).get(`/api/v1/templates/${template.id}`);
    expect(res.status).toBe(200);
    expect(res.body.template).toMatchObject({
      id: template.id,
      name: 'Detailed',
      isPublished: true,
      templateVersionId: version.id,
      version: 1,
      globalStyles: { primaryColor: '#2563EB', fontFamily: 'Cairo' },
    });
    expect(res.body.template.pages).toHaveLength(2);
    expect(res.body.template.pages[0].builderData.sections[0].type).toBe('section');
  });

  it('404s for an unknown or unpublished template id', async () => {
    const draft = await makeTemplate({ name: 'Hidden', published: false });
    expect((await request(app).get(`/api/v1/templates/${draft.template.id}`)).status).toBe(404);
    expect((await request(app).get('/api/v1/templates/11111111-1111-4111-8111-111111111111')).status).toBe(404);
  });
});

describe('POST /websites with templateVersionId', () => {
  it('deep-copies the template pages + styles into a new website and links the source', async () => {
    const auth = await registerAndActivate();
    const ws = await createWorkspace(auth.accessToken, 'Tmpl WS');
    const { version } = await makeTemplate({ styles: { primaryColor: '#1D4ED8', mode: 'light' } });

    const res = await request(app)
      .post(`/api/v1/workspaces/${ws.id}/websites`)
      .set(bearer(auth.accessToken))
      .send({ name: 'My Store', templateVersionId: version.id });

    expect(res.status).toBe(201);
    expect(res.body.website.sourceTemplateVersionId).toBe(version.id);
    expect(res.body.website.globalStyles).toEqual({ primaryColor: '#1D4ED8', mode: 'light' });
    expect(res.body.pages).toHaveLength(2);
    const paths = res.body.pages.map((p) => p.path).sort();
    expect(paths).toEqual(['/', '/about']);
    const home = res.body.pages.find((p) => p.path === '/');
    expect(home.pageType).toBe('home');
    expect(home.draftData.sections[0].rows[0].columns[0].elements[0].props.text).toBe('Welcome');

    // real WebsitePage rows exist and are scoped to the workspace
    expect(await db.WebsitePage.count({ where: { websiteId: res.body.website.id, workspaceId: ws.id } })).toBe(2);
  });

  it("merchant's own globalStyles in the same request override the template's per key", async () => {
    const auth = await registerAndActivate();
    const ws = await createWorkspace(auth.accessToken, 'Override WS');
    const { version } = await makeTemplate({ styles: { primaryColor: '#2563EB', fontFamily: 'Cairo', mode: 'light' } });

    const res = await request(app)
      .post(`/api/v1/workspaces/${ws.id}/websites`)
      .set(bearer(auth.accessToken))
      .send({ name: 'Branded', templateVersionId: version.id, globalStyles: { primaryColor: '#ff0000' } });

    expect(res.status).toBe(201);
    // merchant's primaryColor wins; the template's other keys are kept
    expect(res.body.website.globalStyles).toEqual({ primaryColor: '#ff0000', fontFamily: 'Cairo', mode: 'light' });
  });

  it('later edits to the template version do NOT affect a website already created from it', async () => {
    const auth = await registerAndActivate();
    const ws = await createWorkspace(auth.accessToken, 'Isolation WS');
    const { version } = await makeTemplate();

    const created = await request(app)
      .post(`/api/v1/workspaces/${ws.id}/websites`)
      .set(bearer(auth.accessToken))
      .send({ name: 'Frozen Copy', templateVersionId: version.id });
    const websiteId = created.body.website.id;

    // mutate the source template version
    await version.update({
      globalStyles: { primaryColor: '#000000' },
      pages: [{ path: '/', title: 'CHANGED', builderData: tree('Totally different'), seo: {} }],
    });

    const home = await db.WebsitePage.findOne({ where: { websiteId, path: '/' } });
    expect(home.title).toBe('Home'); // not "CHANGED"
    expect(home.draftData.sections[0].rows[0].columns[0].elements[0].props.text).toBe('Welcome');
    const site = await db.Website.findByPk(websiteId);
    expect(site.globalStyles).not.toEqual({ primaryColor: '#000000' });
  });

  it('without templateVersionId the website is created empty (old behaviour)', async () => {
    const auth = await registerAndActivate();
    const ws = await createWorkspace(auth.accessToken, 'Empty WS');

    const res = await request(app)
      .post(`/api/v1/workspaces/${ws.id}/websites`)
      .set(bearer(auth.accessToken))
      .send({ name: 'Blank' });

    expect(res.status).toBe(201);
    expect(res.body.website.sourceTemplateVersionId).toBeNull();
    expect(res.body.pages).toEqual([]);
  });

  it('404s when templateVersionId is unknown or inactive', async () => {
    const auth = await registerAndActivate();
    const ws = await createWorkspace(auth.accessToken, 'Bad Tmpl WS');
    const { version } = await makeTemplate({ active: false });

    const bad = await request(app)
      .post(`/api/v1/workspaces/${ws.id}/websites`)
      .set(bearer(auth.accessToken))
      .send({ name: 'X', templateVersionId: version.id });
    expect(bad.status).toBe(404);

    expect(await db.Website.count({ where: { workspaceId: ws.id } })).toBe(0); // rolled back
  });
});

describe('PATCH /api/v1/workspaces/:workspaceId', () => {
  it('updates name / logoUrl / tagline / themeSettings and writes an audit row', async () => {
    const auth = await registerAndActivate();
    const ws = await createWorkspace(auth.accessToken, 'Old Name');

    const res = await request(app)
      .patch(`/api/v1/workspaces/${ws.id}`)
      .set(bearer(auth.accessToken))
      .send({
        name: 'New Name',
        logoUrl: 'https://media.zimos.co/logo.png',
        tagline: 'الأفضل دايمًا',
        themeSettings: { accent: 'blue', radius: 8 },
      });

    expect(res.status).toBe(200);
    expect(res.body.workspace).toMatchObject({
      name: 'New Name',
      logoUrl: 'https://media.zimos.co/logo.png',
      tagline: 'الأفضل دايمًا',
      themeSettings: { accent: 'blue', radius: 8 },
    });

    const audit = await db.AuditLog.findOne({
      where: { workspaceId: ws.id, action: 'workspace.update' },
      order: [['createdAt', 'DESC']],
    });
    expect(audit).not.toBeNull();
    expect(audit.beforeState.name).toBe('Old Name');
    expect(audit.afterState.name).toBe('New Name');
  });

  it('rejects an empty body (min 1 field)', async () => {
    const auth = await registerAndActivate();
    const ws = await createWorkspace(auth.accessToken, 'WS');
    const res = await request(app).patch(`/api/v1/workspaces/${ws.id}`).set(bearer(auth.accessToken)).send({});
    expect(res.status).toBe(422);
  });

  it('is refused across workspaces (404) and without website.edit (403)', async () => {
    const owner = await registerAndActivate({ fullName: 'Owner' });
    const ws = await createWorkspace(owner.accessToken, 'Owned');

    const stranger = await registerAndActivate({ fullName: 'Stranger' });
    await createWorkspace(stranger.accessToken, 'Other WS');
    const cross = await request(app)
      .patch(`/api/v1/workspaces/${ws.id}`)
      .set(bearer(stranger.accessToken))
      .send({ name: 'hijack' });
    expect(cross.status).toBe(404);

    // a member without website.edit (confirmation_agent) is forbidden
    const agent = await registerAndActivate({ fullName: 'Agent' });
    const agentRole = await db.Role.findOne({ where: { workspaceId: ws.id, key: 'confirmation_agent' } });
    await request(app)
      .post(`/api/v1/workspaces/${ws.id}/members`)
      .set(bearer(owner.accessToken))
      .send({ email: agent.email, roleId: agentRole.id })
      .expect(201);
    const forbidden = await request(app)
      .patch(`/api/v1/workspaces/${ws.id}`)
      .set(bearer(agent.accessToken))
      .send({ name: 'nope' });
    expect(forbidden.status).toBe(403);
  });
});

describe('GET /api/v1/templates?kind=', () => {
  beforeEach(async () => {
    await makeTemplate({ name: 'Store One', gallery: { kind: 'store' } });
    await makeTemplate({ name: 'Funnel One', gallery: { kind: 'funnel' } });
    await makeTemplate({ name: 'Landing One', gallery: { kind: 'landing' } });
  });

  const names = (res) => res.body.templates.map((t) => t.name).sort();

  it.each(['store', 'funnel', 'landing'])('narrows the grid to kind=%s', async (kind) => {
    const res = await request(app).get(`/api/v1/templates?kind=${kind}`);
    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(1);
    expect(res.body.templates[0].kind).toBe(kind);
  });

  it('returns every kind when the filter is omitted', async () => {
    const res = await request(app).get('/api/v1/templates');
    expect(names(res)).toEqual(['Funnel One', 'Landing One', 'Store One']);
  });

  it('still hides drafts and version-less templates inside a filtered kind', async () => {
    await makeTemplate({ name: 'Draft Funnel', published: false, gallery: { kind: 'funnel' } });
    await db.Template.create({ name: 'Bare Funnel', isPublished: true, kind: 'funnel' });

    const res = await request(app).get('/api/v1/templates?kind=funnel');
    expect(names(res)).toEqual(['Funnel One']);
  });

  it('422s on a kind outside the enum', async () => {
    expect((await request(app).get('/api/v1/templates?kind=newsletter')).status).toBe(422);
  });
});

describe('admin templates — authorization', () => {
  it.each([
    ['get', '/api/v1/admin/templates'],
    ['post', '/api/v1/admin/templates'],
  ])('%s %s refuses a non-admin (403) and an anonymous caller (401)', async (method, path) => {
    const plain = await registerAndActivate();
    const res = await request(app)[method](path).set(bearer(plain.accessToken)).send({ name: 'X' });
    expect(res.status).toBe(403);
    expect((await request(app)[method](path).send({ name: 'X' })).status).toBe(401);
  });

  it('refuses a non-admin on the per-row routes too', async () => {
    const { template } = await makeTemplate({ name: 'Guarded' });
    const plain = await registerAndActivate();
    const H = bearer(plain.accessToken);
    const path = `/api/v1/admin/templates/${template.id}`;

    expect((await request(app).patch(path).set(H).send({ name: 'nope' })).status).toBe(403);
    expect((await request(app).delete(path).set(H)).status).toBe(403);
    expect(await db.Template.findByPk(template.id)).not.toBeNull();
  });
});

describe('GET /api/v1/admin/templates', () => {
  it('shows what the gallery hides — drafts and templates with no version', async () => {
    const { H } = await setupAdmin();
    const live = await makeTemplate({ name: 'Live', gallery: { tags: ['hero'] } });
    const draft = await makeTemplate({ name: 'Draft', published: false });
    const bare = await db.Template.create({ name: 'Bare', isPublished: true });

    const res = await request(app).get('/api/v1/admin/templates').set(H);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.templates.map((t) => [t.id, t]));
    expect(Object.keys(byId).sort()).toEqual([live.template.id, draft.template.id, bare.id].sort());

    expect(byId[live.template.id]).toMatchObject({
      name: 'Live',
      isPublished: true,
      kind: 'store',
      priceAmount: 0,
      isFree: true,
      tags: ['hero'],
      rtl: true,
      versionCount: 1,
      activeVersion: 1,
      templateVersionId: live.version.id,
    });
    // The public card resolves primaryColor from the version's styles; the
    // editor's row must not, or a save would freeze the inherited value in.
    expect(byId[live.template.id].primaryColor).toBeNull();

    expect(byId[draft.template.id]).toMatchObject({ isPublished: false, versionCount: 1 });
    expect(byId[bare.id]).toMatchObject({ versionCount: 0, activeVersion: null, templateVersionId: null });
  });

  it('counts versions but reports only the active one as current', async () => {
    const { H } = await setupAdmin();
    const { template, version } = await makeTemplate({ name: 'Versioned' });
    await version.update({ isActive: false });
    const v2 = await db.TemplateVersion.create({
      templateId: template.id,
      version: 2,
      globalStyles: {},
      pages: [],
      sections: [],
      isActive: true,
    });

    const res = await request(app).get('/api/v1/admin/templates').set(H);
    const row = res.body.templates.find((t) => t.id === template.id);
    expect(row).toMatchObject({ versionCount: 2, activeVersion: 2, templateVersionId: v2.id });
  });

  it('filters by kind, including drafts', async () => {
    const { H } = await setupAdmin();
    await makeTemplate({ name: 'A Store', gallery: { kind: 'store' } });
    await makeTemplate({ name: 'A Draft Funnel', published: false, gallery: { kind: 'funnel' } });

    const res = await request(app).get('/api/v1/admin/templates?kind=funnel').set(H);
    expect(res.body.templates.map((t) => t.name)).toEqual(['A Draft Funnel']);
    expect((await request(app).get('/api/v1/admin/templates?kind=newsletter').set(H)).status).toBe(422);
  });
});

describe('POST /api/v1/admin/templates', () => {
  it('creates a template with the column defaults filled in', async () => {
    const { H } = await setupAdmin();

    const res = await request(app).post('/api/v1/admin/templates').set(H).send({ name: 'Fresh' });
    expect(res.status).toBe(201);
    expect(res.body.template).toMatchObject({
      name: 'Fresh',
      category: null,
      thumbnailUrl: null,
      isPublished: false,
      kind: 'store',
      priceAmount: 0,
      isFree: true,
      primaryColor: null,
      tags: [],
      rtl: true,
      versionCount: 0,
      activeVersion: null,
    });

    // It has no version, so the public gallery does not offer it.
    const gallery = await request(app).get('/api/v1/templates');
    expect(gallery.body.templates.map((t) => t.id)).not.toContain(res.body.template.id);
  });

  it('stores the full gallery card, priceAmount as a number', async () => {
    const { H } = await setupAdmin();
    const res = await request(app).post('/api/v1/admin/templates').set(H).send({
      name: 'Quick Sell Funnel',
      category: 'single_product',
      thumbnailUrl: 'https://media.zimos.co/templates/quick-sell.png',
      kind: 'funnel',
      priceAmount: 49900,
      isFree: false,
      primaryColor: '#DC2626',
      tags: ['upsell', 'cod'],
      rtl: false,
    });

    expect(res.status).toBe(201);
    expect(res.body.template).toMatchObject({
      kind: 'funnel',
      priceAmount: 49900,
      isFree: false,
      primaryColor: '#DC2626',
      tags: ['upsell', 'cod'],
      rtl: false,
    });
    expect(typeof res.body.template.priceAmount).toBe('number');

    const row = await db.Template.findByPk(res.body.template.id);
    expect(Number(row.priceAmount)).toBe(49900);
  });

  it('refuses to create a template already published — it has no version to show', async () => {
    const { H } = await setupAdmin();
    const res = await request(app)
      .post('/api/v1/admin/templates')
      .set(H)
      .send({ name: 'Premature', isPublished: true });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TEMPLATE_HAS_NO_ACTIVE_VERSION');
    expect(await db.Template.count({ where: { name: 'Premature' } })).toBe(0);
  });

  it.each([
    ['a missing name', {}],
    ['a blank name', { name: '   ' }],
    ['an unknown kind', { name: 'X', kind: 'newsletter' }],
    ['a non-hex colour', { name: 'X', primaryColor: 'crimson' }],
    ['a negative price', { name: 'X', priceAmount: -1 }],
    ['a fractional price', { name: 'X', priceAmount: 12.5 }],
  ])('422s on %s', async (_label, body) => {
    const { H } = await setupAdmin();
    expect((await request(app).post('/api/v1/admin/templates').set(H).send(body)).status).toBe(422);
  });
});

describe('PATCH /api/v1/admin/templates/:templateId', () => {
  it('is partial — flipping one switch leaves every other field alone', async () => {
    const { H } = await setupAdmin();
    const { template } = await makeTemplate({
      name: 'Keep My Fields',
      published: false,
      gallery: { kind: 'funnel', priceAmount: 19900, isFree: false, tags: ['cod'], rtl: false },
    });

    const res = await request(app)
      .patch(`/api/v1/admin/templates/${template.id}`)
      .set(H)
      .send({ isPublished: true });

    expect(res.status).toBe(200);
    expect(res.body.template).toMatchObject({
      isPublished: true,
      name: 'Keep My Fields',
      kind: 'funnel',
      priceAmount: 19900,
      isFree: false,
      tags: ['cod'], // not reset to [] by a default
      rtl: false,
    });
  });

  it('publishing makes the template appear in the public gallery', async () => {
    const { H } = await setupAdmin();
    const { template } = await makeTemplate({ name: 'Going Live', published: false });

    const before = await request(app).get('/api/v1/templates');
    expect(before.body.templates.map((t) => t.id)).not.toContain(template.id);

    await request(app).patch(`/api/v1/admin/templates/${template.id}`).set(H).send({ isPublished: true }).expect(200);

    const after = await request(app).get('/api/v1/templates');
    expect(after.body.templates.map((t) => t.id)).toContain(template.id);
  });

  it('refuses to publish a template whose only version is inactive', async () => {
    const { H } = await setupAdmin();
    const { template } = await makeTemplate({ name: 'No Active', published: false, active: false });

    const res = await request(app)
      .patch(`/api/v1/admin/templates/${template.id}`)
      .set(H)
      .send({ isPublished: true });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TEMPLATE_HAS_NO_ACTIVE_VERSION');
    expect((await db.Template.findByPk(template.id)).isPublished).toBe(false);
  });

  it('unpublishing is always allowed, version or not', async () => {
    const { H } = await setupAdmin();
    const bare = await db.Template.create({ name: 'Bare But Published', isPublished: true });

    const res = await request(app)
      .patch(`/api/v1/admin/templates/${bare.id}`)
      .set(H)
      .send({ isPublished: false });
    expect(res.status).toBe(200);
    expect(res.body.template.isPublished).toBe(false);
  });

  it('clearing primaryColor with "" stores NULL, and the card falls back to the version', async () => {
    const { H } = await setupAdmin();
    const { template } = await makeTemplate({
      name: 'Swatch',
      gallery: { primaryColor: '#DC2626' },
      styles: { primaryColor: '#2563EB' },
    });

    const res = await request(app)
      .patch(`/api/v1/admin/templates/${template.id}`)
      .set(H)
      .send({ primaryColor: '', category: '' });

    expect(res.status).toBe(200);
    expect(res.body.template.primaryColor).toBeNull();
    expect(res.body.template.category).toBeNull();
    expect((await db.Template.findByPk(template.id)).primaryColor).toBeNull();

    const gallery = await request(app).get('/api/v1/templates');
    const card = gallery.body.templates.find((t) => t.id === template.id);
    expect(card.primaryColor).toBe('#2563EB'); // back to the version's styles
  });

  it('422s on an empty body and 404s on an unknown id', async () => {
    const { H } = await setupAdmin();
    const { template } = await makeTemplate({ name: 'Patchable' });

    expect((await request(app).patch(`/api/v1/admin/templates/${template.id}`).set(H).send({})).status).toBe(422);
    const unknown = await request(app)
      .patch('/api/v1/admin/templates/11111111-1111-4111-8111-111111111111')
      .set(H)
      .send({ name: 'Ghost' });
    expect(unknown.status).toBe(404);
  });
});

describe('DELETE /api/v1/admin/templates/:templateId', () => {
  it('deletes an unused template and its versions', async () => {
    const { H } = await setupAdmin();
    const { template, version } = await makeTemplate({ name: 'Disposable' });

    expect((await request(app).delete(`/api/v1/admin/templates/${template.id}`).set(H)).status).toBe(200);
    expect(await db.Template.findByPk(template.id)).toBeNull();
    expect(await db.TemplateVersion.findByPk(version.id)).toBeNull(); // ON DELETE CASCADE
  });

  it('refuses a template a merchant site was built from', async () => {
    const { H } = await setupAdmin();
    const auth = await registerAndActivate();
    const ws = await createWorkspace(auth.accessToken, 'Built From WS');
    const { template, version } = await makeTemplate({ name: 'In Use' });

    await request(app)
      .post(`/api/v1/workspaces/${ws.id}/websites`)
      .set(bearer(auth.accessToken))
      .send({ name: 'Merchant Site', templateVersionId: version.id })
      .expect(201);

    const res = await request(app).delete(`/api/v1/admin/templates/${template.id}`).set(H);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TEMPLATE_IN_USE');
    expect(await db.Template.findByPk(template.id)).not.toBeNull();
  });

  it('404s on an unknown id', async () => {
    const { H } = await setupAdmin();
    const res = await request(app)
      .delete('/api/v1/admin/templates/11111111-1111-4111-8111-111111111111')
      .set(H);
    expect(res.status).toBe(404);
  });
});
