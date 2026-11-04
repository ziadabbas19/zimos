'use strict';

// MEDIA_THUMBNAILS_ENABLED: smaller WebP copies beside each uploaded picture.
// Off, an upload is what it always was; nothing here can fail an upload; and
// scripts/backfill-media-thumbnails.js does the same for what is already stored.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { getStorage, UPLOAD_ROOT } = require('../../src/modules/media/storage');
const thumbnails = require('../../src/modules/media/thumbnails');
const backfill = require('../../scripts/backfill-media-thumbnails');

const WIDTHS = [320, 640, 1024, 1600];

const picture = (width, height = Math.round(width * 0.75), format = 'jpeg') =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } } })
    [format]()
    .toBuffer();

async function setup() {
  const owner = await registerAndActivate();
  const workspace = await createWorkspace(owner.accessToken, 'Picture Store');
  return { id: workspace.id, H: { Authorization: `Bearer ${owner.accessToken}` }, base: `/api/v1/workspaces/${workspace.id}/media` };
}

const upload = (ctx, buffer, name = 'a.jpg', contentType = 'image/jpeg') =>
  request(app).post(ctx.base).set(ctx.H).attach('file', buffer, { filename: name, contentType });

const onDisk = (workspaceId) => {
  const dir = path.join(UPLOAD_ROOT, workspaceId);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};
const clean = (workspaceId) => fs.rmSync(path.join(UPLOAD_ROOT, workspaceId), { recursive: true, force: true });

let created = [];
const ORIGINAL = env.media.thumbnails;

afterEach(() => {
  env.media.thumbnails = ORIGINAL;
  jest.restoreAllMocks();
  for (const id of created) clean(id);
  created = [];
});

describe('with the switch off (the default)', () => {
  it('stores one file under a plain name', async () => {
    expect(env.media.thumbnails).toBe(false);
    const ctx = await setup();
    created.push(ctx.id);
    const res = await upload(ctx, await picture(1800));
    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/\/[0-9a-f-]{36}\.jpg$/);
    expect(onDisk(ctx.id)).toHaveLength(1);
  });
});

describe('with the switch on', () => {
  beforeEach(() => {
    env.media.thumbnails = true;
  });

  it('stores the four copies beside a picture named to say so, and takes them away with it', async () => {
    const ctx = await setup();
    created.push(ctx.id);
    const res = await upload(ctx, await picture(1800));
    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/\/[0-9a-f-]{36}-t\.jpg$/);
    const base = path.basename(res.body.url, '.jpg');
    expect(onDisk(ctx.id)).toEqual([`${base}-w1024.webp`, `${base}-w1600.webp`, `${base}-w320.webp`, `${base}-w640.webp`, `${base}.jpg`].sort());

    for (const width of WIDTHS) {
      // From a Buffer: sharp keeps a file it opened by name open, and Windows then refuses to delete it.
      const meta = await sharp(fs.readFileSync(path.join(UPLOAD_ROOT, ctx.id, `${base}-w${width}.webp`))).metadata();
      expect([meta.format, meta.width]).toEqual(['webp', width]);
    }

    const row = await db.MediaAsset.findOne({ where: { workspaceId: ctx.id } });
    const del = await request(app).delete(`${ctx.base}/${row.id}`).set(ctx.H);
    expect(del.status).toBe(200);
    expect(onDisk(ctx.id)).toEqual([]);
  });

  it('never upscales: a narrower picture keeps its own width under every name', async () => {
    const ctx = await setup();
    created.push(ctx.id);
    const res = await upload(ctx, await picture(800));
    const base = path.basename(res.body.url, '.jpg');
    const widths = {};
    for (const width of WIDTHS) widths[width] = (await sharp(fs.readFileSync(path.join(UPLOAD_ROOT, ctx.id, `${base}-w${width}.webp`))).metadata()).width;
    expect(widths).toEqual({ 320: 320, 640: 640, 1024: 800, 1600: 800 });
  });

  it('leaves an icon, a GIF and a non-picture alone', async () => {
    const ctx = await setup();
    created.push(ctx.id);
    const icon = await upload(ctx, await picture(200, 200, 'png'), 'i.png', 'image/png');
    expect(icon.status).toBe(201);
    expect(icon.body.url).toMatch(/\/[0-9a-f-]{36}\.png$/);
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const gifRes = await upload(ctx, gif, 'g.gif', 'image/gif');
    expect(gifRes.status).toBe(201);
    expect(gifRes.body.url).toMatch(/\/[0-9a-f-]{36}\.gif$/);
    expect(onDisk(ctx.id)).toHaveLength(2);
  });

  it('a failure making the copies does not fail the upload', async () => {
    const ctx = await setup();
    created.push(ctx.id);
    jest.spyOn(thumbnails, 'makeCopies').mockResolvedValue([]);
    const res = await upload(ctx, await picture(1800));
    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/\/[0-9a-f-]{36}\.jpg$/);
    expect(onDisk(ctx.id)).toHaveLength(1);
  });

  it('makeCopies itself answers none for bytes sharp cannot read, instead of throwing', async () => {
    await expect(thumbnails.makeCopies(Buffer.from('not a picture'), 'image/jpeg')).resolves.toEqual([]);
  });

  it('a copy that cannot be stored takes the others back and leaves no mark', async () => {
    const ctx = await setup();
    created.push(ctx.id);
    const storage = getStorage();
    const put = storage.put;
    let n = 0;
    jest.spyOn(storage, 'put').mockImplementation(async (args) => {
      n += 1;
      if (n === 3) throw new Error('storage hiccup');
      return put(args);
    });
    const res = await upload(ctx, await picture(1800));
    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/\/[0-9a-f-]{36}\.jpg$/);
    expect(onDisk(ctx.id)).toHaveLength(1);
  });
});

describe('the backfill script', () => {
  async function oldPicture(ctx) {
    env.media.thumbnails = false;
    const res = await upload(ctx, await picture(1800));
    expect(res.status).toBe(201);
    return res.body;
  }

  it('writes nothing on a dry run', async () => {
    const ctx = await setup();
    created.push(ctx.id);
    const old = await oldPicture(ctx);
    const lines = [];
    const summary = await backfill.run({ apply: false, limit: 5, sleepMs: 0, workspace: ctx.id, after: null, rewriteProducts: false }, (l) => lines.push(l));
    expect(summary).toMatchObject({ seen: 1, done: 1, failed: 0 });
    expect(lines[0]).toContain('wouldWrite');
    expect(onDisk(ctx.id)).toHaveLength(1);
    expect((await db.MediaAsset.findByPk(old.id)).url).toBe(old.url);
  });

  it('gives an old picture its copies, keeps the old file, and stops at its limit', async () => {
    const ctx = await setup();
    created.push(ctx.id);
    const a = await oldPicture(ctx);
    const b = await oldPicture(ctx);
    const summary = await backfill.run({ apply: true, limit: 1, sleepMs: 0, workspace: ctx.id, after: null, rewriteProducts: false }, () => {});
    expect(summary).toMatchObject({ seen: 1, done: 1 });
    const rows = await db.MediaAsset.findAll({ where: { id: [a.id, b.id] } });
    const moved = rows.filter((r) => /-t\.jpg$/.test(r.url));
    expect(moved).toHaveLength(1);
    // The old file, its marked twin and the four copies, plus the other picture.
    expect(onDisk(ctx.id)).toHaveLength(7);
    const again = await backfill.run({ apply: true, limit: 5, sleepMs: 0, workspace: ctx.id, after: null, rewriteProducts: false }, () => {});
    expect(again).toMatchObject({ seen: 1, done: 1 });
    const third = await backfill.run({ apply: true, limit: 5, sleepMs: 0, workspace: ctx.id, after: null, rewriteProducts: false }, () => {});
    expect(third.seen).toBe(0);
  });

  it('rewrites a store\'s own products only when told, and only exact matches', async () => {
    const ctx = await setup();
    created.push(ctx.id);
    const old = await oldPicture(ctx);
    const { generateProductCode } = require('../../src/modules/catalog/catalogService');
    const product = await db.Product.create({
      workspaceId: ctx.id,
      name: 'P',
      slug: `p-${Date.now()}`,
      productCode: generateProductCode(),
      status: 'active',
      media: [{ url: old.url, alt: 'kept' }, { url: 'https://elsewhere.example.com/x.jpg' }],
    });
    await backfill.run({ apply: true, limit: 5, sleepMs: 0, workspace: ctx.id, after: null, rewriteProducts: true }, () => {});
    const row = await db.MediaAsset.findByPk(old.id);
    expect(row.url).toMatch(/-t\.jpg$/);
    await product.reload();
    expect(product.media[0]).toEqual({ url: row.url, alt: 'kept' });
    expect(product.media[1]).toEqual({ url: 'https://elsewhere.example.com/x.jpg' });
  });
});
