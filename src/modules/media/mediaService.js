'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { getStorage, UPLOAD_ROOT } = require('./storage');
const { processMerchantImage } = require('./imageProcessing');
const thumbnails = require('./thumbnails');

const Op = db.Sequelize.Op;

const MAX_BYTES = 5 * 1024 * 1024;

// Media library page size when a caller names none. The request cap (100)
// lives with the rest of the request contract, in mediaValidation.js.
const DEFAULT_LIMIT = 30;

// Type is decided by the actual file bytes, never the filename or the
// client-declared mimetype.
const SIGNATURES = [
  { mime: 'image/png', ext: 'png', match: (b) => b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a },
  { mime: 'image/jpeg', ext: 'jpg', match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', match: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.toString('latin1', 0, 6)) },
  {
    mime: 'image/webp',
    ext: 'webp',
    match: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  },
];

// Binary glTF — the 3D product model a shopper can rotate on the storefront
// (the product_3d page element). The header is 'glTF' + version 2 + total
// length, so a truncated upload is refused here rather than failing in the
// browser. A model is legitimately larger than an image, so it has its own
// ceiling, and it is stored as uploaded (there is no image to re-encode).
const MODEL_SIGNATURE = {
  mime: 'model/gltf-binary',
  ext: 'glb',
  match: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'glTF' && b.readUInt32LE(4) === 2,
};
const MAX_MODEL_BYTES = 15 * 1024 * 1024;
// A product video (SPEC §7.1): MP4 (an ISO "ftyp" box at byte 4) or WebM
// (the EBML magic). Stored as uploaded — there is no transcoder here — under
// its own ceiling; the product page plays it beside the pictures.
const VIDEO_SIGNATURES = [
  { mime: 'video/mp4', ext: 'mp4', match: (b) => b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' && !/^qt/.test(b.toString('latin1', 8, 12)) },
  { mime: 'video/webm', ext: 'webm', match: (b) => b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3 },
];
const MAX_VIDEO_BYTES = 30 * 1024 * 1024;
// The widest limit any accepted type allows — what multer lets through before
// storeImage applies the per-type ceiling.
const MAX_UPLOAD_BYTES = Math.max(MAX_BYTES, MAX_MODEL_BYTES, MAX_VIDEO_BYTES);

function detectImage(buffer) {
  return SIGNATURES.find((s) => s.match(buffer)) || null;
}

async function storeImage(workspaceId, file, req) {
  if (!file) throw new AppError('NO_FILE', 'No file was uploaded (field name must be "file")', 422);

  const isModel = MODEL_SIGNATURE.match(file.buffer);
  const video = isModel ? null : VIDEO_SIGNATURES.find((v) => v.match(file.buffer)) || null;
  const sig = isModel ? MODEL_SIGNATURE : video || detectImage(file.buffer);
  if (!sig) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Only PNG, JPEG, GIF or WEBP images, MP4 or WebM videos, or GLB 3D models, are accepted', 415);
  }
  const limit = isModel ? MAX_MODEL_BYTES : video ? MAX_VIDEO_BYTES : MAX_BYTES;
  if (file.size > limit) {
    throw new AppError('FILE_TOO_LARGE', `The file exceeds the ${Math.round(limit / (1024 * 1024))}MB limit`, 413);
  }

  // Upright, re-encoded in its own format, and stripped of EXIF / XMP / IPTC
  // (a phone photo's GPS position among them) before anything is stored, and
  // scaled down to MEDIA_MAX_DIMENSION (icons of 512px or less untouched). A
  // GIF keeps its frames and only loses its comment and XMP blocks. An image
  // that cannot be decoded is refused here (422 IMAGE_UNREADABLE).
  const processed =
    isModel || video
      ? file.buffer
      : await processMerchantImage(file.buffer, sig, {
          maxDimension: env.media.maxDimension,
          quality: env.media.jpegQuality,
        });

  // Smaller copies beside it, stored first, so a name that says it has them is
  // never a promise broken. Nothing here fails the upload (media/thumbnails.js).
  const fileBase = crypto.randomUUID();
  let filename = `${fileBase}.${sig.ext}`;
  if (!isModel && !video && thumbnails.enabled()) {
    const copies = await thumbnails.makeCopies(processed, sig.mime);
    if (copies.length > 0 && (await thumbnails.storeCopies(getStorage(), workspaceId, fileBase, copies))) {
      filename = thumbnails.markedName(fileBase, sig.ext);
    }
  }

  const { url, path } = await getStorage().put({
    workspaceId,
    filename,
    buffer: processed,
    contentType: sig.mime,
  });

  // The row is what makes the file findable again: without it an upload is
  // only ever a URL the merchant had to keep hold of themselves.
  const asset = await db.MediaAsset.create({
    workspaceId,
    uploadedByUserId: req.user ? req.user.id : null,
    url,
    path,
    mimeType: sig.mime,
    sizeBytes: processed.length,
  });

  const result = { id: asset.id, url, path, mimeType: sig.mime, size: processed.length };

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'media.upload',
    entityType: 'Media',
    // The asset id, not the filename: an audit row nobody can resolve back to
    // a record is only half an audit trail.
    entityId: asset.id,
    after: result,
    req,
  });

  return result;
}

const toPublicAsset = (row) => ({
  id: row.id,
  url: row.url,
  mimeType: row.mimeType,
  size: row.sizeBytes,
  createdAt: row.createdAt,
});

/**
 * The library grid: one workspace's files, newest first, paged by a `before`
 * cursor holding the last id of the previous page. Ordering is
 * (created_at DESC, id DESC) rather than id alone — the grid is chronological,
 * and uuid v4 ids sort arbitrarily — so the cursor compares the pair, which is
 * also what the (workspace_id, created_at DESC, id) index is built for.
 */
async function listMedia(workspaceId, { limit = DEFAULT_LIMIT, before } = {}) {
  const where = { workspaceId };

  if (before) {
    const anchor = await db.MediaAsset.findOne({
      where: { id: before, workspaceId },
      attributes: ['id', 'createdAt'],
    });
    if (!anchor) throw new NotFoundError('Media');
    where[Op.or] = [
      { createdAt: { [Op.lt]: anchor.createdAt } },
      { createdAt: anchor.createdAt, id: { [Op.lt]: anchor.id } },
    ];
  }

  const rows = await db.MediaAsset.findAll({
    where,
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    media: page.map(toPublicAsset),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

/**
 * Removes a file from the library. The row goes first and unconditionally:
 * that is what the merchant asked for, and a storage backend that is briefly
 * unreachable must not make a deleted image reappear in the picker. A failed
 * object delete is logged and leaves an orphan — cheap, and sweepable later.
 */
async function deleteMedia(workspaceId, mediaId, req) {
  const asset = await db.MediaAsset.findOne({ where: { id: mediaId, workspaceId } });
  if (!asset) throw new NotFoundError('Media');

  const before = { url: asset.url, path: asset.path, mimeType: asset.mimeType, size: asset.sizeBytes };
  await asset.destroy();

  // With its smaller copies, when it has them (media/thumbnails.js).
  for (const stored of [asset.path, ...thumbnails.copyPaths(asset.path)]) {
    try {
      await getStorage().remove(stored);
    } catch (err) {
      logger.error(`media delete: stored object "${stored}" was not removed: ${err.message}`, {
        workspaceId,
        mediaId,
      });
    }
  }

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'media.delete',
    entityType: 'Media',
    entityId: asset.id,
    before,
    req,
  });

  return { deleted: true };
}

module.exports = { storeImage, listMedia, deleteMedia, detectImage, UPLOAD_ROOT, MAX_BYTES, MAX_MODEL_BYTES, MAX_UPLOAD_BYTES };
