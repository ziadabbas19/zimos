'use strict';

const crypto = require('crypto');
const net = require('net');
// Counters are shared through Redis when RATE_LIMIT_REDIS and REDIS_URL are set (rateLimitStore.js).
const rateLimit = require('./rateLimitStore').withSharedStore(require('express-rate-limit'));
const { ipKeyGenerator } = require('express-rate-limit');
const env = require('../../config/env');
const { RateLimitError } = require('../errors/AppError');
const { clientIp } = require('./clientIp');
const { normalizePhone } = require('../utils/phone');
const { verifyAccessToken } = require('../security/tokens');

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

// Signed-in staff are counted per user: a confirmation team working from one
// office connection would otherwise share a single budget. The token is
// verified, so a forged one cannot pick its own bucket; no token, or an
// invalid or expired one, is counted by IP as before.
function userOrIpKey(req) {
  const [scheme, token] = String(req.headers.authorization || '').split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      const { sub } = verifyAccessToken(token);
      if (sub) return `user:${sub}`;
    } catch (err) {
      // Not a valid access token: counted by IP below.
    }
  }
  return ipKeyGenerator(clientIp(req));
}

const generalLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  // The public storefront API is limited per shopper by storefrontLimiter,
  // which marks the requests it handled. Counting them again here, by IP,
  // would put every shopper behind our storefront server back in one bucket.
  skip: (req) => skip() || req.rateLimitScope === 'storefront' || req.rateLimitScope === 'carrier_webhook' || req.rateLimitScope === 'payment_webhook' || req.rateLimitScope === 'delivery_webhook',
  // Per signed-in user, else the client IP (core/middleware/clientIp.js).
  keyGenerator: userOrIpKey,
  handler,
});

/*
 * Tighter limit for auth endpoints (brute-force protection), keyed by IP and,
 * where the request names an account, by IP + that account, so one attacker
 * hammering one account is throttled apart from the rest of that IP.
 *
 * The account is read from the body before validation has run, so it is
 * treated as untrusted text: `identifier` first, as the sign-in lookup reads
 * it, else `email`; a string only; cut to 320 characters; trimmed and
 * lower-cased, as the account lookup is; then hashed. One account is one
 * bucket however it is spelled, a value of any size costs a fixed-length key,
 * and anything that is not a string names no bucket of its own — the request
 * is counted on the IP's.
 *
 * The caller still chooses which account to name, so this limit alone does not
 * bound one IP naming a new account each time: the routes that need that bound
 * also mount an IP-only limiter (loginIpLimiter, authIpLimiter, below).
 */
const AUTH_ACCOUNT_MAX_LENGTH = 320;

function authAccountKey(req) {
  const named = req.body && (req.body.identifier || req.body.email);
  if (typeof named !== 'string') return '';
  const account = named.slice(0, AUTH_ACCOUNT_MAX_LENGTH).trim().toLowerCase();
  return account ? sha256(account).toString('hex').slice(0, 32) : '';
}

function createAuthLimiter({ windowMs, max, skip: skipAll = () => false }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipAll,
    keyGenerator: (req) => `${ipKeyGenerator(clientIp(req))}:${authAccountKey(req)}`,
    handler,
  });
}

const authLimiter = createAuthLimiter({ windowMs: env.rateLimit.windowMs, max: env.rateLimit.authMax, skip });

/*
 * Public storefront API (/api/v1/store/*): who counts as one shopper?
 *
 * Our Next.js storefront renders store pages on its own server, so those API
 * calls all arrive from the storefront's IP, while cart/checkout calls come
 * straight from the shopper's browser. Keying on the client IP alone would put
 * every shopper of every store behind a single bucket. The shopper is
 * identified by the first of these that applies, most trusted first:
 *
 * 1. X-Storefront-Client-IP, honoured ONLY when the same request carries an
 *    X-Storefront-Secret equal to STOREFRONT_PROXY_SECRET. Trust: high. The
 *    secret lives only in the storefront server's environment and is compared
 *    in constant time, so a browser cannot choose this IP. X-Forwarded-For,
 *    X-Real-IP and CF-Connecting-IP are deliberately not used for this: our
 *    hosting edge rewrites or appends to them (and its documented behaviour has
 *    changed over time), their leftmost entry is whatever the client sent, and
 *    CF-Connecting-IP names the visitor, not our storefront — none of them can
 *    prove the value came from our storefront.
 *
 * 2. The client IP, clientIp(req) (core/middleware/clientIp.js): req.ip as
 *    Express derives it with `trust proxy` = 1 (the single hop our hosting edge
 *    reports), or with TRUST_EDGE_CLIENT_IP on, Cloudflare's CF-Connecting-IP
 *    when the request proves it crossed Cloudflare. Trust: medium. The client
 *    cannot pick it, but many shoppers can share it (mobile carrier NAT, offices).
 *
 * 3. X-Cart-Token (the 48-hex-char token cartService issues), only ever
 *    combined with the client IP, never on its own. Trust: low — the client
 *    chooses it — so it just splits shoppers who share an IP. Rotating tokens to
 *    dodge the limit is capped by the per-IP ceiling below.
 *
 * Every request then passes two limiters:
 *   - visitor:    RATE_LIMIT_MAX per shopper as identified above;
 *   - connection: a ceiling per client IP — STOREFRONT_IP_RATE_LIMIT_MAX normally,
 *     STOREFRONT_SERVER_RATE_LIMIT_MAX for our storefront server (valid secret,
 *     or a client IP listed in STOREFRONT_SERVER_IP). The server's own calls that
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
  const connectionIp = parseIp(clientIp(req));
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

/*
 * Analytics beacons (POST /store/:workspaceId/events) go through the same
 * limiter with the same limits and the same shopper identification, but are
 * counted in buckets of their own. A browser sends them without an
 * X-Cart-Token, so they would otherwise share the per-IP bucket (and the
 * connection ceiling) with every shopper behind that IP, and a busy
 * carrier-NAT address could see its cart and checkout calls refused because
 * of page views. Tracking must never be what stops a checkout.
 */
const EVENTS_PATH = /^\/[^/]+\/events\/?$/;

function createStorefrontLimiter({ windowMs, visitorMax, ipMax, serverMax, secret, serverIps = [], skip: skipAll = () => false }) {
  const trust = { secretDigest: secret ? sha256(secret) : null, serverIps: buildIpList(serverIps) };

  const resolve = (req, res, next) => {
    req.rateLimitScope = 'storefront';
    const client = resolveStorefrontClient(req, trust);
    if (EVENTS_PATH.test(req.path || '')) {
      if (client.visitorKey) client.visitorKey = `events:${client.visitorKey}`;
      client.connectionKey = `events:${client.connectionKey}`;
    }
    req.storefrontClient = client;
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

/*
 * The storefront search box's suggestions (GET /store/:id/products/suggest)
 * are asked for while the shopper types, so they get a bucket of their own —
 * a minute and an hour — on top of the storefront limiter every /store
 * request already passed. Keyed on the shopper as that limiter identified
 * them (req.storefrontClient), falling back to the connection: our own
 * storefront server never calls this, browsers do. A debounced search box
 * sends a few requests per second at most while typing, so the minute limit
 * is generous for a person and tight for a scraper walking the catalogue.
 */
function createSuggestLimiter({ minuteMax, hourMax, skip: skipAll = () => false }) {
  const key = (req) => {
    const client = req.storefrontClient;
    const who = (client && (client.visitorKey || client.connectionKey)) || `ip:${ipKeyGenerator(clientIp(req) || '')}`;
    return `suggest:${who}`;
  };
  const bucket = (windowMs, limit, standardHeaders, prefix) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders,
      legacyHeaders: false,
      skip: skipAll,
      keyGenerator: (req) => `${prefix}:${key(req)}`,
      handler,
    });
  return [bucket(60 * 1000, minuteMax, true, 'm'), bucket(60 * 60 * 1000, hourMax, false, 'h')];
}

const suggestLimiter = createSuggestLimiter({
  minuteMax: env.rateLimit.suggestMinuteMax,
  hourMax: env.rateLimit.suggestHourMax,
  skip,
});

/*
 * Shoppers' photo uploads (POST /store/:id/uploads): the most expensive public
 * request we serve — up to 15 MB in, then decoded and re-encoded — so it gets
 * its own buckets on top of the storefront limiter: per connecting IP and per
 * visitor id (X-Visitor-Id), each by the minute and by the hour. The visitor
 * id is the client's to choose, so its buckets only split shoppers behind one
 * IP; rotating ids to dodge them still hits the IP buckets. The per-visitor
 * cap on photos waiting for an order lives in the upload service.
 */
const VISITOR_HEADER_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function createUploadLimiter({ ipPerMinute, ipPerHour, visitorPerMinute, visitorPerHour, skip: skipAll = () => false }) {
  const ipKey = (req) => `upload-ip:${ipKeyGenerator(parseIp(clientIp(req)) || clientIp(req) || 'unknown')}`;
  const visitorKey = (req) => {
    const id = req.headers['x-visitor-id'];
    return typeof id === 'string' && VISITOR_HEADER_PATTERN.test(id) ? `upload-visitor:${id}` : null;
  };
  const bucket = (windowMs, limit, keyGenerator, standardHeaders, skipWhen = () => false) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders,
      legacyHeaders: false,
      skip: (req) => skipAll(req) || skipWhen(req),
      keyGenerator,
      handler,
    });
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  return [
    // The visitor's own buckets first: a shopper over their limit never uses
    // up the IP budget everyone behind that address shares.
    bucket(MINUTE, visitorPerMinute, (req) => `m:${visitorKey(req)}`, true, (req) => !visitorKey(req)),
    bucket(HOUR, visitorPerHour, (req) => `h:${visitorKey(req)}`, false, (req) => !visitorKey(req)),
    bucket(MINUTE, ipPerMinute, (req) => `m:${ipKey(req)}`, false),
    bucket(HOUR, ipPerHour, (req) => `h:${ipKey(req)}`, false),
  ];
}

const uploadLimiter = createUploadLimiter({
  ipPerMinute: env.customerUploads.ipPerMinute,
  ipPerHour: env.customerUploads.ipPerHour,
  visitorPerMinute: env.customerUploads.visitorPerMinute,
  visitorPerHour: env.customerUploads.visitorPerHour,
  skip,
});

/*
 * "Is this username free?" (GET /auth/username-available) answers anyone,
 * signed in or not — it is what the sign-up form asks while the person types.
 * Walked systematically it would say which usernames exist, so it gets tight
 * buckets of its own per connecting IP, by the minute and by the hour: enough
 * for a person trying a few names, not for a list.
 */
function createUsernameCheckLimiter({ minuteMax, hourMax, skip: skipAll = () => false }) {
  const ipKey = (req) => `username-check:${ipKeyGenerator(parseIp(clientIp(req)) || clientIp(req) || 'unknown')}`;
  const bucket = (windowMs, limit, prefix, standardHeaders) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders,
      legacyHeaders: false,
      skip: skipAll,
      keyGenerator: (req) => `${prefix}:${ipKey(req)}`,
      handler,
    });
  return [bucket(60 * 1000, minuteMax, 'm', true), bucket(60 * 60 * 1000, hourMax, 'h', false)];
}

const usernameCheckLimiter = createUsernameCheckLimiter({
  minuteMax: env.rateLimit.usernameCheckMinuteMax,
  hourMax: env.rateLimit.usernameCheckHourMax,
  skip,
});

/*
 * Two public, per-IP buckets of one minute each: the plan list the marketing
 * site and the sign-up form read (GET /plans/public), and the sign-up code
 * endpoints (POST /auth/verify/send, /auth/verify/confirm), whose real limits
 * — per address, per account, per IP per hour and day — are counted in the
 * database by otp/verificationCodeService so they hold across instances.
 */
function createIpMinuteLimiter(prefix, max, { skip: skipAll = () => false } = {}) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipAll,
    keyGenerator: (req) => `${prefix}:${ipKeyGenerator(parseIp(clientIp(req)) || clientIp(req) || 'unknown')}`,
    handler,
  });
}

const publicPlansLimiter = createIpMinuteLimiter('public-plans', env.rateLimit.publicPlansMinuteMax, { skip });
const verifyCodeLimiter = createIpMinuteLimiter('verify-code', env.rateLimit.verifyMinuteMax, { skip });
// Custom domains (modules/domains): each of these asks public DNS, per IP a minute.
const domainAddLimiter = createIpMinuteLimiter('domain-add', 10, { skip });
const domainVerifyLimiter = createIpMinuteLimiter('domain-verify', 20, { skip });
const domainDnsCheckLimiter = createIpMinuteLimiter('domain-dns-check', 30, { skip });
// A shopper's payment screenshot for a store order (manualPayments): a few tries a minute per IP.
const MANUAL_PROOFS_PER_MINUTE = 5;
const manualProofLimiter = createIpMinuteLimiter('manual-payment-proof', MANUAL_PROOFS_PER_MINUTE, { skip });
// The checkout code step (risk/checkoutOtp.js): verify and resend share one budget per IP a minute.
const CHECKOUT_OTP_PER_MINUTE = 10;
const checkoutOtpLimiter = createIpMinuteLimiter('checkout-otp', CHECKOUT_OTP_PER_MINUTE, { skip });
// A shopper's question on a product (modules/productQuestions): it lands in the merchant's inbox.
const productQuestionLimiter = createIpMinuteLimiter('store-product-question', 5, { skip });
// A gift card balance check (modules/giftCards): a code guessed is money.
const giftCardCheckLimiter = createIpMinuteLimiter('store-gift-card-check', 10, { skip });

/*
 * Password reset requests, per IP per hour, keyed on the IP alone (unlike
 * authLimiter, whose key includes the email the caller sends). It answers the
 * same for every address, so a 429 says nothing about whether one is
 * registered; the per-account limit lives in the database and is silent
 * (auth/authService.requestPasswordReset).
 */
function createPasswordResetLimiter({ hourMax, skip: skipAll = () => false }) {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: hourMax,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipAll,
    keyGenerator: (req) => `password-reset:${ipKeyGenerator(parseIp(clientIp(req)) || clientIp(req) || 'unknown')}`,
    handler,
  });
}

const passwordResetLimiter = createPasswordResetLimiter({ hourMax: env.rateLimit.passwordResetHourMax, skip });

/*
 * The second limit on the account endpoints, keyed on the IP alone. On top of
 * authLimiter, not instead of it: authLimiter's key includes the email the
 * caller sends, so a new email on each request meant a new allowance and only
 * the general limit was left. Two counters per IP:
 *   loginIpLimiter  POST /auth/login, failed attempts only
 *                   (skipSuccessfulRequests: a sign-in that works, or that
 *                   answers with a code step, isn't counted);
 *   authIpLimiter   sign-up, password-reset request, resend-verification, a
 *                   phone-verification code and the two-step settings that
 *                   re-check the password, every request.
 * Everyone behind one IP (an office, a mobile carrier's NAT) shares them.
 */
function createAuthIpLimiter({ windowMs, max, failedOnly = false, prefix, skip: skipAll = () => false }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: failedOnly,
    skip: skipAll,
    keyGenerator: (req) => `${prefix}:${ipKeyGenerator(parseIp(clientIp(req)) || clientIp(req) || 'unknown')}`,
    handler,
  });
}

const authIpOptions = { windowMs: env.rateLimit.authIpWindowMs, max: env.rateLimit.authIpMax, skip };
const loginIpLimiter = createAuthIpLimiter({ ...authIpOptions, failedOnly: true, prefix: 'login-ip' });
const authIpLimiter = createAuthIpLimiter({ ...authIpOptions, prefix: 'auth-ip' });

/*
 * Per signed-in account, for a request that costs us something to keep: a
 * payment proof stores an image that a person then has to review. Keyed on
 * the account, not the IP — many merchants can share one IP — and mounted
 * after `authenticate`; a request without a user falls back to its IP.
 */
const PAYMENT_PROOFS_PER_HOUR = 10;

function createUserLimiter({ prefix, windowMs, max, skip: skipAll = () => false }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipAll,
    keyGenerator: (req) =>
      `${prefix}:${req.user && req.user.id ? `user:${req.user.id}` : ipKeyGenerator(parseIp(clientIp(req)) || clientIp(req) || 'unknown')}`,
    handler,
  });
}

const paymentProofLimiter = createUserLimiter({
  prefix: 'payment-proof',
  windowMs: 60 * 60 * 1000,
  max: PAYMENT_PROOFS_PER_HOUR,
  skip,
});

/*
 * Carrier status webhooks (POST /webhooks/carriers/:code/:token). Every
 * merchant's Bosta pushes arrive from Bosta's servers, so a per-IP limit would
 * put all merchants in one bucket; each merchant's webhook token gets its own.
 * Mounted on the /webhooks/carriers prefix, where req.params isn't populated
 * yet, so the token is read from the path. Unknown tokens are still limited
 * (and then 404).
 */
function carrierWebhookKey(req) {
  const [, code = '', token = ''] = (req.path || '').split('/');
  return `carrier-webhook:${code.slice(0, 50)}:${sha256(token).toString('hex').slice(0, 32)}`;
}

const carrierWebhookLimiter = [
  (req, res, next) => {
    req.rateLimitScope = 'carrier_webhook';
    next();
  },
  rateLimit({
    windowMs: env.rateLimit.windowMs,
    limit: env.carriers.webhookRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    skip,
    keyGenerator: carrierWebhookKey,
    handler,
  }),
];

// Payment gateway callbacks: like the courier ones, all from the gateway's
// servers, so limited per merchant webhook token rather than per IP.
function paymentWebhookKey(req) {
  const [, code = '', token = ''] = (req.path || '').split('/');
  return `payment-webhook:${code.slice(0, 50)}:${sha256(token).toString('hex').slice(0, 32)}`;
}

const paymentWebhookLimiter = [
  (req, res, next) => {
    req.rateLimitScope = 'payment_webhook';
    next();
  },
  rateLimit({
    windowMs: env.rateLimit.windowMs,
    limit: env.payments.webhookRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    skip,
    keyGenerator: paymentWebhookKey,
    handler,
  }),
];

// Delivery status webhooks (notifications/deliveryStatus): every event comes from Brevo's or
// Twilio's servers, so limited per provider (the path), not per IP. The limiter runs before the
// signature check, so a request that fails (bad proof, 4xx/5xx) is not counted in that shared
// bucket — junk from anyone cannot use up the provider's budget — and is counted per IP instead,
// which bounds an unverified caller.
const DELIVERY_WEBHOOK_FAILURES_PER_IP = 30;
const deliveryWebhookLimiter = [
  (req, res, next) => {
    req.rateLimitScope = 'delivery_webhook';
    next();
  },
  rateLimit({
    windowMs: env.rateLimit.windowMs,
    limit: DELIVERY_WEBHOOK_FAILURES_PER_IP,
    standardHeaders: false,
    legacyHeaders: false,
    skip,
    skipSuccessfulRequests: true,
    // A 429 from the shared bucket below is not this caller's failure.
    requestWasSuccessful: (req, res) => res.statusCode < 400 || res.statusCode === 429,
    keyGenerator: (req) => `delivery-webhook-failed:${ipKeyGenerator(parseIp(clientIp(req)) || clientIp(req) || 'unknown')}`,
    handler,
  }),
  rateLimit({
    windowMs: env.rateLimit.windowMs,
    limit: env.notifications.statusWebhookRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    skip,
    skipFailedRequests: true,
    keyGenerator: (req) => `delivery-webhook:${String(req.path || '').slice(0, 40)}`,
    handler,
  }),
];

module.exports = {
  generalLimiter,
  deliveryWebhookLimiter,
  carrierWebhookLimiter,
  paymentWebhookLimiter,
  paymentWebhookKey,
  carrierWebhookKey,
  authLimiter,
  createAuthLimiter,
  storefrontLimiter,
  createStorefrontLimiter,
  trackingLimiter,
  createTrackingLimiter,
  suggestLimiter,
  createSuggestLimiter,
  uploadLimiter,
  createUploadLimiter,
  MANUAL_PROOFS_PER_MINUTE,
  manualProofLimiter,
  CHECKOUT_OTP_PER_MINUTE,
  checkoutOtpLimiter,
  productQuestionLimiter,
  giftCardCheckLimiter,
  usernameCheckLimiter,
  createUsernameCheckLimiter,
  publicPlansLimiter,
  verifyCodeLimiter,
  domainAddLimiter,
  domainVerifyLimiter,
  domainDnsCheckLimiter,
  createIpMinuteLimiter,
  passwordResetLimiter,
  createPasswordResetLimiter,
  loginIpLimiter,
  authIpLimiter,
  createAuthIpLimiter,
  PAYMENT_PROOFS_PER_HOUR,
  paymentProofLimiter,
  createUserLimiter,
};
