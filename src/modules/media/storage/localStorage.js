'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../config/env');

// public/uploads at the project root — served statically by app.js at /uploads.
const UPLOAD_ROOT = path.resolve(__dirname, '../../../../public/uploads');

async function put({ workspaceId, filename, buffer }) {
  const dir = path.join(UPLOAD_ROOT, workspaceId);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, filename), buffer);

  const relPath = `/uploads/${workspaceId}/${filename}`;
  return {
    url: `${env.appUrl.replace(/\/$/, '')}${relPath}`,
    path: relPath,
  };
}

/**
 * Deletes one stored object by the `path` put() returned. The caller treats a
 * failure as non-fatal, so this may throw freely (a missing file included —
 * the library row is what the merchant asked us to remove).
 */
async function remove(storagePath) {
  const relative = String(storagePath).replace(/^\/uploads\//, '');
  const target = path.resolve(UPLOAD_ROOT, relative);
  // These keys are ours, but a row rewritten by hand should still never make
  // us unlink something outside the upload root.
  if (target !== UPLOAD_ROOT && !target.startsWith(UPLOAD_ROOT + path.sep)) {
    throw new Error(`Refusing to delete outside the upload root: ${storagePath}`);
  }
  await fs.promises.unlink(target);
}

/**
 * Health probe for /admin/system/services. Local disk is "configured" by
 * definition, so the only thing worth checking is that the upload root is
 * actually writable — an ephemeral container filesystem that has gone
 * read-only is exactly the failure this tile should catch.
 */
async function probe() {
  const marker = path.join(UPLOAD_ROOT, '.probe');
  await fs.promises.mkdir(UPLOAD_ROOT, { recursive: true });
  await fs.promises.writeFile(marker, String(Date.now()));
  await fs.promises.unlink(marker).catch(() => {});
  return { detail: `local disk (${UPLOAD_ROOT})` };
}

module.exports = { put, remove, probe, UPLOAD_ROOT };
