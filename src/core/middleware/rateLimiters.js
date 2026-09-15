'use strict';

const crypto = require('crypto');
const net = require('net');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const env = require('../../config/env');
const { RateLimitError } = require('../errors/AppError');
const { normalizePhone } = require('../utils/phone');

function handler(req, res, next) {
  next(new RateLimitError());
}

// Rate limiting is disabled in the automated test suite: tests run many
// sequential requests against one long-lived app instance in-process, which
// would otherwise trip these limits regardless of real client behavior. The
// limiter configuration itself (windows, max counts, keying) is still real
// production code exercised manually against the dev server — see the
// project report for how that was verified.
const skip = () => env.isTest;

const generalLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  // The public storefront API is limited per shopper by storefrontLimiter,
  // which marks the requests it handled. Counting them again here, by IP,
  // would put every shopper behind our storefront server back in one bucket.
  skip: (req) => skip() || req.rateLimitScope === 'storefront',
  handler,
});

// Tighter limit for auth endpoints (brute-force protection), keyed by IP + email
// where available so one IP hammering many accounts and one attacker hammering
// one account are both throttled.
const authLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${req.body && req.body.email ? req.body.email : ''}`,
  handler,
});

/*
 * Public storefront API (/api/v1/store/*): who counts as one shopper?
 *
 * Our Next.js storefront renders store pages on its own server, so those API
 * calls all arrive from the storefront's IP, while cart/checkout calls come
 * straight from the shopper's browser. Keying on req.ip alone would put every
 * shopper of every store behind a single bucket. The shopper is identified by
 * the first of these that applies, most trusted first:
 *
 * 1. X-Storefront-Client-IP, honoured ONLY when the same request carries an
 *    X-Storefront-Secret equal to STOREFRONT_PROXY_SECRET. Trust: high. The
 *    secret lives only in the storefront server's environment and is compared
 *    in constant time, so a browser cannot choose this IP. X-Forwarded-For,
 *    X-Real-IP and CF-Connecting-IP are deliberately not used for this: our
 *    hosting edge rewrites or appends to them (and its documented behaviour has
 *    changed over time), their leftmost entry is whatever the client sent, and
 *    this API is not served behind Cloudflare (merchant custom domains are, but
 *    they reach /shop, not this API) — none of them can prove the value came
 *    from our storefront.
 *
 * 2. req.ip, as Express derives it with `trust proxy` = 1 (the single hop our
 *    hosting edge reports). Trust: medium. The client cannot pick it, but many
 *    shoppers can share it (mobile carrier NAT, offices).
 *
 * 3. X-Cart-Token (the 48-hex-char token cartService issues), only ever
 *    combined with req.ip, never on its own. Trust: low — the client chooses
 *    it — so it just splits shoppers who share an IP. Rotating tokens to dodge
 *    the limit is capped by the per-IP ceiling below.
 *
 * Every request then passes two limiters:
 *   - visitor:    RATE_LIMIT_MAX per shopper as identified above;
 *   - connection: a ceiling per req.ip — STOREFRONT_IP_RATE_LIMIT_MAX normally,
 *     STOREFRONT_SERVER_RATE_LIMIT_MAX for our storefront server (valid secret,
 *     or req.ip listed in STOREFRONT_SERVER_IP). The server's own calls that
 *     name no shopper skip the visitor bucket and are bounded by that ceiling
 *     alone, so a gap in IP forwarding degrades to a higher shared limit rather
 *     than stopping every shopper at RATE_LIMIT_MAX. STOREFRONT_SERVER_IP never
 *     makes a forwarded IP trusted: hosting egress IPs are often shared with
 *     other tenants.
 */
const STOREFRONT_SECRET_HEADER = 'x-storefront-secret';
const STOREFRONT_CLIENT_IP_HEADER = 'x-storefront-client-ip';
const CART_TOKEN_PATTERN = /^[0-9a-f]{48}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function ipType(ip) {
  return net.isIPv6(ip) ? 'ipv6' : 'ipv4';
}

/** A bare IP (IPv4-mapped IPv6 unwrapped), or null if the value isn't one. */
function parseIp(value) {
  if (typeof value !== 'string') return null;
  let ip = value.trim();
  if (/^::ffff:/i.test(ip) && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  return net.isIP(ip) ? ip : null;
}

function buildIpList(entries) {
  const list = new net.BlockList();
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split('/');
    const type = net.isIP(address) ? ipType(address) : null;
    const bits = prefix === undefined ? null : /^\d{1,3}$/.test(prefix) ? Number(prefix) : NaN;
    if (!type || extra !== undefined || Number.isNaN(bits) || bits > (type === 'ipv6' ? 128 : 32)) {
      throw new Error(`STOREFRONT_SERVER_IP: "${entry}" is not an IP address or CIDR range`);
    }
    if (bits === null) list.addAddress(address, type);
    else list.addSubnet(address, bits, type);
  }
  return list;
}

function resolveStorefrontClient(req, { secretDigest, serverIps }) {
  const connectionIp = parseIp(req.ip);
  const connection = connectionIp ? ipKeyGenerator(connectionIp) : 'unknown';

  const provided = req.headers[STOREFRONT_SECRET_HEADER];
  const viaSecret =
    Boolean(secretDigest) && typeof provided === 'string' && crypto.timingSafeEqual(sha256(provided), secretDigest);
  const trustedServer = viaSecret || Boolean(connectionIp && serverIps.check(connectionIp, ipType(connectionIp)));

  let visitorKey = null;
  const forwardedIp = viaSecret ? parseIp(req.headers[STOREFRONT_CLIENT_IP_HEADER]) : null;
  if (forwardedIp) {
    visitorKey = `ip:${ipKeyGenerator(forwardedIp)}`;
  } else if (!trustedServer) {
    const cartToken = req.headers['x-cart-token'];
    visitorKey =
      typeof cartToken === 'string' && CART_TOKEN_PATTERN.test(cartToken)
        ? `ip:${connection}:cart:${sha256(cartToken).toString('hex').slice(0, 32)}`
        : `ip:${connection}`;
  }

  return {
    trustedServer,
    visitorKey,
    connectionKey: `${trustedServer ? 'server' : 'ip'}:${connection}`,
  };
}

function createStorefrontLimiter({ windowMs, visitorMax, ipMax, serverMax, secret, serverIps = [], skip: skipAll = () => false }) {
  const trust = { secretDigest: secret ? sha256(secret) : null, serverIps: buildIpList(serverIps) };

  const resolve = (req, res, next) => {
    req.rateLimitScope = 'storefront';
    req.storefrontClient = resolveStorefrontClient(req, trust);
    next();
  };

  // Runs first, so a shopper's rejected requests never use up the shared
  // connection ceiling that everyone else behind the same IP depends on.
  const visitorLimiter = rateLimit({
    windowMs,
    limit: visitorMax,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => skipAll(req) || !req.storefrontClient.visitorKey,
    keyGenerator: (req) => req.storefrontClient.visitorKey,
    handler,
  });

  // No headers: they would overwrite the shopper's own RateLimit-* values.
  const connectionLimiter = rateLimit({
    windowMs,
    limit: (req) => (req.storefrontClient.trustedServer ? serverMax : ipMax),
    standardHeaders: false,
    legacyHeaders: false,
    skip: skipAll,
    keyGenerator: (req) => req.storefrontClient.connectionKey,
    handler,
  });

  return [resolve, visitorLimiter, connectionLimiter];
}

const storefrontLimiter = createStorefrontLimiter({
  windowMs: env.rateLimit.windowMs,
  visitorMax: env.rateLimit.max,
  ipMax: env.rateLimit.storefrontIpMax,
  serverMax: env.rateLimit.storefrontServerMax,
  secret: env.storefrontProxy.secret,
  serverIps: env.storefrontProxy.serverIps,
  skip,
});

/*
 * Public order tracking (GET /store/:workspaceId/orders/track): the shopper
 * identifies themselves with phone + order number, so the limiter is keyed on
 * that rather than on the connection. Keying on IP would be wrong in both
 * directions here — one shopper retrying from mobile data gets a fresh bucket,
 * while everyone behind a shared IP would share one.
 *
 * Two buckets, because either alone leaves a gap:
 *   - combo:  phone + order number, `comboMax` per window. Stops one lookup
 *     being hammered (the guess that's one digit off, a page that retries).
 *   - phone:  the phone alone, `phoneMax` per window. The combo bucket resets
 *     on every new order number, so on its own it puts no limit at all on
 *     walking the order-number space against one phone — which is the
 *     enumeration this endpoint most needs to resist.
 * The combo limiter runs first, so requests it already rejected don't eat into
 * the phone budget the shopper's real lookups depend on.
 *
 * This runs before `validate`, so that a request that will be rejected anyway
 * never reaches the database. That means both values arrive unvalidated and
 * either may be missing or malformed: such a request is skipped rather than
 * counted or rejected — `validate` answers it with a 400 either way, and the
 * storefront limiter's per-IP ceiling above still bounds it.
 */
const TRACKING_PHONE_PATTERN = /^[0-9]{10,15}$/;
const TRACKING_NUMBER_PATTERN = /^[A-Za-z0-9-]{3,40}$/;

/** The shopper's { phone, number } bucket keys, or null if not keyable yet. */
function resolveTrackingKeys(req) {
  const { phone, number } = req.query || {};
  if (typeof phone !== 'string' || typeof number !== 'string') return null;

  const trimmedNumber = number.trim();
  if (!TRACKING_PHONE_PATTERN.test(phone.trim()) || !TRACKING_NUMBER_PATTERN.test(trimmedNumber)) return null;

  // Normalized the same way the lookup itself normalizes them, so a shopper
  // can't be handed a fresh budget just by retyping 01… as 201… or in a
  // different case.
  const normalizedPhone = normalizePhone(phone.trim());
  return normalizedPhone ? { phone: normalizedPhone, number: trimmedNumber.toUpperCase() } : null;
}

function createTrackingLimiter({ windowMs, comboMax, phoneMax, skip: skipAll = () => false }) {
  const resolve = (req, res, next) => {
    req.orderTracking = resolveTrackingKeys(req);
    next();
  };

  const bucket = (limit, keyGenerator, standardHeaders) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders,
      legacyHeaders: false,
      skip: (req) => skipAll(req) || !req.orderTracking,
      keyGenerator,
      handler,
    });

  return [
    resolve,
    bucket(comboMax, (req) => `track:${req.orderTracking.phone}:${req.orderTracking.number}`, true),
    // No headers: they would overwrite the combo bucket's RateLimit-* values,
    // which are the ones this shopper's own retries are measured against.
    bucket(phoneMax, (req) => `track:${req.orderTracking.phone}`, false),
  ];
}

const trackingLimiter = createTrackingLimiter({
  windowMs: env.rateLimit.trackingWindowMs,
  comboMax: env.rateLimit.trackingMax,
  phoneMax: env.rateLimit.trackingPhoneMax,
  skip,
});

module.exports = {
  generalLimiter,
  authLimiter,
  storefrontLimiter,
  createStorefrontLimiter,
  trackingLimiter,
  createTrackingLimiter,
};
