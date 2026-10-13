'use strict';

const env = require('../../../config/env');
const localStorage = require('./localStorage');
const r2Storage = require('./r2Storage');

const backends = { local: localStorage, r2: r2Storage };

const R2_VARS = {
  accountId: 'R2_ACCOUNT_ID',
  accessKeyId: 'R2_ACCESS_KEY_ID',
  secretAccessKey: 'R2_SECRET_ACCESS_KEY',
  bucketName: 'R2_BUCKET_NAME',
  publicUrl: 'R2_PUBLIC_URL',
  privateBucketName: 'R2_PRIVATE_BUCKET_NAME',
};
// Unset, private objects go to the media bucket (r2Storage.privateBucket), so
// it is not required: describeStorage() says which of the two is in effect.
const R2_OPTIONAL = new Set(['privateBucketName']);

// Picks the backend from STORAGE_PROVIDER (already trimmed/lower-cased in
// env.js). Read here rather than captured once so a runtime override in tests
// still applies. Every backend exposes the same
//   put({ workspaceId, filename, buffer, contentType }) -> { url, path }
//   remove(path)  — deletes one object by the key put() returned
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

/** The prefix every stored file's public URL starts with, or null when there is none. */
function publicBaseUrl() {
  if (env.storage.provider === 'r2') return env.storage.r2.publicUrl || null;
  return `${String(env.appUrl).replace(/\/$/, '')}/uploads`;
}

function parseHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/**
 * Every setting that makes the links put() hands out wrong, unreachable or
 * short-lived. Each entry names the variable to fix, never a secret's value.
 * An empty list means the configuration itself is sound (whether the bucket
 * answers is probeStorage's job).
 */
function storageProblems() {
  const name = env.storage.provider;
  if (!backends[name]) return [`Unknown STORAGE_PROVIDER "${name}" — expected "local" or "r2"`];
  const problems = [];

  if (name === 'r2') {
    const r2 = env.storage.r2;
    const missing = Object.keys(R2_VARS).filter((k) => !R2_OPTIONAL.has(k) && !r2[k]);
    if (missing.length) problems.push(`STORAGE_PROVIDER=r2 but missing: ${missing.map((k) => R2_VARS[k]).join(', ')}`);
    if (r2.publicUrl) {
      const parsed = parseHttpUrl(r2.publicUrl);
      if (!parsed) {
        problems.push(
          'R2_PUBLIC_URL is not an absolute http(s) URL — every image link built from it is relative and breaks (use https://<the bucket public domain>)'
        );
      } else if (parsed.hostname.endsWith('.r2.cloudflarestorage.com')) {
        problems.push(
          'R2_PUBLIC_URL is the private S3 API endpoint (*.r2.cloudflarestorage.com), which never serves files publicly — use the bucket public r2.dev URL or its custom domain'
        );
      } else if (env.isProduction && parsed.protocol !== 'https:') {
        problems.push('R2_PUBLIC_URL is http:// — an https dashboard or store may refuse to show those images');
      }
    }
    return problems;
  }

  if (env.isProduction) {
    if (!env.storage.allowLocalInProduction) {
      problems.push(
        'production is on STORAGE_PROVIDER=local without ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true — public/uploads is erased by the next deploy, and every image uploaded before it stops loading (set STORAGE_PROVIDER=r2, or mount a volume there and set the flag)'
      );
    }
    const app = parseHttpUrl(env.appUrl);
    if (!app || LOOPBACK.has(app.hostname)) {
      problems.push('APP_URL is not the public address of this API — every local upload link is built from it');
    }
  }
  return problems;
}

// One-line summary for the boot log and the admin storage tile: the driver
// that actually resolved and the public base URL its links use, and for R2
// the bucket private files are kept in — the media bucket itself, which is
// public, while R2_PRIVATE_BUCKET_NAME is unset or names it. No secrets.
function describeStorage() {
  const name = env.storage.provider;
  const base = publicBaseUrl() || '?';
  if (name !== 'r2') return `local (serving /uploads from disk, public=${base})`;
  const { bucketName, privateBucketName } = env.storage.r2;
  const separate = Boolean(privateBucketName) && privateBucketName !== bucketName;
  const privateFiles = separate
    ? `private=${privateBucketName}`
    : `private=${bucketName || '?'} [${privateBucketName ? `${R2_VARS.privateBucketName} names the public bucket` : `${R2_VARS.privateBucketName} not set`}: private files share the public bucket]`;
  return `r2 (bucket=${bucketName || '?'}, ${privateFiles}, public=${base})`;
}

// Health probe for the ACTIVE backend, for /admin/system/services. Each
// backend implements probe() itself so the S3 client and the disk paths stay
// behind their own module.
function probeStorage() {
  return getStorage().probe();
}

/**
 * The multipart-upload half of the active backend (MULTIPART.md): R2's real
 * presigned uploads, or the sandbox's signed stand-ins on local disk.
 */
function getMultipart() {
  // eslint-disable-next-line global-require
  return env.storage.provider === 'r2' ? require('./r2Multipart') : require('./localMultipart');
}

module.exports = {
  getStorage,
  getMultipart,
  describeStorage,
  publicBaseUrl,
  storageProblems,
  probeStorage,
  UPLOAD_ROOT: localStorage.UPLOAD_ROOT,
};
