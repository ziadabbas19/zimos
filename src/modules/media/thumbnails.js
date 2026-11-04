'use strict';

const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { SMALL_IMAGE_EDGE, loadSharp } = require('./imageProcessing');

/**
 * Smaller WebP copies of a merchant's picture, written beside it when it is
 * uploaded (MEDIA_THUMBNAILS_ENABLED; off, nothing here runs and files are named
 * as ever).
 *
 *   <uuid>-t.jpg        the picture itself: "-t" says the copies exist
 *   <uuid>-t-w320.webp  and -w640, -w1024, -w1600: always all four
 *
 * The name is the whole contract. The storefront and the dashboard read it from
 * the URL they already have (packages/image-tools thumbnailSrcSet), so nothing
 * in a product, a page or the API changes, and a picture whose name lacks the
 * "-t" (all that were uploaded before, a GIF, an icon) keeps drawing its one
 * file. A copy never upscales: a picture narrower than a width gets a copy at
 * its own width under that width's name.
 *
 * Nothing here can fail an upload: a copy that cannot be made or stored leaves
 * the picture as it would have been without any, and says so in the log.
 * scripts/backfill-media-thumbnails.js does the same for what is already stored.
 */

const WIDTHS = [1600, 1024, 640, 320];
const WEBP_QUALITY = 78;
const MAX_INPUT_PIXELS = 60 * 1000 * 1000;
const MARK = '-t';
const WITH_THUMBNAILS = new Set(['image/jpeg', 'image/png', 'image/webp']);

const enabled = () => env.media.thumbnails === true;

/** The picture's file name when it has copies: `<uuid>-t.<ext>`. */
const markedName = (base, ext) => `${base}${MARK}.${ext}`;
/** A copy's file name, from the marked name's base. */
const copyName = (base, width) => `${base}${MARK}-w${width}.webp`;
/** The base of a marked name, or null when this file has no copies. */
function baseOfMarked(filename) {
  const match = /^(.+)-t\.[a-z0-9]+$/i.exec(String(filename));
  return match ? match[1] : null;
}

/**
 * The copies for this picture, widest first: [{ width, buffer }], or [] when it
 * should have none (a GIF, an icon) or they could not be made. Each is made from
 * the one before it, so only the first decodes the whole upload.
 */
async function makeCopies(buffer, mimeType) {
  if (!WITH_THUMBNAILS.has(mimeType)) return [];
  // Loaded on first use, as imageProcessing does: a deploy with no sharp still boots.
  const sharp = loadSharp();
  if (!sharp) return [];
  try {
    const { width = 0, height = 0 } = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (Math.max(width, height) <= SMALL_IMAGE_EDGE) return [];
    const copies = [];
    let source = buffer;
    for (const target of WIDTHS) {
      const data = await sharp(source, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
        .resize({ width: target, withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      copies.push({ width: target, buffer: data });
      source = data;
    }
    return copies;
  } catch (err) {
    logger.warn(`media thumbnails: no copies for this picture: ${err.message}`);
    return [];
  }
}

/**
 * Stores the copies. True when all of them went in; otherwise the ones that did
 * are taken back out and it is false, so the picture is stored with no mark.
 */
async function storeCopies(storage, workspaceId, base, copies) {
  const stored = [];
  try {
    for (const { width, buffer } of copies) {
      const { path } = await storage.put({ workspaceId, filename: copyName(base, width), buffer, contentType: 'image/webp' });
      stored.push(path);
    }
    return true;
  } catch (err) {
    logger.warn(`media thumbnails: could not store the copies: ${err.message}`);
    await Promise.allSettled(stored.map((path) => storage.remove(path)));
    return false;
  }
}

/** The copies' paths for a stored picture's path; [] for one with no mark. */
function copyPaths(storedPath) {
  const text = String(storedPath);
  const slash = text.lastIndexOf('/');
  const base = baseOfMarked(text.slice(slash + 1));
  if (!base) return [];
  return WIDTHS.map((width) => `${text.slice(0, slash + 1)}${copyName(base, width)}`);
}

module.exports = { enabled, makeCopies, storeCopies, copyPaths, markedName, copyName, baseOfMarked, WIDTHS };
