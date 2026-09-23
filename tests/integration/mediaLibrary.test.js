'use strict';

// The media library behind the builder's image picker: every upload is
// recorded as a media_assets row, the list pages newest-first with a cursor,
// and deleting removes both the row and (best effort) the stored object.

const fs = require('fs');
const path = require('path');
const bwipjs = require('bwip-js');
const { app, request, setupWorkspaceWithProduct, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const { UPLOAD_ROOT } = require('../../src/modules/media/mediaService');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let PNG;
beforeAll(async () => {
  PNG = await bwipjs.toBuffer({ bcid: 'code128', text: 'library-test', scale: 1, height: 6, includetext: false });
});

afterAll(() => {
  try {
    for (const entry of fs.readdirSync(UPLOAD_ROOT)) {
      if (entry === '.gitkeep') continue;
      fs.rmSync(path.join(UPLOAD_ROOT, entry), { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
});

async function setup() {
  const { auth, workspace } = await setupWorkspaceWithProduct();
  const base = `/api/v1/workspaces/${workspace.id}/media`;
  const H = bearer(auth.accessToken);
  return {
    auth,
    workspace,
    H,
    base,
    upload: () => request(app).post(base).set(H).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' }),
    list: (query = '') => request(app).get(`${base}${query}`).set(H),
    remove: (id) => request(app).delete(`${base}/${id}`).set(H),
  };
}

describe('media library', () => {
  it('records every upload and hands back its id alongside the existing fields', async () => {
    const ctx = await setup();

    const res = await ctx.upload();
    expect(res.status).toBe(201);
    // Existing response fields are unchanged.
    expect(res.body.mimeType).toBe('image/png');
    expect(res.body.size).toBe(PNG.length);
    expect(res.body.url).toContain(res.body.path);
    // ...plus the new id.
    expect(res.body.id).toEqual(expect.any(String));

    const row = await db.MediaAsset.findByPk(res.body.id);
    expect(row).not.toBeNull();
    expect(row.workspaceId).toBe(ctx.workspace.id);
    expect(row.uploadedByUserId).toBe(ctx.auth.userId);
    expect(row.path).toBe(res.body.path);
    expect(row.sizeBytes).toBe(PNG.length);
  });

  it('lists a workspace newest-first and pages with a cursor', async () => {
    const ctx = await setup();

    // Five uploads can land in the same millisecond, which would leave the
    // order decided by the uuid tie-breaker and make the assertions below
    // flaky. Pin a distinct created_at on each so "newest first" is exact.
    const uploaded = [];
    for (let i = 0; i < 5; i += 1) {
      const id = (await ctx.upload()).body.id;
      await db.MediaAsset.update(
        { createdAt: new Date(Date.now() + i * 1000) },
        { where: { id }, silent: true }
      );
      uploaded.push(id);
    }

    const all = await ctx.list();
    expect(all.status).toBe(200);
    expect(all.body.media).toHaveLength(5);
    expect(all.body.nextCursor).toBeNull();
    expect(all.body.media.map((m) => m.id)).toEqual([...uploaded].reverse());
    expect(all.body.media[0]).toEqual({
      id: expect.any(String),
      url: expect.any(String),
      mimeType: 'image/png',
      size: PNG.length,
      createdAt: expect.any(String),
    });

    const firstPage = await ctx.list('?limit=2');
    expect(firstPage.body.media).toHaveLength(2);
    expect(firstPage.body.nextCursor).toBe(firstPage.body.media[1].id);

    const secondPage = await ctx.list(`?limit=2&before=${firstPage.body.nextCursor}`);
    expect(secondPage.body.media.map((m) => m.id)).toEqual(all.body.media.slice(2, 4).map((m) => m.id));

    const lastPage = await ctx.list(`?limit=2&before=${secondPage.body.nextCursor}`);
    expect(lastPage.body.media.map((m) => m.id)).toEqual([all.body.media[4].id]);
    expect(lastPage.body.nextCursor).toBeNull();
  });

  it('caps limit at 100 and refuses a nonsense one', async () => {
    const ctx = await setup();
    expect((await ctx.list('?limit=101')).status).toBe(422);
    expect((await ctx.list('?limit=0')).status).toBe(422);
    expect((await ctx.list('?before=not-a-uuid')).status).toBe(422);
  });

  it('deletes the row, the stored file and writes an audit entry', async () => {
    const ctx = await setup();
    const uploaded = (await ctx.upload()).body;
    const onDisk = path.join(UPLOAD_ROOT, uploaded.path.replace('/uploads/', ''));
    expect(fs.existsSync(onDisk)).toBe(true);

    const res = await ctx.remove(uploaded.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });

    expect(await db.MediaAsset.findByPk(uploaded.id)).toBeNull();
    expect(fs.existsSync(onDisk)).toBe(false);

    const audit = await db.AuditLog.findOne({
      where: { entityType: 'Media', entityId: uploaded.id, action: 'media.delete' },
    });
    expect(audit).not.toBeNull();
  });

  it('still deletes the row when the stored object is already gone', async () => {
    const ctx = await setup();
    const uploaded = (await ctx.upload()).body;
    fs.rmSync(path.join(UPLOAD_ROOT, uploaded.path.replace('/uploads/', '')));

    const res = await ctx.remove(uploaded.id);
    expect(res.status).toBe(200);
    expect(await db.MediaAsset.findByPk(uploaded.id)).toBeNull();
  });

  it("never lists or deletes another workspace's media", async () => {
    const mine = await setup();
    const uploaded = (await mine.upload()).body;

    const outsider = await registerAndActivate();
    const theirWorkspace = await createWorkspace(outsider.accessToken, 'Other Co');
    const theirH = bearer(outsider.accessToken);

    const theirList = await request(app).get(`/api/v1/workspaces/${theirWorkspace.id}/media`).set(theirH);
    expect(theirList.status).toBe(200);
    expect(theirList.body.media).toHaveLength(0);

    const crossDelete = await request(app)
      .delete(`/api/v1/workspaces/${theirWorkspace.id}/media/${uploaded.id}`)
      .set(theirH);
    expect(crossDelete.status).toBe(404);
    expect(await db.MediaAsset.findByPk(uploaded.id)).not.toBeNull();
  });

  it('needs the same permission as upload', async () => {
    const ctx = await setup();
    const uploaded = (await ctx.upload()).body;

    const outsider = await registerAndActivate();
    const denied = await request(app)
      .get(`/api/v1/workspaces/${ctx.workspace.id}/media`)
      .set(bearer(outsider.accessToken));
    expect(denied.status).toBe(404); // not a member — the tenant does not resolve

    const anonymous = await request(app).delete(`/api/v1/workspaces/${ctx.workspace.id}/media/${uploaded.id}`);
    expect(anonymous.status).toBe(401);
  });
});
