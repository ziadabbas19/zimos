'use strict';

const crypto = require('crypto');
const { AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { getStorage, UPLOAD_ROOT } = require('./storage');

const MAX_BYTES = 5 * 1024 * 1024;

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

  const result = { url, path, mimeType: sig.mime, size: file.size };

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'media.upload',
    entityType: 'Media',
    entityId: filename,
    after: result,
    req,
  });

  return result;
}

module.exports = { storeImage, detectImage, UPLOAD_ROOT, MAX_BYTES };
