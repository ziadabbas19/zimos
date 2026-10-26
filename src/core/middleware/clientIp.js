'use strict';

const crypto = require('crypto');
const net = require('net');
const env = require('../../config/env');
const logger = require('../utils/logger');
const { redactUrl } = require('../utils/redactUrl');

/**
 * The client's IP, worked out once per request by `resolveClientIp` and read
 * everywhere through `clientIp(req)`: the rate limits, the verification-code
 * limits (verification_codes.request_ip), sessions, the audit log and the
 * request log. Nothing else reads req.ip (a test holds that).
 *
 * By default it is req.ip exactly: Express's reading of X-Forwarded-For with
 * `trust proxy` = 1, the one hop our hosting edge adds.
 *
 * TRUST_EDGE_CLIENT_IP (off unless "true"): the API sits behind Cloudflare,
 * which sends the visitor's address as CF-Connecting-IP. Anyone reaching the
 * hosting edge directly can send that header too, so it is believed only when
 * the same request carries the header Cloudflare adds with a Transform Rule —
 * EDGE_SECRET_HEADER with the value EDGE_SECRET, compared in constant time —
 * and only when it holds one valid address. In every other case (no secret, a
 * wrong one, no CF-Connecting-IP, or not an IP) the client IP is req.ip, as
 * with the flag off, and nothing is refused. With the flag on the secret header
 * is removed from req.headers once checked, so nothing after this sees it.
 *
 * CLIENT_IP_DEBUG (off unless "true"): logs, for every request, what each layer
 * said — X-Forwarded-For, CF-Connecting-IP, X-Real-IP and req.ip — and what was
 * chosen and why. Whether the edge secret matched is logged as a word; the
 * secret header, cookies and tokens never are.
 */

const CF_CONNECTING_IP = 'cf-connecting-ip';
const LOGGED_HEADERS = ['x-forwarded-for', 'cf-connecting-ip', 'x-real-ip'];
const MAX_LOGGED_LENGTH = 200;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

let cachedDigest = { secret: null, digest: null };
function digestOf(secret) {
  if (cachedDigest.secret !== secret) cachedDigest = { secret, digest: sha256(secret) };
  return cachedDigest.digest;
}

/** One valid IPv4 or IPv6 address, trimmed, or null. */
function singleIp(value) {
  if (typeof value !== 'string') return null;
  const ip = value.trim();
  return net.isIP(ip) ? ip : null;
}

/** 'match' | 'mismatch' | 'absent', or 'unset' when no header name or secret is configured. */
function edgeSecretState(req, config) {
  if (!config.edgeHeader || !config.edgeSecret) return 'unset';
  const provided = req.headers[config.edgeHeader];
  if (typeof provided !== 'string' || provided === '') return 'absent';
  return crypto.timingSafeEqual(sha256(provided), digestOf(config.edgeSecret)) ? 'match' : 'mismatch';
}

/**
 * What the client IP is for this request, and why:
 * { ip, source: 'proxy' | 'edge', reason }.
 */
function resolve(req, config = env.clientIp) {
  const proxy = (reason) => ({ ip: req.ip, source: 'proxy', reason });
  if (!config.trustEdge) return proxy('off');
  const secret = edgeSecretState(req, config);
  if (secret !== 'match') return proxy(`secret_${secret}`);
  const raw = req.headers[CF_CONNECTING_IP];
  const ip = singleIp(raw);
  if (!ip) return proxy(raw === undefined ? 'cf_ip_absent' : 'cf_ip_invalid');
  return { ip, source: 'edge', reason: 'edge' };
}

function clip(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length > MAX_LOGGED_LENGTH ? `${text.slice(0, MAX_LOGGED_LENGTH)}…` : text;
}

function logDebug(req, result, config) {
  const headers = {};
  for (const name of LOGGED_HEADERS) headers[name] = clip(req.headers[name]);
  logger.info('client ip', {
    requestId: req.id,
    url: redactUrl(req.originalUrl),
    headers,
    reqIp: clip(req.ip),
    // Read even with the flag off, so the Transform Rule can be checked before trusting it.
    edgeSecret: edgeSecretState(req, config),
    trustEdge: config.trustEdge,
    clientIp: clip(result.ip),
    source: result.source,
    reason: result.reason,
  });
}

/** Middleware: works out the client IP once, before anything reads it. */
function resolveClientIp(req, res, next) {
  const config = env.clientIp;
  const result = resolve(req, config);
  req.clientIp = result.ip;
  if (config.debug) logDebug(req, result, config);
  if (config.trustEdge && config.edgeHeader) delete req.headers[config.edgeHeader];
  next();
}

/**
 * The client IP of `req`: what resolveClientIp worked out, or req.ip for a
 * request it did not see (and for the plain { ip } contexts some services
 * build).
 */
function clientIp(req) {
  if (!req) return undefined;
  return Object.prototype.hasOwnProperty.call(req, 'clientIp') ? req.clientIp : req.ip;
}

/**
 * The client IP of a request Express never handled: the HTTP upgrade a
 * websocket opens with (modules/realtime), which goes to the socket server
 * and not through the middleware above. Worked out the same way: Express's
 * own reading of X-Forwarded-For under `app`'s `trust proxy`, then `resolve`.
 */
function clientIpOfUpgrade(raw, app) {
  const view = Object.create(app.request, {
    headers: { value: raw.headers },
    socket: { value: raw.socket },
    connection: { value: raw.socket },
  });
  return resolve(view).ip;
}

module.exports = { resolveClientIp, clientIp, clientIpOfUpgrade, resolve, CF_CONNECTING_IP };
