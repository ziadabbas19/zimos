'use strict';

const crypto = require('crypto');
const env = require('../../config/env');
const logger = require('../utils/logger');

/**
 * How long each request took. Off unless REQUEST_TIMING_ENABLED is exactly
 * "true": off, this middleware does nothing at all.
 *
 * On, each finished request logs one line: method, route pattern, status and
 * milliseconds (from REQUEST_TIMING_LOG_MIN_MS up, 0 = every one). The pattern
 * is the route as written (/store/:workspaceId/products), never the address
 * asked for, so no id, slug or query string gets in, and a path no route answers
 * reads "unmatched".
 *
 * The same number goes out as `Server-Timing: app;dur=12.3` only to someone
 * entitled to it: a signed-in platform user, or a request carrying
 * REQUEST_TIMING_KEY in X-Timing-Key. A shopper or a merchant never gets the
 * header. It says how long the request took and nothing else.
 */

const STORE_SEGMENT = /\/store\/[^/]+/;
const WORKSPACE_SEGMENT = /\/workspaces\/[^/]+/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The route as written; mounted paths have their values swapped back for their names. */
function routeOf(req) {
  if (!req.route || typeof req.route.path !== 'string') return 'unmatched';
  let base = req.baseUrl || '';
  for (const [name, value] of Object.entries(req.params || {})) {
    if (value) base = base.split(`/${value}`).join(`/:${name}`);
  }
  base = base.replace(STORE_SEGMENT, '/store/:workspaceId').replace(WORKSPACE_SEGMENT, '/workspaces/:workspaceId').replace(UUID, ':id');
  const path = req.route.path === '/' ? '' : req.route.path;
  return `${base}${path}` || '/';
}

function sameKey(given, key) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function mayReadTiming(req) {
  const key = env.requestTiming.key;
  const given = req.headers['x-timing-key'];
  if (key && given && sameKey(given, key)) return true;
  return Boolean(req.user && req.user.platformRole);
}

function requestTiming(req, res, next) {
  if (!env.requestTiming.enabled) return next();
  const started = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;

  const writeHead = res.writeHead;
  res.writeHead = function writeHeadWithTiming(...args) {
    if (mayReadTiming(req)) res.setHeader('Server-Timing', `app;dur=${elapsed().toFixed(1)}`);
    return writeHead.apply(this, args);
  };

  res.once('finish', () => {
    const ms = elapsed();
    if (ms < env.requestTiming.logMinMs) return;
    logger.info(`[timing] ${req.method} ${routeOf(req)} ${res.statusCode} ${Math.round(ms)}ms`, { requestId: req.id });
  });
  return next();
}

module.exports = { requestTiming, routeOf, mayReadTiming };
