'use strict';

/**
 * Optional, by hand: gives pictures already in the merchants' media libraries
 * the smaller copies new uploads get (modules/media/thumbnails.js). Nothing runs
 * this on its own, and old pictures keep working without it.
 *
 * Dry run by default: it reads and resizes, reports what it would write, and
 * writes nothing. Pass --apply to write.
 *
 *   node scripts/backfill-media-thumbnails.js                     # dry run, 100 pictures
 *   node scripts/backfill-media-thumbnails.js --apply --workspace <uuid> --limit 500
 *   node scripts/backfill-media-thumbnails.js --apply --rewrite-products --after <media id>
 *
 * --limit             stop after this many pictures (default 100, at most 5000)
 * --sleep-ms          wait between pictures (default 500), so a run never crowds the server
 * --workspace         one store only
 * --after             resume after this media_assets id (the last one a run printed)
 * --rewrite-products  also point the store's products and variants at the new
 *                     address, where they hold exactly the old one. Without it
 *                     only the library row moves, and a product keeps drawing the
 *                     old file (which still works) until it is saved again.
 *
 * What --apply writes for a picture: the four copies, the picture itself again
 * under its marked name, the library row's new url and path. The old file stays
 * where it is: pages, themes and anything else holding its address keep working.
 * A picture that cannot be read or resized is reported and left as it is.
 *
 * Runs against whatever database and storage src/config/env resolves. Never run
 * it against production without a backup and a small --limit first.
 */

const path = require('path');
const db = require('../src/db/models');
const { getStorage } = require('../src/modules/media/storage');
const thumbnails = require('../src/modules/media/thumbnails');

function readArgs(argv) {
  const args = { apply: false, limit: 100, sleepMs: 500, workspace: null, after: null, rewriteProducts: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--rewrite-products') args.rewriteProducts = true;
    else if (a === '--limit') args.limit = Math.max(1, Math.min(5000, parseInt(argv[++i], 10) || 100));
    else if (a === '--sleep-ms') args.sleepMs = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (a === '--workspace') args.workspace = argv[++i];
    else if (a === '--after') args.after = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The next row of pictures without copies, oldest id first. */
async function nextRow({ workspace, after }) {
  const { Op } = db.Sequelize;
  return db.MediaAsset.findOne({
    where: {
      mimeType: ['image/jpeg', 'image/png', 'image/webp'],
      path: { [Op.notRegexp]: '-t\\.[a-z0-9]+$' },
      ...(workspace ? { workspaceId: workspace } : {}),
      ...(after ? { id: { [Op.gt]: after } } : {}),
    },
    order: [['id', 'ASC']],
  });
}

/** Points the store's products and variants that hold exactly `from` at `to`, inside `transaction`. */
async function rewriteProducts(workspaceId, from, to, transaction) {
  const [, media] = await db.sequelize.query(
    `UPDATE products SET media = (
       SELECT jsonb_agg(CASE WHEN item ->> 'url' = :from THEN jsonb_set(item, '{url}', to_jsonb(CAST(:to AS text))) ELSE item END ORDER BY ord)
         FROM jsonb_array_elements(media) WITH ORDINALITY AS t(item, ord))
      WHERE workspace_id = :workspaceId AND jsonb_typeof(media) = 'array'
        AND media @> jsonb_build_array(jsonb_build_object('url', CAST(:from AS text)))`,
    { replacements: { workspaceId, from, to }, transaction }
  );
  const [, variants] = await db.sequelize.query(
    'UPDATE product_variants SET image_url = :to WHERE workspace_id = :workspaceId AND image_url = :from',
    { replacements: { workspaceId, from, to }, transaction }
  );
  return { products: media && media.rowCount ? media.rowCount : 0, variants: variants && variants.rowCount ? variants.rowCount : 0 };
}

/** One picture. Returns what happened, for the report line. */
async function backfillOne(row, { apply, rewrite }) {
  const storage = getStorage();
  const stored = await storage.get(row.path);
  if (!stored) return { skipped: 'file is gone' };
  const copies = await thumbnails.makeCopies(stored.buffer, row.mimeType);
  if (copies.length === 0) return { skipped: 'no copies for this picture (small, or unreadable)' };
  const size = copies.reduce((sum, c) => sum + c.buffer.length, 0);
  if (!apply) return { wouldWrite: size };

  const filename = path.posix.basename(row.path);
  const ext = path.posix.extname(filename).slice(1);
  const base = filename.slice(0, filename.length - ext.length - 1);
  if (!(await thumbnails.storeCopies(storage, row.workspaceId, base, copies))) return { skipped: 'copies could not be stored' };
  const { url, path: newPath } = await storage.put({
    workspaceId: row.workspaceId,
    filename: thumbnails.markedName(base, ext),
    buffer: stored.buffer,
    contentType: row.mimeType,
  });
  const oldUrl = row.url;
  const changed = await db.sequelize.transaction(async (transaction) => {
    await row.update({ url, path: newPath }, { transaction });
    return rewrite ? rewriteProducts(row.workspaceId, oldUrl, url, transaction) : null;
  });
  return { wrote: size, url, ...(changed ? { rewritten: changed } : {}) };
}

async function run(args, log = console.log) {
  const summary = { seen: 0, done: 0, skipped: 0, failed: 0, last: null };
  let after = args.after;
  while (summary.seen < args.limit) {
    const row = await nextRow({ workspace: args.workspace, after });
    if (!row) break;
    summary.seen += 1;
    after = row.id;
    summary.last = row.id;
    try {
      const result = await backfillOne(row, { apply: args.apply, rewrite: args.rewriteProducts });
      if (result.skipped) summary.skipped += 1;
      else summary.done += 1;
      log(`${row.id} ${JSON.stringify(result)}`);
    } catch (err) {
      summary.failed += 1;
      log(`${row.id} FAILED ${err.message}`);
    }
    if (args.sleepMs > 0) await sleep(args.sleepMs);
  }
  return summary;
}

if (require.main === module) {
  run(readArgs(process.argv.slice(2)))
    .then(async (summary) => {
      console.log(JSON.stringify(summary));
      await db.sequelize.close();
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { run, readArgs };
