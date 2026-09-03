'use strict';

// Image upload to local disk. Type is decided by file content, not extension;
// anything over 5MB is rejected; the returned URL is served from /uploads.

const fs = require('fs');
const path = require('path');
const bwipjs = require('bwip-js');
const { app, request, setupWorkspaceWithProduct, registerAndActivate, createWorkspace } = require('../helpers/factories');
const { UPLOAD_ROOT } = require('../../src/modules/media/mediaService');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let PNG;
beforeAll(async () => {
  PNG = await bwipjs.toBuffer({ bcid: 'code128', text: 'media-test', scale: 1, height: 6, includetext: false });
});

// Clean out the per-workspace upload dirs this run created, but leave the
// UPLOAD_ROOT itself (and its tracked .gitkeep) in place.
afterAll(() => {
  try {
    for (const entry of fs.readdirSync(UPLOAD_ROOT)) {
      if (entry === '.gitkeep') continue;
      fs.rmSync(path.join(UPLOAD_ROOT, entry), { recursive: true, force: true });
    }
  } catch { /* ignore */ }
});

describe('media upload', () => {
  it('stores a valid PNG and returns a directly-usable URL', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/media`)
      .set(bearer(auth.accessToken))
      .attach('file', PNG, { filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.mimeType).toBe('image/png');
    expect(res.body.size).toBe(PNG.length);
    expect(res.body.path).toMatch(new RegExp(`^/uploads/${workspace.id}/[0-9a-f-]+\\.png$`));
    expect(res.body.url).toContain(res.body.path);

    // it's really on disk
    const onDisk = path.join(UPLOAD_ROOT, res.body.path.replace('/uploads/', ''));
    expect(fs.existsSync(onDisk)).toBe(true);

    // and served back
    const fetched = await request(app).get(res.body.path).buffer(true).parse((r, cb) => {
      const d = [];
      r.on('data', (c) => d.push(c));
      r.on('end', () => cb(null, Buffer.concat(d)));
    });
    expect(fetched.status).toBe(200);
    expect(fetched.body.length).toBe(PNG.length);
  });

  it('decides type by content, not by extension', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();

    // real PNG bytes, but named .txt with a text mimetype -> accepted
    const good = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/media`)
      .set(bearer(auth.accessToken))
      .attach('file', PNG, { filename: 'not-really.txt', contentType: 'text/plain' });
    expect(good.status).toBe(201);
    expect(good.body.mimeType).toBe('image/png');

    // text bytes dressed up as image/png with a .png name -> rejected
    const bad = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/media`)
      .set(bearer(auth.accessToken))
      .attach('file', Buffer.from('this is definitely not an image'), { filename: 'evil.png', contentType: 'image/png' });
    expect(bad.status).toBe(415);
    expect(bad.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('accepts a JPEG by its magic bytes', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(256, 0x20)]);
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/media`)
      .set(bearer(auth.accessToken))
      .attach('file', jpeg, { filename: 'photo', contentType: 'application/octet-stream' });
    expect(res.status).toBe(201);
    expect(res.body.mimeType).toBe('image/jpeg');
  });

  it('rejects a file over 5MB', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1)]);
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/media`)
      .set(bearer(auth.accessToken))
      .attach('file', big, { filename: 'huge.png', contentType: 'image/png' });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('is refused across workspaces and without the permission', async () => {
    const A = await setupWorkspaceWithProduct({ workspaceName: 'Media A' });
    const B = await registerAndActivate({ fullName: 'Media B' });
    await createWorkspace(B.accessToken, 'Media B WS');

    const res = await request(app)
      .post(`/api/v1/workspaces/${A.workspace.id}/media`)
      .set(bearer(B.accessToken))
      .attach('file', PNG, { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(404);
  });
});
