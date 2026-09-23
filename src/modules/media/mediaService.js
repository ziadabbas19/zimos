'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { getStorage, UPLOAD_ROOT } = require('./storage');

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

function detectImage(buffer) {
  return SIGNATURES.find((s) => s.match(buffer)) || null;
}

async function storeImage(workspaceId, file, req) {
  if (!file) throw new AppError('NO_FILE', 'No file was uploaded (field name must be "file")', 422);
  if (file.size > MAX_BYTES) throw new AppError('FILE_TOO_LARGE', 'The file exceeds the 5MB limit', 413);

  const sig = detectImage(file.buffer);
  if (!sig) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Only PNG, JPEG, GIF or WEBP images are accepted', 415);
  }

  const filename = `${crypto.randomUUID()}.${sig.ext}`;
  const { url, path } = await getStorage().put({
    workspaceId,
    filename,
    buffer: file.buffer,
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
    sizeBytes: file.size,
  });

  const result = { id: asset.id, url, path, mimeType: sig.mime, size: file.size };

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

  try {
    await getStorage().remove(asset.path);
  } catch (err) {
    logger.error(`media delete: stored object "${asset.path}" was not removed: ${err.message}`, {
      workspaceId,
      mediaId,
    });
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

module.exports = { storeImage, listMedia, deleteMedia, detectImage, UPLOAD_ROOT, MAX_BYTES };
