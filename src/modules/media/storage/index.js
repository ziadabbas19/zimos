'use strict';

const env = require('../../../config/env');
const localStorage = require('./localStorage');
const r2Storage = require('./r2Storage');

const backends = { local: localStorage, r2: r2Storage };

// Picks the backend from STORAGE_PROVIDER (already trimmed/lower-cased in
// env.js). Read here rather than captured once so a runtime override in tests
// still applies. Every backend exposes the same
//   put({ workspaceId, filename, buffer, contentType }) -> { url, path }
function getStorage() {
  const name = env.storage.provider;
  const backend = backends[name];
  if (!backend) {
    throw new Error(
      `Unknown STORAGE_PROVIDER "${name}" — expected "local" or "r2". ` +
        'Check the value on the host has no stray quotes/whitespace.'
    );
  }
  return backend;
}

// One-line summary for the boot log so the deploy log shows what actually
// resolved, and which R2 vars (if any) are missing.
function describeStorage() {
  const name = env.storage.provider;
  if (name !== 'r2') return `local (serving /uploads from disk)`;

  const r2 = env.storage.r2;
  const missing = ['accountId', 'accessKeyId', 'secretAccessKey', 'bucketName', 'publicUrl'].filter((k) => !r2[k]);
  const map = {
    accountId: 'R2_ACCOUNT_ID',
    accessKeyId: 'R2_ACCESS_KEY_ID',
    secretAccessKey: 'R2_SECRET_ACCESS_KEY',
    bucketName: 'R2_BUCKET_NAME',
    publicUrl: 'R2_PUBLIC_URL',
  };
  const suffix = missing.length ? ` — MISSING ${missing.map((k) => map[k]).join(', ')}` : '';
  return `r2 (bucket=${r2.bucketName || '?'}, public=${r2.publicUrl || '?'})${suffix}`;
}

function r2ConfigError() {
  if (env.storage.provider !== 'r2') return null;
  const r2 = env.storage.r2;
  const map = {
    accountId: 'R2_ACCOUNT_ID',
    accessKeyId: 'R2_ACCESS_KEY_ID',
    secretAccessKey: 'R2_SECRET_ACCESS_KEY',
    bucketName: 'R2_BUCKET_NAME',
    publicUrl: 'R2_PUBLIC_URL',
  };
  const missing = Object.keys(map).filter((k) => !r2[k]);
  return missing.length ? `STORAGE_PROVIDER=r2 but missing: ${missing.map((k) => map[k]).join(', ')}` : null;
}

module.exports = { getStorage, describeStorage, r2ConfigError, UPLOAD_ROOT: localStorage.UPLOAD_ROOT };
