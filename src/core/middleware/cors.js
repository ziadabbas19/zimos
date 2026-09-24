'use strict';

const cors = require('cors');
const env = require('../../config/env');

/**
 * Two CORS policies, picked per request by path.
 *
 * The public storefront API (/api/v1/store and below) is called from the
 * browser on every merchant's own subdomain or custom domain, so no static
 * allowlist can cover it. It sends no cookies and no Authorization header
 * (cart identity is the X-Cart-Token header), so it is open to any origin
 * *without* credentials. Only the headers the storefront actually sends are
 * allowed: X-Storefront-Secret / X-Storefront-Client-IP are server-to-server
 * only (see rateLimiters.js), and a browser preflight asking for them fails.
 *
 * Everything else (dashboard, admin, auth) keeps the CORS_ORIGINS allowlist
 * with credentials.
 *
 * One middleware rather than two mounts: cors() ends a preflight itself, so a
 * global allowlist mounted first would answer every store preflight before a
 * store-specific policy ever ran.
 */

const STORE_PREFIX = `/api/${env.apiVersion}/store`;

// Express routes case-insensitively, so /API/V1/Store/... reaches the store
// routers too; match the same way. The segment boundary keeps e.g.
// /api/v1/storefront-x on the allowlist policy.
function isStorefrontApiPath(p) {
  const lower = String(p || '').toLowerCase();
  return lower === STORE_PREFIX || lower.startsWith(`${STORE_PREFIX}/`);
}

const storefrontCors = cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Cart-Token', 'Idempotency-Key'],
  // The storefront reads Retry-After on a 429 to tell the shopper when to retry.
  exposedHeaders: ['Retry-After'],
  maxAge: 7200,
});

const allowlistCors = cors({
  origin: env.cors.origins,
  credentials: true,
});

function corsPolicy(req, res, next) {
  return isStorefrontApiPath(req.path) ? storefrontCors(req, res, next) : allowlistCors(req, res, next);
}

module.exports = { corsPolicy, isStorefrontApiPath };
