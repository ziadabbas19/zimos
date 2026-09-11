'use strict';

// The workspace slug is the store's public address: `<slug>.${PLATFORM_ROOT_DOMAIN}`
// today, and the `:workspaceId` of every public /store and /shop path while
// merchants move over from UUID links. These cover choosing one
// (GET /workspaces/check-slug, PATCH /workspaces/:id) and resolving one.

const { app, request, registerAndActivate, createWorkspace, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function setup(name = 'Slug Co') {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, name);
  return { auth, workspace, wid: workspace.id, H: bearer(auth.accessToken) };
}

const checkSlug = (H, slug) =>
  request(app).get('/api/v1/workspaces/check-slug').query({ slug }).set(H);

const patchSlug = (H, wid, slug) =>
  request(app).patch(`/api/v1/workspaces/${wid}`).set(H).send({ slug });

describe('GET /workspaces/check-slug', () => {
  it('reports a free, well-formed slug as available', async () => {
    const { H } = await setup();
    const res = await checkSlug(H, 'cairo-coffee');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.reason).toBeUndefined();
  });

  it('reports a slug another workspace already holds as taken', async () => {
    const { H, workspace } = await setup('Taken Store');
    const res = await checkSlug(H, workspace.slug);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: false, reason: 'taken' });
  });

  it('refuses every reserved label, so a merchant cannot shadow one of our own subdomains', async () => {
    const { H } = await setup();
    const reserved = ['www', 'api', 'admin', 'app', 'store', 'mail', 'ftp', 'cdn', 'ns1', 'ns2', 'blog', 'help', 'support', 'status', 'staging', 'dev', 'test'];

    for (const slug of reserved) {
      const res = await checkSlug(H, slug);
      expect(res.status).toBe(200);
      expect({ slug, ...res.body }).toMatchObject({ slug, available: false, reason: 'reserved' });
    }
  });

  it('reads a reserved label case-insensitively, the way a hostname would', async () => {
    const { H } = await setup();
    expect((await checkSlug(H, 'WWW')).body).toMatchObject({ available: false, reason: 'reserved' });
  });

  it('explains why a badly-shaped slug cannot be used', async () => {
    const { H } = await setup();
    const cases = [
      ['ab', 'too_short'],
      ['a'.repeat(64), 'too_long'],
      ['-leading', 'invalid_format'],
      ['trailing-', 'invalid_format'],
      ['under_score', 'invalid_format'],
      ['has space', 'invalid_format'],
      ['emoji-🎉', 'invalid_format'],
    ];

    for (const [slug, reason] of cases) {
      const res = await checkSlug(H, slug);
      expect(res.status).toBe(200);
      expect({ slug, ...res.body }).toMatchObject({ slug, available: false, reason });
    }
  });

  it('requires the slug query parameter, and authentication', async () => {
    const { H } = await setup();
    expect((await request(app).get('/api/v1/workspaces/check-slug').set(H)).status).toBe(422);
    expect((await request(app).get('/api/v1/workspaces/check-slug').query({ slug: 'anything' })).status).toBe(401);
  });
});

describe('PATCH /workspaces/:workspaceId — slug', () => {
  it('changes the slug and persists it', async () => {
    const { H, wid } = await setup();
    const res = await patchSlug(H, wid, 'ahmed-emporium');

    expect(res.status).toBe(200);
    expect(res.body.workspace.slug).toBe('ahmed-emporium');
    expect((await db.Workspace.findByPk(wid)).slug).toBe('ahmed-emporium');
  });

  it('normalises case and surrounding space rather than rejecting them', async () => {
    const { H, wid } = await setup();
    const res = await patchSlug(H, wid, '  Ahmed-Emporium  ');
    expect(res.status).toBe(200);
    expect(res.body.workspace.slug).toBe('ahmed-emporium');
  });

  it('returns 409 when another workspace already holds the slug', async () => {
    const first = await setup('First Store');
    const second = await setup('Second Store');

    const res = await patchSlug(second.H, second.wid, first.workspace.slug);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLUG_TAKEN');

    // the loser keeps its own slug
    expect((await db.Workspace.findByPk(second.wid)).slug).toBe(second.workspace.slug);
  });

  it('accepts a no-op re-submit of the workspace\'s current slug', async () => {
    const { H, wid, workspace } = await setup();
    const res = await patchSlug(H, wid, workspace.slug);
    expect(res.status).toBe(200);
    expect(res.body.workspace.slug).toBe(workspace.slug);
  });

  it('returns 422 for a reserved or malformed slug', async () => {
    const { H, wid } = await setup();

    for (const bad of ['www', 'admin', 'ab', 'a'.repeat(64), '-leading', 'trailing-', 'under_score', 'has space']) {
      const res = await patchSlug(H, wid, bad);
      expect({ bad, status: res.status }).toEqual({ bad, status: 422 });
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('leaves the rest of the workspace untouched when only the slug changes', async () => {
    const { H, wid } = await setup('Keep My Name');
    await request(app).patch(`/api/v1/workspaces/${wid}`).set(H).send({ tagline: 'original' });
    await patchSlug(H, wid, 'renamed-address');

    const ws = await db.Workspace.findByPk(wid);
    expect(ws.name).toBe('Keep My Name');
    expect(ws.tagline).toBe('original');
  });

  it('refuses a member who may edit the site but does not manage the workspace', async () => {
    const { H, wid } = await setup();
    const editor = await registerAndActivate();
    const role = await db.Role.findOne({ where: { workspaceId: wid, key: 'editor' } });

    const invite = await request(app)
      .post(`/api/v1/workspaces/${wid}/members`)
      .set(H)
      .send({ email: editor.email, roleId: role.id });
    expect(invite.status).toBe(201);

    const res = await patchSlug(bearer(editor.accessToken), wid, 'editor-picked-this');
    expect(res.status).toBe(403);
    expect((await db.Workspace.findByPk(wid)).slug).not.toBe('editor-picked-this');
  });
});

describe('public storefront resolves a workspace by slug or by UUID', () => {
  it('GET /store/:ref returns the same store for the slug and the UUID', async () => {
    const { wid, workspace } = await setup('Dual Lookup Co');

    const bySlug = await request(app).get(`/api/v1/store/${workspace.slug}`);
    const byId = await request(app).get(`/api/v1/store/${wid}`);

    expect(bySlug.status).toBe(200);
    expect(byId.status).toBe(200);
    expect(bySlug.body.store.id).toBe(wid);
    expect(bySlug.body).toEqual(byId.body);
  });

  it('lists products and fetches one by slug under a slug-addressed store', async () => {
    const { workspace, product } = await setupWorkspaceWithProduct();

    const list = await request(app).get(`/api/v1/store/${workspace.slug}/products`);
    expect(list.status).toBe(200);
    expect(list.body.products).toHaveLength(1);

    const one = await request(app).get(`/api/v1/store/${workspace.slug}/products/${product.slug}`);
    expect(one.status).toBe(200);
    expect(one.body.product.id).toBe(product.id);
  });

  it('serves the published page API under a slug, not only a UUID', async () => {
    const { wid, H, workspace } = await setup('Page Slug Co');
    await request(app)
      .post(`/api/v1/workspaces/${wid}/quickstart`)
      .set(H)
      .type('form')
      .send({ productName: 'Widget', price: '10.00' });

    const bySlug = await request(app).get(`/api/v1/store/${workspace.slug}/pages`);
    const byId = await request(app).get(`/api/v1/store/${wid}/pages`);

    expect(byId.status).toBe(200);
    expect(bySlug.status).toBe(200);
    expect(bySlug.body).toEqual(byId.body);
  });

  it('renders the HTML storefront under a slug', async () => {
    const { wid, H, workspace } = await setup('Html Slug Co');
    await request(app)
      .post(`/api/v1/workspaces/${wid}/quickstart`)
      .set(H)
      .type('form')
      .send({ productName: 'Slug Widget', price: '25.00' });

    const res = await request(app).get(`/shop/${workspace.slug}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Html Slug Co');
    expect(res.text).toContain('Slug Widget');
  });

  it('resolves a slug typed in the wrong case', async () => {
    const { wid, workspace } = await setup('Case Co');
    const res = await request(app).get(`/api/v1/store/${workspace.slug.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(res.body.store.id).toBe(wid);
  });

  it('404s an unknown slug instead of leaking anything', async () => {
    await setup();
    const res = await request(app).get('/api/v1/store/no-such-store-here');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('stops answering on the old slug once it is changed', async () => {
    const { H, wid, workspace } = await setup('Moving Co');
    expect((await request(app).get(`/api/v1/store/${workspace.slug}`)).status).toBe(200);

    expect((await patchSlug(H, wid, 'moved-elsewhere')).status).toBe(200);

    expect((await request(app).get(`/api/v1/store/${workspace.slug}`)).status).toBe(404);
    expect((await request(app).get('/api/v1/store/moved-elsewhere')).status).toBe(200);
    // the UUID keeps working throughout the move
    expect((await request(app).get(`/api/v1/store/${wid}`)).status).toBe(200);
  });

  it('frees the old slug for another workspace to take', async () => {
    const mover = await setup('Mover Co');
    const taker = await setup('Taker Co');
    const freed = mover.workspace.slug;

    expect((await patchSlug(mover.H, mover.wid, 'mover-new-address')).status).toBe(200);
    expect((await checkSlug(taker.H, freed)).body.available).toBe(true);
    expect((await patchSlug(taker.H, taker.wid, freed)).status).toBe(200);

    const res = await request(app).get(`/api/v1/store/${freed}`);
    expect(res.body.store.id).toBe(taker.wid);
  });
});

describe('auto-generated slugs are usable as subdomains', () => {
  it('gives a store whose name has no latin characters a valid slug', async () => {
    const auth = await registerAndActivate();
    const workspace = await createWorkspace(auth.accessToken, 'متجر أحمد');

    expect(workspace.slug).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    expect(workspace.slug.length).toBeGreaterThanOrEqual(3);
    expect((await request(app).get(`/api/v1/store/${workspace.slug}`)).status).toBe(200);
  });

  it('never hands out a reserved label to a store named after one', async () => {
    const auth = await registerAndActivate();
    const workspace = await createWorkspace(auth.accessToken, 'API');

    expect(workspace.slug).not.toBe('api');
    expect(workspace.slug).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  });

  it('keeps an over-long store name within the 63-character DNS label limit', async () => {
    const auth = await registerAndActivate();
    const workspace = await createWorkspace(auth.accessToken, 'The Really Very Extremely Long Store Name '.repeat(4));

    expect(workspace.slug.length).toBeLessThanOrEqual(63);
    expect(workspace.slug).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  });
});
