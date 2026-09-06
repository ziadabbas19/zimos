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

async function makeTemplate({ name = 'Blue Minimal', category = 'general', published = true, active = true, pages, styles } = {}) {
  const template = await db.Template.create({
    name,
    category,
    thumbnailUrl: `https://media.zimos.co/templates/${name.replace(/\s+/g, '-').toLowerCase()}.png`,
    isPublished: published,
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
      templateVersionId: a.version.id,
    });
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
