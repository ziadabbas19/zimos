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
  // X-Payment-Token: the shopper's status token for an unpaid online order.
  // X-Store-Preview: a staff preview token that unlocks test-mode payments.
  // X-Visitor-Id: the storefront's anonymous visitor, which owns the photos it
  // uploads for custom fields (customerUploads).
  // X-Shopper-Token: a signed-in shopper (shopperAccounts).
  allowedHeaders: ['Content-Type', 'X-Cart-Token', 'Idempotency-Key', 'X-Payment-Token', 'X-Store-Preview', 'X-Visitor-Id', 'X-Student-Token', 'X-Store-Locale', 'X-Shopper-Token'],
  // The storefront reads Retry-After on a 429 to tell the shopper when to retry.
  exposedHeaders: ['Retry-After'],
  maxAge: 7200,
});

// Every dashboard call carries an Authorization header, so the browser asks
// first (OPTIONS) for each distinct URL. Without a max age it keeps that
// answer for 5 seconds; 7200 (two hours) is the most Chromium keeps. The
// actual response still names the origin per request, so taking an origin off
// CORS_ORIGINS still blocks it at once.
const allowlistCors = cors({
  origin: env.cors.origins,
  credentials: true,
  maxAge: 7200,
});

// The marketing site's anonymous beacon (siteAnalytics/siteEventsRoutes): only
// SITE_ANALYTICS_ORIGINS, no credentials, read per request so the flag and the
// list can change at runtime. Off, no origin gets the headers.
const SITE_EVENTS_PATH = `/api/${env.apiVersion}/public/site-events`;

function isSiteEventsPath(p) {
  const lower = String(p || '').toLowerCase().replace(/\/+$/, '');
  return lower === SITE_EVENTS_PATH;
}

const siteEventsCors = cors({
  origin: (origin, callback) =>
    callback(null, Boolean(env.siteAnalytics.enabled && origin && env.siteAnalytics.origins.includes(String(origin).toLowerCase()))),
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  maxAge: 7200,
});

function corsPolicy(req, res, next) {
  if (isStorefrontApiPath(req.path)) return storefrontCors(req, res, next);
  if (isSiteEventsPath(req.path)) return siteEventsCors(req, res, next);
  return allowlistCors(req, res, next);
}

module.exports = { corsPolicy, isStorefrontApiPath, isSiteEventsPath };
