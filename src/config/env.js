'use strict';

require('dotenv').config();

const { parseDbUrl } = require('./parseDbUrl');

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    // Fail fast at boot rather than deep inside a request handler.
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** A whole number from the environment within [min, max]; anything else is the default. */
function intInRange(raw, fallback, min, max) {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

// Production must not start on a secret anyone can read in this repository
// (SPEC §3.4): the three keys below have to be set, at least 32 characters
// long, and not one of the placeholders from .env.example / docker-compose.
// Uploads should go to R2 — the local disk of a container is lost on redeploy —
// unless ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true says the disk is a real volume.
// That one is a loud boot error, not a refusal (modules/media/storage).

// A single DATABASE_URL (Railway / Heroku) wins over the separate DB_* vars,
// except under NODE_ENV=test — tests always use the dedicated test database
// so a deploy's DATABASE_URL can never point them at a live one.
const dbUrl = process.env.NODE_ENV === 'test' ? null : parseDbUrl(process.env.DATABASE_URL);

// Checked at boot so a weak value fails the deploy instead of quietly letting
// anyone who guesses it choose their own storefront rate-limit key.
const storefrontProxySecret = (process.env.STOREFRONT_PROXY_SECRET || '').trim();
if (storefrontProxySecret && storefrontProxySecret.length < 32) {
  throw new Error('STOREFRONT_PROXY_SECRET must be at least 32 characters (generate one with `openssl rand -hex 32`)');
}

// The client IP behind Cloudflare (core/middleware/clientIp.js). Both switches
// are off unless set to exactly "true", and always off under NODE_ENV=test (a
// test turns them on at runtime). With TRUST_EDGE_CLIENT_IP on, a header name
// that isn't ours to choose or a secret under 32 characters refuses to start:
// a weak secret would let anyone who guesses it choose their own IP.
const RESERVED_EDGE_HEADERS = new Set([
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-request-id',
  'x-storefront-secret',
  'x-storefront-client-ip',
  'x-cart-token',
]);
const trustEdgeClientIp = process.env.NODE_ENV !== 'test' && process.env.TRUST_EDGE_CLIENT_IP === 'true';
const edgeSecretHeader = (process.env.EDGE_SECRET_HEADER || '').trim().toLowerCase();
const edgeSecret = (process.env.EDGE_SECRET || '').trim();
if (trustEdgeClientIp) {
  if (!/^x-[a-z0-9-]+$/.test(edgeSecretHeader) || RESERVED_EDGE_HEADERS.has(edgeSecretHeader)) {
    throw new Error(
      'EDGE_SECRET_HEADER must name the header Cloudflare adds: "x-" then letters, digits or dashes, and not a header the app already reads (TRUST_EDGE_CLIENT_IP is on)'
    );
  }
  if (edgeSecret.length < 32) {
    throw new Error('EDGE_SECRET must be at least 32 characters while TRUST_EDGE_CLIENT_IP is on (generate one with `openssl rand -hex 32`)');
  }
}

// The secrets the app cannot run without come from the environment and from
// nowhere else: the code holds no fallback value for them, in any environment.
//   production   missing, or JWT_ACCESS_SECRET shorter than 32 characters:
//                refuse to start
//   development  missing: refuse to start (set it in .env, see .env.example)
//   test         the suite sets its own test-only values before anything
//                loads (tests/helpers/testEnv.js); DB_PASSWORD is the local
//                test database's own, from .env
// A value starting with TEST_ONLY_PREFIX is the suite's, and is refused outside
// NODE_ENV=test, so one copied into a real .env can never sign anything. The
// errors name the variable, never its value.
const MIN_SECRET_LENGTH = 32;
const TEST_ONLY_PREFIX = 'test-only-';
const GENERATE_SECRET = `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;
const runningEnv = process.env.NODE_ENV || 'development';
const setItIn = runningEnv === 'production' ? 'the environment' : '.env (see .env.example)';
const isBlank = (value) => typeof value !== 'string' || value.trim() === '';
const secretProblems = [];

// Signs access tokens, and keys every HMAC derived from it: store and payment
// preview tokens, sign-up verification tokens and codes, and shoppers' photo
// links while UPLOAD_URL_SECRET is unset.
const jwtAccessSecret = process.env.JWT_ACCESS_SECRET;
if (isBlank(jwtAccessSecret)) {
  secretProblems.push(
    runningEnv === 'test'
      ? 'JWT_ACCESS_SECRET is not set: under NODE_ENV=test it comes from tests/helpers/testEnv.js (jest setupFiles), never .env'
      : `JWT_ACCESS_SECRET is not set: set it in ${setItIn}. Generate one with: ${GENERATE_SECRET}`
  );
} else if (runningEnv !== 'test' && jwtAccessSecret.startsWith(TEST_ONLY_PREFIX)) {
  secretProblems.push(`JWT_ACCESS_SECRET holds the test suite's value: set a real one in ${setItIn}. Generate one with: ${GENERATE_SECRET}`);
} else if (runningEnv === 'production' && jwtAccessSecret.length < MIN_SECRET_LENGTH) {
  secretProblems.push(
    `JWT_ACCESS_SECRET is shorter than ${MIN_SECRET_LENGTH} characters, which production refuses. Generate one with: ${GENERATE_SECRET}`
  );
}

// From DATABASE_URL or DB_PASSWORD. Not held to MIN_SECRET_LENGTH: the
// database issues it, we don't.
const dbPassword = (dbUrl && dbUrl.password) || process.env.DB_PASSWORD;
if (isBlank(dbPassword)) {
  secretProblems.push(`DB_PASSWORD is not set: set it in ${setItIn}, or give DATABASE_URL a password`);
}

if (secretProblems.length > 0) {
  throw new Error(`Refusing to start (NODE_ENV=${runningEnv}):\n  - ${secretProblems.join('\n  - ')}`);
}

// A comma-separated env var as a list of lower-cased, trimmed entries. Unset
// uses the fallback; set but empty is an empty list. Under NODE_ENV=test the
// fallback always wins, so a dev .env can't change what the suite sees.
function csvList(raw, fallback) {
  const value = raw === undefined || process.env.NODE_ENV === 'test' ? fallback : raw;
  return String(value)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// A whole number of 1 or more from the environment. Unset or blank uses the
// fallback; anything else refuses to start, naming the variable, so a typo
// cannot quietly switch a limit off. Under NODE_ENV=test the fallback always
// wins, so a dev .env can't change what the suite sees.
function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (process.env.NODE_ENV === 'test' || isBlank(raw)) return fallback;
  const value = raw.trim();
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${name} must be a whole number of 1 or more (unset, it is ${fallback})`);
  }
  return Number(value);
}

// A whole number of 0 or more from the environment, for a limit that is off
// until it is set. Unset or blank is 0 (off); anything else refuses to start,
// naming the variable. Under NODE_ENV=test it is always 0: a test that needs
// the limit sets it on the env object at runtime.
function limitOrOff(name) {
  const raw = process.env[name];
  if (process.env.NODE_ENV === 'test' || isBlank(raw)) return 0;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a whole number (0 or unset is off)`);
  return Number(value);
}

// One of a fixed set of words from the environment (lower-cased). Unset or
// blank is the fallback; anything else refuses to start, naming the variable.
// Under NODE_ENV=test it is always the fallback.
function oneOf(name, values, fallback) {
  const raw = process.env[name];
  if (process.env.NODE_ENV === 'test' || isBlank(raw)) return fallback;
  const value = raw.trim().toLowerCase();
  if (!values.includes(value)) throw new Error(`${name} must be one of: ${values.join(', ')} (unset, it is ${fallback})`);
  return value;
}

// SMS_ALLOWED_COUNTRIES as calling codes: each entry a calling code ("20",
// "+966") or the ISO code of a country the platform sells in ("EG", "SA" —
// core/utils/storeCountry). An ISO code with no calling code there refuses to
// start, naming it, so a typo cannot quietly drop a country. Unset or blank is
// an empty list (no restriction). Under NODE_ENV=test it is always empty.
function smsAllowedCallingCodes() {
  const raw = process.env.SMS_ALLOWED_COUNTRIES;
  if (process.env.NODE_ENV === 'test' || isBlank(raw)) return [];
  const { CALLING_CODES } = require('../core/utils/storeCountry');
  const codes = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (/^\+?\d{1,4}$/.test(entry)) return entry.replace(/^\+/, '');
      const code = CALLING_CODES[entry.toUpperCase()];
      if (!/^[A-Za-z]{2}$/.test(entry) || !code) {
        throw new Error(`SMS_ALLOWED_COUNTRIES: "${entry}" is neither a calling code nor one of ${Object.keys(CALLING_CODES).join(', ')}`);
      }
      return code;
    });
  return [...new Set(codes)];
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',

  port: parseInt(process.env.PORT || '4000', 10),
  appUrl: process.env.APP_URL || 'http://localhost:4000',
  apiVersion: process.env.API_VERSION || 'v1',
  platformRootDomain: process.env.PLATFORM_ROOT_DOMAIN || 'zimos.test',

  db: {
    url: process.env.DATABASE_URL || null,
    host: (dbUrl && dbUrl.host) || process.env.DB_HOST || 'localhost',
    port: (dbUrl && dbUrl.port) || parseInt(process.env.DB_PORT || '5432', 10),
    name:
      process.env.NODE_ENV === 'test'
        ? process.env.DB_NAME_TEST || 'zimos_test'
        : (dbUrl && dbUrl.name) || required('DB_NAME', 'zimos_dev'),
    user: (dbUrl && dbUrl.user) || process.env.DB_USER || 'postgres',
    password: dbPassword,
    ssl: dbUrl ? dbUrl.ssl || process.env.DB_SSL === 'true' : process.env.DB_SSL === 'true',
    poolMax: parseInt(process.env.DB_POOL_MAX || '10', 10),
    poolMin: parseInt(process.env.DB_POOL_MIN || '0', 10),
  },

  // Refresh tokens are random strings stored hashed (core/security/tokens.js),
  // so nothing signs with a refresh secret: JWT_REFRESH_SECRET is not read.
  // How long one lasts is session.ttlDays below; JWT_REFRESH_EXPIRES_IN was
  // never read and is gone.
  jwt: {
    accessSecret: jwtAccessSecret,
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  },

  // Sign-in sessions (auth/authService).
  //   ttlDays             SESSION_TTL_DAYS          how long a device stays
  //                       signed in, in days, counted from its last refresh
  //                       (every refresh starts the count again)
  //   consoleTtlDays      SESSION_TTL_DAYS_CONSOLE  the same for an account
  //                       with a platform role (the console's users), in the
  //                       dashboard too: the length goes with the account
  // Each a whole number from 1 to 365; unset or anything else is 30, as
  // before. A new value reaches a session at its next refresh; a device left
  // unused keeps the date it already has.
  //   reuseRotatedOnly    REFRESH_REUSE_ROTATED_ONLY  exactly "true": only a
  //                       refresh token that was rotated away counts as
  //                       replayed and ends every session of the account. One
  //                       whose session was ended on purpose (signed out, a
  //                       password reset, the other devices after a second-step
  //                       change) is refused alone. Off: both end every
  //                       session, as before.
  //   endOthersOnTwoFactorChange  TWO_FACTOR_CHANGE_ENDS_SESSIONS  exactly
  //                       "true": turning the second step on or off ends the
  //                       account's other sessions and keeps the device that
  //                       did it. Off: sessions are left alone, as before.
  // Under NODE_ENV=test the two switches start off; a test sets them.
  session: {
    ttlDays: intInRange(process.env.SESSION_TTL_DAYS, 30, 1, 365),
    consoleTtlDays: intInRange(process.env.SESSION_TTL_DAYS_CONSOLE, 30, 1, 365),
    reuseRotatedOnly: process.env.NODE_ENV !== 'test' && process.env.REFRESH_REUSE_ROTATED_ONLY === 'true',
    endOthersOnTwoFactorChange: process.env.NODE_ENV !== 'test' && process.env.TWO_FACTOR_CHANGE_ENDS_SESSIONS === 'true',
  },


  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/api/v1/auth/google/callback',
  },

  // Where the Google callback sends the browser (with tokens in the query),
  // and the base of the links emailed to merchants (password reset, …).
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  // Whether FRONTEND_URL was set at all: in production the localhost default
  // would email a link nobody can open, so password reset refuses without it.
  frontendUrlConfigured: Boolean((process.env.FRONTEND_URL || '').trim()),

  cors: {
    origins: (process.env.CORS_ORIGINS || 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  rateLimit: {
    // Counters shared through Redis (core/middleware/rateLimitStore.js): only with
    // RATE_LIMIT_REDIS=true and REDIS_URL set; off = counted in each process's memory.
    sharedStoreUrl: process.env.NODE_ENV !== 'test' && process.env.RATE_LIMIT_REDIS === 'true' ? (process.env.REDIS_URL || '').trim() || null : null,
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    authMax: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10', 10),
    // Sign-in, sign-up, password reset and resend-verification, per IP alone,
    // on top of authLimiter (whose key includes the email the caller sends,
    // so a new email meant a new allowance). Sign-in counts failed attempts only.
    authIpMax: parseInt(process.env.AUTH_IP_RATE_LIMIT_MAX || '50', 10),
    authIpWindowMs: parseInt(process.env.AUTH_IP_RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000), 10),
    // Public storefront API only (see core/middleware/rateLimiters.js). Each
    // shopper still gets `max`; these are the ceilings per connecting IP — for
    // everyone sharing one IP (NAT, rotating cart tokens), and for our own
    // storefront server, which fetches on behalf of every shopper.
    storefrontIpMax: parseInt(process.env.STOREFRONT_IP_RATE_LIMIT_MAX || '500', 10),
    storefrontServerMax: parseInt(process.env.STOREFRONT_SERVER_RATE_LIMIT_MAX || '5000', 10),
    // Public order-tracking lookup only (GET /store/:id/orders/track). Keyed on
    // the shopper's phone, not their IP: `trackingMax` is per phone + order
    // number, `trackingPhoneMax` is the ceiling per phone across all the order
    // numbers tried with it. See core/middleware/rateLimiters.js.
    trackingWindowMs: parseInt(process.env.TRACKING_RATE_LIMIT_WINDOW_MS || '600000', 10),
    trackingMax: parseInt(process.env.TRACKING_RATE_LIMIT_MAX || '3', 10),
    trackingPhoneMax: parseInt(process.env.TRACKING_PHONE_RATE_LIMIT_MAX || '30', 10),
    // Storefront search suggestions (GET /store/:id/products/suggest), per
    // shopper: a minute and an hour. See core/middleware/rateLimiters.js.
    suggestMinuteMax: parseInt(process.env.SUGGEST_RATE_LIMIT_PER_MINUTE || '60', 10),
    suggestHourMax: parseInt(process.env.SUGGEST_RATE_LIMIT_PER_HOUR || '1200', 10),
    // "Is this username free?" (GET /auth/username-available), per IP: tight,
    // so the endpoint cannot be used to list who has an account.
    usernameCheckMinuteMax: parseInt(process.env.USERNAME_CHECK_RATE_LIMIT_PER_MINUTE || '20', 10),
    usernameCheckHourMax: parseInt(process.env.USERNAME_CHECK_RATE_LIMIT_PER_HOUR || '200', 10),
    // The public plan list (GET /plans/public), per IP per minute.
    publicPlansMinuteMax: parseInt(process.env.PUBLIC_PLANS_RATE_LIMIT_PER_MINUTE || '60', 10),
    // Sign-up codes (POST /auth/verify/send and /confirm), per IP per minute —
    // on top of the per-address and per-account limits kept in the database
    // (otp/verificationCodeService).
    verifyMinuteMax: parseInt(process.env.VERIFY_RATE_LIMIT_PER_MINUTE || '10', 10),
    // Password reset requests (POST /auth/password-reset/request), per IP per
    // hour — on top of the per-account limit kept in the database (authService).
    passwordResetHourMax: parseInt(process.env.PASSWORD_RESET_RATE_LIMIT_PER_HOUR || '10', 10),
  },

  // The 6-digit codes' ceilings per IP (otp/verificationCodeService), counted
  // in the database over every code sent from one IP: at sign-up, at sign-in
  // while unconfirmed, by the resend button, and to confirm a signed-in
  // account's email. The limits per address and per account, the wait
  // between two codes and the wrong guesses allowed are constants there.
  verificationCodes: {
    ipPerHour: positiveInt('VERIFICATION_CODES_PER_IP_PER_HOUR', 20),
    ipPerDay: positiveInt('VERIFICATION_CODES_PER_IP_PER_DAY', 50),
    smsPerIpPerDay: positiveInt('VERIFICATION_SMS_PER_IP_PER_DAY', 5),
  },

  // Store features that stay off until named here, comma-separated
  // (core/middleware/storeFeatures.js): size_charts, product_questions,
  // stock_alerts, preorders, holiday_mode, url_redirects, product_specs,
  // purchase_limits, gift_options. Empty = all off. Under NODE_ENV=test it
  // is always empty; a test pushes a name onto this list.
  storeFeatures: csvList(process.env.STORE_FEATURES, ''),

  // Two-step sign-in (auth/twoFactorService) and the new-device checks
  // (auth/newDeviceSignIn). Each exactly "true" to turn on; off, sign-in is
  // as before. Under NODE_ENV=test they start off; a test sets them.
  //   twoFactor.enabled  TWO_FACTOR_ENABLED  the security settings' second
  //                      step (email, WhatsApp or authenticator code, backup
  //                      codes, remembered browsers, the console's reset)
  //   newDevice.code     NEW_DEVICE_CODE     a password sign-in from a browser
  //                      new to the account is asked for an email code
  //   newDevice.alert    NEW_DEVICE_ALERT    an email when a sign-in finishes
  //                      on a browser new to the account
  twoFactor: {
    enabled: process.env.NODE_ENV !== 'test' && process.env.TWO_FACTOR_ENABLED === 'true',
  },
  newDevice: {
    code: process.env.NODE_ENV !== 'test' && process.env.NEW_DEVICE_CODE === 'true',
    alert: process.env.NODE_ENV !== 'test' && process.env.NEW_DEVICE_ALERT === 'true',
  },

  // A storefront checkout, shipping quote or coupon preview that names a
  // funnel must name a published funnel of this store that sells those lines
  // (funnels/funnelCheckout.js). Exactly "true" turns it on; off, a funnelId
  // is taken as before. Under NODE_ENV=test it starts off; a test sets it.
  funnelCheckout: {
    guard: process.env.NODE_ENV !== 'test' && process.env.FUNNEL_CHECKOUT_GUARD === 'true',
  },

  // Every SMS the platform pays for goes through notifications/notify.sms:
  // checkout codes, phone verification, sign-up and sign-in codes, shopper
  // sign-in, automations' SMS step, stock alerts.
  //  - SMS_ALLOWED_COUNTRIES: the countries an SMS may go to (calling codes
  //    or ISO codes, smsAllowedCallingCodes above). An SMS to any other
  //    number is not sent and is logged as failed. Unset or empty: any
  //    number, as before.
  //  - SMS_PLATFORM_DAILY_CAP: SMS the platform sends in one UTC day, all
  //    stores and its own codes together; SMS_STORE_DAILY_CAP: SMS sent for
  //    one store in one UTC day (notifications/smsBudget.js, counted in
  //    sms_daily_usage). Past one, the SMS is not sent and is logged as
  //    failed, and the console is told once a day. 0 or unset is off.
  // Under NODE_ENV=test all three are off; a test sets them on this object.
  sms: {
    allowedCallingCodes: smsAllowedCallingCodes(),
    platformDailyCap: limitOrOff('SMS_PLATFORM_DAILY_CAP'),
    storeDailyCap: limitOrOff('SMS_STORE_DAILY_CAP'),
  },

  // Checkout codes (risk/checkoutOtp) one client may have sent, whatever the
  // phone or the store, counted in otp_codes.request_ip so the budget holds
  // across API instances. Past it the checkout, the COD switch and Resend
  // answer 429 OTP_RATE_LIMITED and nothing is sent. 0 or unset is off (no
  // per-client budget, as before): shoppers behind one carrier-grade NAT
  // share an address, so pick a value with the traffic in mind.
  //
  // CHECKOUT_OTP_DELIVERY_GUARD_ENABLED=true (risk/checkoutOtp): a store may
  // switch phone codes on (or ask for one in a rule) only while a channel can
  // deliver them — WhatsApp through the platform number, or SMS that is not
  // the console in production — else 422 OTP_CHANNEL_UNAVAILABLE; and a code
  // that reached the phone on no channel lets the order through, marked
  // otp_unavailable, with an alert to the store, instead of stopping the
  // checkout. Off unless exactly "true": as before. Under NODE_ENV=test it
  // starts off; a test sets it here.
  checkoutOtp: {
    ipPerMinute: limitOrOff('CHECKOUT_OTP_IP_PER_MINUTE'),
    ipPerHour: limitOrOff('CHECKOUT_OTP_IP_PER_HOUR'),
    deliveryGuard: process.env.NODE_ENV !== 'test' && process.env.CHECKOUT_OTP_DELIVERY_GUARD_ENABLED === 'true',
  },

  // COD_SWITCH_RECHECK_ENABLED=true: a shopper switching an online order to
  // cash on delivery (payments/onlinePaymentService.switchToCod) meets each
  // fired rule's own action — block and to_lost refuse, require_otp asks for
  // a code — and the store's "codes for COD orders" setting, as the order
  // would have at checkout as a COD order. Off unless exactly "true": only
  // the store-wide "block" refuses, and no code is asked, as before. Under
  // NODE_ENV=test it starts off; a test sets it here.
  codSwitch: {
    recheck: process.env.NODE_ENV !== 'test' && process.env.COD_SWITCH_RECHECK_ENABLED === 'true',
  },

  // IPV6_PREFIX_RULES_ENABLED=true: the store's IP checks compare IPv6
  // addresses by their /64 (fraud/ipPrefix.js) — the IP blocklist (orders,
  // codes, visits), min_minutes_between_cod_orders_per_ip and the risk
  // score's ip_burst. IPv4 is compared whole either way. Off unless exactly
  // "true": whole addresses, as before. Under NODE_ENV=test it starts off;
  // a test sets it here.
  ipRules: {
    ipv6Prefix: process.env.NODE_ENV !== 'test' && process.env.IPV6_PREFIX_RULES_ENABLED === 'true',
  },

  // VISITOR_GATE_ENABLED=true: a store's visitor blocks act (risk/visitorGate,
  // core/middleware/publicWorkspace). A visitor whose IP is a blocked entry of
  // scope `visit` (the merchant's own, or one "Block and cancel" added), or
  // whose country is in fraud_rules.blocked_countries (only once an IP
  // lookup is connected, IP_INTEL_PROVIDER), gets 423 STORE_UNAVAILABLE on
  // every public store route, as a closed store does. Off unless exactly
  // "true": the blocks are kept but nothing is refused, as before. Under
  // NODE_ENV=test it starts off; a test sets it here.
  visitorGate: {
    enabled: process.env.NODE_ENV !== 'test' && process.env.VISITOR_GATE_ENABLED === 'true',
  },

  // Phone-verification codes (POST /auth/verify-phone/request) one client
  // (an IPv6 /56) may have sent in 24 hours, whatever the accounts asking,
  // counted in otp_codes.request_ip. Past it the request answers 429
  // OTP_RATE_LIMITED and nothing is sent. 0 or unset is off: each account
  // keeps its own 5 a day, as before. Under NODE_ENV=test it is off.
  verifyPhone: {
    ipPerDay: limitOrOff('VERIFY_PHONE_PER_IP_PER_DAY'),
  },

  // Public endpoints that stay closed until their identity checks are
  // stronger. Exactly "true" opens one. Under
  // NODE_ENV=test they start off whatever the .env says; a test that needs
  // one sets it on this object at runtime.
  //   reviews.publicSubmissionEnabled  POST /store/:id/products/:productId/reviews
  //                                    (it trusts a phone number alone)
  //   passwordReset.smsEnabled         POST /auth/password-reset/sms/request and
  //                                    /confirm (the dashboard has no screen for it)
  reviews: {
    publicSubmissionEnabled: process.env.NODE_ENV !== 'test' && process.env.REVIEWS_PUBLIC_SUBMISSION_ENABLED === 'true',
  },
  passwordReset: {
    smsEnabled: process.env.NODE_ENV !== 'test' && process.env.PASSWORD_RESET_SMS_ENABLED === 'true',
  },

  // Combos: different products sold together at one price (modules/combos).
  // Off unless PRODUCT_COMBOS_ENABLED is exactly "true": every combo route
  // answers 404, the storefront gets no combos and a checkout naming one is
  // refused, as before they existed. Under NODE_ENV=test it starts off; a
  // test that needs it sets it here.
  combos: {
    enabled: process.env.NODE_ENV !== 'test' && process.env.PRODUCT_COMBOS_ENABLED === 'true',
  },

  // The prepaid balance and the pay-per-order plan (billing/walletService).
  // Off unless exactly "true"; off charges no order fee, offers no plan with
  // a fee and takes no top-up, as before it existed. Under NODE_ENV=test it
  // starts off whatever the .env says; a test that needs it sets it here.
  wallet: {
    enabled: process.env.NODE_ENV !== 'test' && process.env.WALLET_ENABLED === 'true',
    // Refunds of the prepaid balance (billing/walletRefundService). Each paid
    // top-up gives back at most this share of itself (basis points, 7500 =
    // 75%); a request takes from the newest top-ups first (or oldest_first);
    // and asks for at least this much (minor units, 5000 = EGP 50).
    // A move's charge left unpaid this long is voided by the hourly billing
    // job (billing/merchantPlansService.expirePendingMoves).
    moveExpiryHours: intInRange(process.env.WALLET_MOVE_EXPIRY_HOURS, 48, 1, 24 * 90),
    refund: {
      ceilingBp: intInRange(process.env.WALLET_REFUND_CEILING_BP, 7500, 0, 10000),
      allocation: process.env.WALLET_REFUND_ALLOCATION === 'oldest_first' ? 'oldest_first' : 'newest_first',
      minAmount: intInRange(process.env.WALLET_REFUND_MIN_AMOUNT, 5000, 1, 100000000),
    },
  },

  // Locked orders (orders/orderLock.js, billing/confirmFeeService.js). On, a
  // store whose subscription lapsed, or a pay-per-order store that cannot pay
  // the next fee, keeps selling, but its new orders' customer details are
  // hidden until it renews or tops up; the pay-per-order fee is taken once
  // when an order is confirmed instead of when it is placed. Off unless
  // exactly "true"; off, nothing is hidden and the fee is charged as before.
  // Under NODE_ENV=test it starts off whatever the .env says; a test that
  // needs it sets it here.
  ordersLock: {
    enabled: process.env.NODE_ENV !== 'test' && process.env.ORDERS_LOCK_ENABLED === 'true',
  },

  // Plan features as a gate (billing/planFeatureGate): adding a custom domain,
  // inviting a team member and the web analytics are refused (403
  // PLAN_FEATURE_REQUIRED) for a store whose features (plan + console
  // overrides) lack the key. Off unless exactly "true"; off, nothing is
  // refused for a missing feature, as before. Under NODE_ENV=test it starts
  // off whatever the .env says; a test that needs it sets it here.
  planFeatures: {
    enforcement: process.env.NODE_ENV !== 'test' && process.env.PLAN_FEATURE_ENFORCEMENT === 'true',
  },

  // WHATSAPP_REQUIRE_PLAN_FEATURE=true: connecting a WhatsApp number and
  // switching on the ready-made WhatsApp order confirmation need the plan's
  // whatsapp_confirmation — refused only while PLAN_FEATURE_ENFORCEMENT is on
  // too (whatsapp/whatsappPlanGate.js). A number already connected keeps
  // working and can still be edited or disconnected; a rule already switched
  // on keeps running. Off (the default): as before. Under NODE_ENV=test it
  // starts off; a test sets it.
  whatsapp: {
    requirePlanFeature: process.env.NODE_ENV !== 'test' && process.env.WHATSAPP_REQUIRE_PLAN_FEATURE === 'true',
  },

  // Loyalty points (modules/loyalty, loyalty/loyaltyAccess.js). Each off
  // unless exactly "true"; off, the programme works as before. Under
  // NODE_ENV=test they start off; a test sets them.
  //   requirePlanFeature  LOYALTY_REQUIRE_PLAN_FEATURE  with
  //     PLAN_FEATURE_ENFORCEMENT on too: switching the programme on needs the
  //     plan's `loyalty` (403 PLAN_FEATURE_REQUIRED), and a store without it
  //     keeps its customers' points frozen (kept and shown; never earned,
  //     spent or expired).
  //   guard  LOYALTY_GUARD_ENABLED  points frozen while the subscription is
  //     restricted (unpaid past its grace day); a blocked customer neither
  //     earns nor spends; points can't be spent on a device that spent
  //     another customer's points in the last 24 hours.
  loyalty: {
    requirePlanFeature: process.env.NODE_ENV !== 'test' && process.env.LOYALTY_REQUIRE_PLAN_FEATURE === 'true',
    guard: process.env.NODE_ENV !== 'test' && process.env.LOYALTY_GUARD_ENABLED === 'true',
  },

  // GROWTH_REQUIRE_PLAN_FEATURE=true: reviews, the About page's gallery,
  // combos and the coupons' advanced controls need the plan's key of the
  // same name — refused only while PLAN_FEATURE_ENFORCEMENT is on too
  // (billing/growthFeatures.js). Off (the default): as before. Under
  // NODE_ENV=test it starts off; a test sets it.
  growth: {
    requirePlanFeature: process.env.NODE_ENV !== 'test' && process.env.GROWTH_REQUIRE_PLAN_FEATURE === 'true',
  },

  // Account settings (auth/accountService). Changing the phone number by an
  // SMS code is off unless exactly "true": off, a request is answered the
  // same way and nothing is sent or changed.
  account: {
    phoneChangeEnabled: process.env.NODE_ENV !== 'test' && process.env.PHONE_CHANGE_ENABLED === 'true',
  },

  // The platform's public details edited in the console (modules/platformSettings:
  // contact, social links, company, footer, the system emails' sender name and
  // signature). Off unless exactly "true": off, GET /platform-settings/public
  // answers 404 like an unknown path and the emails are sent as before; the
  // console can still edit the values, ready for when it is turned on. Under
  // NODE_ENV=test it starts off; a test flips it on this object.
  platformSettings: {
    enabled: process.env.NODE_ENV !== 'test' && process.env.PLATFORM_SETTINGS_ENABLED === 'true',
  },

  // The AI features (modules/ai, translations/aiFill, risk/aiOrderCheck, the
  // WhatsApp bot). Off unless AI_ENABLED is exactly "true": off, their routes
  // answer as if they did not exist, the bot never replies, the order check
  // does nothing and no provider is ever called. AI_PROVIDER names the
  // provider (modules/ai/providers); empty means the sandbox outside
  // production and none in production. AI_DAILY_LIMIT caps the requests of
  // one store per UTC day (AI jobs and bot replies together; default 50).
  // Under NODE_ENV=test it starts off whatever the .env says; a test that
  // needs it sets it here.
  ai: {
    enabled: process.env.NODE_ENV !== 'test' && process.env.AI_ENABLED === 'true',
    provider: (process.env.AI_PROVIDER || '').trim(),
    dailyLimit: /^\d+$/.test((process.env.AI_DAILY_LIMIT || '').trim()) ? parseInt(process.env.AI_DAILY_LIMIT, 10) : 50,
  },

  // How the backend recognises our own Next.js storefront server. The secret is
  // sent server-to-server only (never to a browser); a request carrying it may
  // forward the shopper's IP for rate limiting. STOREFRONT_SERVER_IP
  // (comma-separated IPs or CIDR ranges) only raises that IP's limit — it never
  // makes a forwarded shopper IP trusted on its own.
  storefrontProxy: {
    secret: storefrontProxySecret,
    serverIps: (process.env.STOREFRONT_SERVER_IP || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  // Where the client IP comes from (core/middleware/clientIp.js): req.ip, or
  // with trustEdge, CF-Connecting-IP on a request that carries Cloudflare's
  // secret header. `debug` logs what each layer said, for every request.
  clientIp: {
    debug: process.env.NODE_ENV !== 'test' && process.env.CLIENT_IP_DEBUG === 'true',
    trustEdge: trustEdgeClientIp,
    edgeHeader: edgeSecretHeader,
    edgeSecret,
  },

  // Under NODE_ENV=test email and SMS are pinned to `console` (as storage is
  // pinned to `local` below) so a dev .env with EMAIL_PROVIDER=brevo or
  // SMS_PROVIDER=twilio can't make the suite send real mail/SMS. A test that
  // wants a real adapter sets env.notifications.*Provider at runtime.
  notifications: {
    emailProvider: process.env.NODE_ENV === 'test' ? 'console' : process.env.EMAIL_PROVIDER || 'console',
    smsProvider: process.env.NODE_ENV === 'test' ? 'console' : process.env.SMS_PROVIDER || 'console',
    whatsappProvider: process.env.WHATSAPP_PROVIDER || 'console',
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      user: process.env.SMTP_USER || '',
      password: process.env.SMTP_PASSWORD || '',
    },
    // Brevo transactional email (only used when EMAIL_PROVIDER=brevo).
    brevo: {
      apiKey: process.env.BREVO_API_KEY || '',
      fromAddress: process.env.EMAIL_FROM_ADDRESS || '',
      fromName: process.env.EMAIL_FROM_NAME || 'Zimos',
      // The secret Brevo's status webhook carries (Bearer token, basic-auth password or ?token=).
      webhookToken: (process.env.BREVO_WEBHOOK_TOKEN || '').trim(),
    },
    // Twilio SMS (only used when SMS_PROVIDER=twilio).
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      fromNumber: process.env.TWILIO_FROM_NUMBER || '',
    },
    // Delivery status and the email suppression list (notifications/deliveryStatus): only the exact
    // value "true" turns them on. This API's public origin, for the statusCallback put on each Twilio
    // SMS (none when unset); the console provider's simulated statuses (never in production); the
    // per-provider rate limit on the status webhooks.
    deliveryStatus: process.env.NODE_ENV !== 'test' && process.env.DELIVERY_STATUS_ENABLED === 'true',
    webhookBaseUrl: (process.env.NOTIFICATIONS_WEBHOOK_BASE_URL || '').trim().replace(/\/+$/, ''),
    simulateStatus: process.env.NODE_ENV !== 'production' && process.env.NOTIFICATION_STATUS_SIMULATION === 'true',
    statusWebhookRateLimitMax: parseInt(process.env.DELIVERY_WEBHOOK_RATE_LIMIT_MAX || '3000', 10),
  },

  // Uploaded-image storage. `local` (default) writes to public/uploads and is
  // fine for local dev; `r2` puts objects in a Cloudflare R2 bucket so images
  // survive a redeploy on an ephemeral filesystem. R2 credentials are only
  // required when STORAGE_PROVIDER=r2. Values are trimmed/lower-cased because
  // dashboard env editors (Railway, etc.) routinely leave a trailing space or
  // newline that would otherwise make "r2 " an unknown provider. Under
  // NODE_ENV=test the provider is pinned to `local` so a stray
  // STORAGE_PROVIDER=r2 in a dev .env can't make the suite hit real R2 (a
  // test that wants r2 sets env.storage.provider at runtime).
  storage: {
    provider:
      process.env.NODE_ENV === 'test'
        ? 'local'
        : (process.env.STORAGE_PROVIDER || 'local').trim().toLowerCase(),
    r2: {
      accountId: (process.env.R2_ACCOUNT_ID || '').trim(),
      accessKeyId: (process.env.R2_ACCESS_KEY_ID || '').trim(),
      secretAccessKey: (process.env.R2_SECRET_ACCESS_KEY || '').trim(),
      bucketName: (process.env.R2_BUCKET_NAME || '').trim(),
      publicUrl: (process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
      // Optional: a bucket with no public access for shoppers' photos. Unset,
      // they go to the media bucket under customer-uploads/ (never linked publicly).
      privateBucketName: (process.env.R2_PRIVATE_BUCKET_NAME || '').trim(),
    },
    // Says the local upload folder is a persistent volume, so production on
    // STORAGE_PROVIDER=local is intended. Off, production on local disk logs
    // an error at every boot and the admin storage tile shows "degraded".
    allowLocalInProduction: process.env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION === 'true',
  },

  // Merchant library images (modules/media/imageProcessing.js): the longest
  // side a stored picture keeps, and the JPEG/WebP quality it is re-encoded
  // at. Pictures of 512px or less (favicons, icons) are never resized or
  // re-compressed. A value out of range falls back to the default.
  media: {
    maxDimension: intInRange(process.env.MEDIA_MAX_DIMENSION, 2000, 256, 10000),
    jpegQuality: intInRange(process.env.MEDIA_JPEG_QUALITY, 85, 40, 100),
  },

  // Photos shoppers attach to an order through a product's custom fields
  // (POST /store/:workspaceId/uploads). See modules/customerUploads.
  customerUploads: {
    // Refused before any processing above this (413).
    maxRawBytes: 15 * 1024 * 1024,
    // Photos one visitor may have waiting for an order at once.
    maxPendingPerVisitor: parseInt(process.env.CUSTOMER_UPLOAD_MAX_PENDING || '10', 10),
    // A photo no order took is deleted after this long.
    pendingTtlHours: parseInt(process.env.CUSTOMER_UPLOAD_TTL_HOURS || '48', 10),
    // How often the server sweeps expired photos; 0 turns the in-process sweep
    // off (scripts/sweep-customer-uploads.js still works). Off under tests.
    sweepMinutes:
      process.env.NODE_ENV === 'test' ? 0 : parseInt(process.env.CUSTOMER_UPLOAD_SWEEP_MINUTES || '30', 10),
    // Upload rate limits, per connecting IP and per visitor id.
    ipPerMinute: parseInt(process.env.CUSTOMER_UPLOAD_IP_PER_MINUTE || '20', 10),
    ipPerHour: parseInt(process.env.CUSTOMER_UPLOAD_IP_PER_HOUR || '120', 10),
    visitorPerMinute: parseInt(process.env.CUSTOMER_UPLOAD_VISITOR_PER_MINUTE || '8', 10),
    visitorPerHour: parseInt(process.env.CUSTOMER_UPLOAD_VISITOR_PER_HOUR || '40', 10),
    // Signs the short-lived links the dashboard shows these photos through.
    // Unset: derived from JWT_ACCESS_SECRET, so it is secret either way.
    urlSecret: (process.env.UPLOAD_URL_SECRET || '').trim(),
    urlTtlSeconds: parseInt(process.env.UPLOAD_URL_TTL_SECONDS || '900', 10),
  },

  payments: {
    defaultProvider: process.env.PAYMENTS_DEFAULT_PROVIDER || 'mock',
    // Online (gateway) checkout on the storefront. Off: the storefront and the
    // public API behave exactly as the COD-only store always has. The
    // dashboard may still connect gateway accounts while it is off.
    onlineEnabled: process.env.PAYMENTS_ONLINE_ENABLED === 'true',
    // Encrypts merchants' gateway keys at rest (AES-256-GCM, see
    // core/utils/credentialsCipher.js): 32 bytes, base64. Separate from
    // CARRIER_CREDENTIALS_KEY. Unset or malformed: every gateway feature
    // answers 503 GATEWAYS_NOT_CONFIGURED; the app still boots.
    credentialsKey: (process.env.GATEWAY_CREDENTIALS_KEY || '').trim(),
    // How long an unpaid online order holds its stock before it expires.
    attemptTtlMinutes: Math.max(5, parseInt(process.env.PAYMENT_ATTEMPT_TTL_MINUTES || '30', 10) || 30),
    // How many payment attempts one order may start (first try + retries).
    maxAttemptsPerOrder: Math.max(1, parseInt(process.env.PAYMENT_MAX_ATTEMPTS_PER_ORDER || '5', 10) || 5),
    // POST /webhooks/payments/:code/:token, per token per window.
    webhookRateLimitMax: parseInt(process.env.PAYMENT_WEBHOOK_RATE_LIMIT_MAX || '300', 10),
    // Failed requests (4xx/5xx) one IP may make to that route per window,
    // whatever tokens it names; past it the IP is refused until the window
    // ends. 0 or unset is off (no such limit, as before): a gateway's servers
    // share their addresses across merchants, so pick it with a disconnected
    // account's retries in mind.
    webhookFailuresPerIp: limitOrOff('PAYMENT_WEBHOOK_FAILURES_PER_IP'),
    // Extra hosts (comma-separated) a shopper may be sent back to after
    // paying, besides the platform's own subdomains and the store's verified
    // custom domains — e.g. the storefront app's own host.
    returnHosts: (process.env.PAYMENT_RETURN_HOSTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    // Where each gateway's API lives. Overridable for a regional account.
    paymobBaseUrl: (process.env.PAYMOB_BASE_URL || 'https://accept.paymob.com').trim().replace(/\/+$/, ''),
    // Kashier: the API host (sessions, inquiry) and the checkout host (refund
    // / void), per mode. A test key only works on the test hosts.
    kashier: {
      testApiUrl: (process.env.KASHIER_TEST_API_URL || 'https://test-api.kashier.io').trim().replace(/\/+$/, ''),
      liveApiUrl: (process.env.KASHIER_LIVE_API_URL || 'https://api.kashier.io').trim().replace(/\/+$/, ''),
      testFepUrl: (process.env.KASHIER_TEST_FEP_URL || 'https://test-fep.kashier.io').trim().replace(/\/+$/, ''),
      liveFepUrl: (process.env.KASHIER_LIVE_FEP_URL || 'https://fep.kashier.io').trim().replace(/\/+$/, ''),
    },
    // Fawaterak as a store gateway (payments/gateways/fawaterak.js). No store
    // sees it — not in the dashboard, not at checkout, not through the API —
    // unless PAYMENTS_FAWATERAK_ENABLED is exactly "true"; then
    // PAYMENTS_FAWATERAK_BETA_WORKSPACES (workspace ids, comma-separated —
    // never slugs, which merchants can change), when set, limits it to those
    // stores. A payment already started through it
    // is still settled with the flag off: that money moved. Under
    // NODE_ENV=test it starts off; a test sets it on this object.
    fawaterak: {
      enabled: process.env.NODE_ENV !== 'test' && process.env.PAYMENTS_FAWATERAK_ENABLED === 'true',
      betaWorkspaces: csvList(process.env.PAYMENTS_FAWATERAK_BETA_WORKSPACES, ''),
    },
  },

  // Shared secret the billing gateway signs its webhook bodies with
  // (HMAC-SHA256, hex, sent as X-Zimos-Signature). Deliberately has no
  // fallback: with nothing configured every webhook is rejected rather than
  // trusted, so a missing value can never become an open endpoint that lets
  // anyone flip a subscription to `active`. See modules/billing/gatewaySignature.js.
  billing: {
    webhookSecret: (process.env.BILLING_WEBHOOK_SECRET || '').trim(),
    // What an unpaid subscription past its grace day does (see
    // workspaces/workspaceAccessService):
    //   enforce  the storefront shows "unavailable" and new products/funnels
    //            are blocked;
    //   warn     the dashboard still shows the expiry banners, nothing is
    //            restricted.
    // Defaults to `warn` in production until merchants have a way to pay —
    // with `enforce`, every store more than a day past its trial with no
    // recorded payment goes unavailable. Tests always enforce. A manual
    // suspension (workspace status) is enforced either way.
    restrictions:
      process.env.NODE_ENV === 'test'
        ? 'enforce'
        : ['enforce', 'warn'].includes(process.env.BILLING_RESTRICTIONS)
          ? process.env.BILLING_RESTRICTIONS
          : process.env.NODE_ENV === 'production'
            ? 'warn'
            : 'enforce',

    // Paying a subscription charge online through Fawaterak
    // (billing/onlineBillingService). ONLINE_BILLING_ENABLED lets a merchant
    // start a payment; it is off unless set to exactly "true". Webhooks and
    // the sweep settle attempts that already exist whenever the keys are set,
    // flag or not: that money moved. Recording a payment by hand works
    // either way.
    online: {
      enabled: process.env.NODE_ENV !== 'test' && process.env.ONLINE_BILLING_ENABLED === 'true',
    },

    // A merchant changing plan by themselves (billing/planSwitchService).
    // PLAN_SWITCH_ENABLED lets them preview and start a switch; it is off
    // unless set to exactly "true", and off the Plans tab is as before (a
    // paid subscription changes plan through support). A switch already made
    // still finishes either way: its charge settles when paid and expires
    // when not, and a scheduled downgrade still takes effect at its moment.
    // PLAN_SWITCH_CHARGE_EXPIRY_HOURS: an upgrade's charge left unpaid this
    // long is voided by the hourly billing job (it was priced for the days
    // that were left when it was asked). Under NODE_ENV=test the switch
    // starts off; a test that needs it sets it here.
    planSwitch: {
      enabled: process.env.NODE_ENV !== 'test' && process.env.PLAN_SWITCH_ENABLED === 'true',
      chargeExpiryHours: intInRange(process.env.PLAN_SWITCH_CHARGE_EXPIRY_HOURS, 48, 1, 24 * 30),
    },

    // Referral codes of the second kind (modules/referrals, migration 725).
    // REFERRAL_CODES_V2_ENABLED, off unless set to exactly "true": the
    // console can give a code limits, an audience, dates, restrictions,
    // schedules and no agent, and link stores to agents by hand; a merchant
    // can enter a code while changing plan; and every code is entered once
    // per account, email and store. Off, codes are created and entered as
    // before (a code of the second kind can't be entered) and a code of the
    // first kind prices as before. What was already entered keeps its terms
    // either way, as a plan switch already made still finishes. Under
    // NODE_ENV=test it starts off; a test that needs it sets it here.
    referralCodesV2: {
      enabled: process.env.NODE_ENV !== 'test' && process.env.REFERRAL_CODES_V2_ENABLED === 'true',
    },

    // Zimos's own Fawaterak account (billing/fawaterak). All secrets except
    // `env`, `baseUrl` and `tokenUrl`, none with a fallback. Under
    // NODE_ENV=test nothing here is read from the environment: a test sets
    // fake values on this object at runtime, so a dev .env holding staging
    // keys can never reach the suite.
    //   env           staging | live — picks the documented base URL
    //   baseUrl       optional override of that URL (https)
    //   tokenUrl      optional; default {baseUrl}/oauth/token, same origin only
    //   clientId / clientSecret   the OAuth client (dashboard → Integrations)
    //   hashKey       the dashboard's "HASH API key": the key Fawaterak's
    //                 webhook signatures are made with
    //   webhookToken  ours, random: a path segment of our webhook URLs
    fawaterak: {
      env: process.env.NODE_ENV === 'test' ? 'staging' : (process.env.FAWATERAK_ENV || 'staging').trim().toLowerCase(),
      baseUrl: process.env.NODE_ENV === 'test' ? '' : (process.env.FAWATERAK_BASE_URL || '').trim(),
      tokenUrl: process.env.NODE_ENV === 'test' ? '' : (process.env.FAWATERAK_TOKEN_URL || '').trim(),
      clientId: process.env.NODE_ENV === 'test' ? '' : (process.env.FAWATERAK_CLIENT_ID || '').trim(),
      clientSecret: process.env.NODE_ENV === 'test' ? '' : (process.env.FAWATERAK_CLIENT_SECRET || '').trim(),
      hashKey: process.env.NODE_ENV === 'test' ? '' : (process.env.FAWATERAK_HASH_KEY || '').trim(),
      webhookToken: process.env.NODE_ENV === 'test' ? '' : (process.env.FAWATERAK_WEBHOOK_TOKEN || '').trim(),
    },
  },

  // Sign-up and go-live rules (modules/auth/signupPolicy.js). Three switches,
  // all off unless set to exactly "true"; off is the behaviour from before
  // they existed, so they can be turned on one at a time after the dashboard
  // that understands them is deployed, and turned off again to go back:
  //   requirePlan          a plan (and the terms) must be chosen at sign-up,
  //                        while at least one plan is public;
  //   requireVerification  a new email/password account signs in only after
  //                        a 6-digit code sent to its email or phone;
  //   requireSubscription  a new store starts as a draft: it can be built but
  //                        not published or sell until a trial or a paid
  //                        subscription starts.
  // Under NODE_ENV=test they start off whatever the .env says; a test that
  // needs one sets it on this object at runtime.
  signup: {
    requirePlan: process.env.NODE_ENV !== 'test' && process.env.REQUIRE_PLAN_AT_SIGNUP === 'true',
    requireVerification: process.env.NODE_ENV !== 'test' && process.env.REQUIRE_SIGNUP_VERIFICATION === 'true',
    requireSubscription: process.env.NODE_ENV !== 'test' && process.env.REQUIRE_SUBSCRIPTION_TO_GO_LIVE === 'true',
    // Draft stores one person may hold while none of their stores is live.
    draftStoresPerUser: Math.max(1, parseInt(process.env.DRAFT_STORES_PER_USER || '1', 10) || 1),
    // Country calling codes a verification SMS may go to (digits, no "+").
    // Anything else is refused, so the SMS channel can't be pointed at premium
    // numbers abroad. Unset: Egypt only.
    smsCountryCodes: csvList(process.env.VERIFICATION_SMS_COUNTRY_CODES, '20').map((c) => c.replace(/^\+/, '')),
    // How a merchant pays while there is no gateway, shown next to the
    // subscribe button. Plain text; empty hides the block.
    paymentInstructions: {
      ar: (process.env.PAYMENT_INSTRUCTIONS_AR || '').trim(),
      en: (process.env.PAYMENT_INSTRUCTIONS_EN || '').trim(),
    },
  },

  // COD confirmation queue. A claim locks a task to one agent for this long;
  // an expired lock returns the task to Pending the next time the queue is
  // read or a task claimed (see modules/cod/confirmationService.js).
  // ORDER_STATUS_GUARDS=true refuses an order status move the stage table
  // (orders/orderStateService.js) does not allow, with 409, on the existing
  // paths too (shipments, cancellation, payments). Off: they move as before;
  // the history is still recorded.
  orderStatusGuards: process.env.ORDER_STATUS_GUARDS === 'true',

  confirmation: {
    lockTtlMinutes: Math.max(1, parseInt(process.env.CONFIRMATION_LOCK_TTL_MINUTES || '15', 10) || 15),
  },

  // Background work (core/queue, core/outbox, src/worker.js), on PostgreSQL.
  // Off by default: the API runs no worker until WORKER_IN_PROCESS=true, or a
  // separate `node src/worker.js` service runs it. Off, events wait in the
  // outbox and jobs in queue_jobs until a worker starts. Never on under
  // NODE_ENV=test: jobs and events run inline there.
  queue: {
    inProcess: process.env.NODE_ENV !== 'test' && process.env.WORKER_IN_PROCESS === 'true',
    pollMs: Math.max(250, parseInt(process.env.QUEUE_POLL_MS || '1000', 10) || 1000),
    concurrency: Math.max(1, parseInt(process.env.QUEUE_CONCURRENCY || '10', 10) || 10),
    // A running job renews its lock; one not renewed for this long had its
    // worker stop and is taken back (core/queue/postgresDriver). 10 minutes, as before.
    staleLockMs: Math.max(10000, parseInt(process.env.QUEUE_STALE_LOCK_MS || '600000', 10) || 600000),
    // QUEUE_CONTROL_CONNECTION=true: the worker claims jobs, renews their
    // locks and takes back stale ones on a database connection of its own (up
    // to two, outside DB_POOL_MAX), so jobs holding the whole shared pool
    // cannot keep their own locks from being renewed. Off (the default): those
    // statements use the shared pool, as before. Never on under NODE_ENV=test.
    controlConnection: process.env.NODE_ENV !== 'test' && process.env.QUEUE_CONTROL_CONNECTION === 'true',
  },

  // Live updates to the dashboard and the console over Socket.IO
  // (modules/realtime). Off unless exactly "true": no socket server is
  // attached, the outbox has no realtime consumer and no event is recorded for
  // it — today's behaviour exactly. On: websocket only (no long polling, which
  // would need sticky sessions), the session checked at the handshake, rooms
  // from the account's memberships and console permissions, messages carrying
  // ids only. Under NODE_ENV=test it starts off; a test flips it on this object.
  //   maxConnectionsPerUser  open sockets and handshakes in progress one account
  //                          may hold on one server. It does not size the
  //                          database's share: whatever it is, at most 3
  //                          handshakes of a process ask the database at once
  //                          (realtimeServer.js HANDSHAKE_CONCURRENCY, a few of
  //                          DB_POOL_MAX's connections), and an account begins
  //                          at most 20 handshakes a minute on a server.
  //   handshakesPerMinute    connection attempts one IP may make a minute, counted
  //                          in each API process's memory: with N processes an IP
  //                          gets N times this. A limit against one noisy client,
  //                          not a defence against many addresses (an IPv6 block
  //                          holds countless): Cloudflare in front is that.
  realtime: {
    enabled: process.env.NODE_ENV !== 'test' && process.env.REALTIME_ENABLED === 'true',
    maxConnectionsPerUser: positiveInt('REALTIME_MAX_CONNECTIONS_PER_USER', 10),
    handshakesPerMinute: positiveInt('REALTIME_HANDSHAKES_PER_MINUTE', 60),
  },

  // Device notifications (Web Push, modules/notifications/push). Off unless
  // PUSH_ENABLED is exactly "true" AND the VAPID pair below is usable
  // (pushConfig.js): off, /me/push answers 404 like an unknown path, the
  // notification settings offer no push column, a refresh and a sign-out never
  // touch push_subscriptions and the daily cleanup does nothing — today's
  // behaviour exactly. On with a missing or malformed pair, push stays off and a
  // warning is logged (the keys themselves never are).
  //   VAPID_PUBLIC_KEY    base64url, 65 bytes: handed to browsers (GET /me/push/config)
  //   VAPID_PRIVATE_KEY   base64url, 32 bytes: a secret, Railway only. Changing the
  //                       pair ends every subscription until each browser subscribes again
  //   VAPID_SUBJECT       mailto:<address> or https://<site>: how push services reach us
  //   maxDevicesPerUser   PUSH_MAX_DEVICES_PER_USER, per account and app; the
  //                       least recently seen goes when one more subscribes
  // Under NODE_ENV=test it starts off with no keys; a test sets them here.
  push: {
    enabled: process.env.NODE_ENV !== 'test' && process.env.PUSH_ENABLED === 'true',
    vapidPublicKey: process.env.NODE_ENV === 'test' ? '' : (process.env.VAPID_PUBLIC_KEY || '').trim(),
    vapidPrivateKey: process.env.NODE_ENV === 'test' ? '' : (process.env.VAPID_PRIVATE_KEY || '').trim(),
    vapidSubject: process.env.NODE_ENV === 'test' ? '' : (process.env.VAPID_SUBJECT || '').trim(),
    maxDevicesPerUser: positiveInt('PUSH_MAX_DEVICES_PER_USER', 10),
  },

  // ALLOW_DEMO_SEED_IN_PRODUCTION=true lets the demo seeder run under
  // NODE_ENV=production. Off (the default) it refuses there: it creates an
  // owner account with a public password, and its `down` empties whole tables.
  // Declared here for the record; the seeder runs under sequelize-cli, outside
  // this file's boot path, and reads the variable itself (db/seedGuards.js).
  seed: {
    allowDemoInProduction: process.env.ALLOW_DEMO_SEED_IN_PRODUCTION === 'true',
  },

  // PAGE_TREE_STRICT_PROPS=true: a page or funnel-step element whose type has
  // a rule set (pages/pageTree.js) is refused when it carries a prop the rules
  // do not name. Off (the default): such a prop is stored unchecked, as
  // before. The rule sets do not yet list every prop the editor sends, so
  // turning this on before they do refuses pages the editor saves today.
  // Under NODE_ENV=test it starts off; a test sets it.
  pages: {
    strictProps: process.env.NODE_ENV !== 'test' && process.env.PAGE_TREE_STRICT_PROPS === 'true',
  },

  // Outbound webhooks to merchants' own systems (modules/webhooks).
  webhooks: {
    signingAlgo: process.env.WEBHOOK_SIGNING_ALGO || 'sha256',
    // WEBHOOKS_IN_PROCESS=true: the API process runs the observer + dispatcher
    // loop itself every intervalMs. Off by default; scripts/dispatch-webhooks.js
    // from a cron service does the same work. Running both is safe, only
    // slower to no purpose. Never on under NODE_ENV=test — the suite drives it by hand.
    inProcess: process.env.NODE_ENV !== 'test' && process.env.WEBHOOKS_IN_PROCESS === 'true',
    intervalMs: Math.max(1000, parseInt(process.env.WEBHOOKS_INTERVAL_MS || '5000', 10) || 5000),
    // A merchant types the URL, and this server then POSTs to it: an address
    // inside our own network (localhost, 10/8, the cloud metadata service…)
    // must never be reachable that way. Allowed outside production only, so a
    // developer can point a webhook at a receiver on their own machine.
    allowPrivateUrls:
      process.env.WEBHOOKS_ALLOW_PRIVATE_URLS !== undefined
        ? process.env.WEBHOOKS_ALLOW_PRIVATE_URLS === 'true'
        : process.env.NODE_ENV !== 'production',
    timeoutMs: Math.max(1000, parseInt(process.env.WEBHOOKS_TIMEOUT_MS || '10000', 10) || 10000),
    batchSize: Math.max(1, parseInt(process.env.WEBHOOKS_BATCH_SIZE || '50', 10) || 50),
    // WEBHOOK_SECRET_SEALING=true: a new or rotated signing secret is stored
    // sealed (AES-256-GCM, core/utils/credentialsCipher) with
    // WEBHOOK_SECRETS_KEY — 32 bytes, base64, its own key like the carriers'
    // and gateways'. Off (the default): stored in clear, as before. A sealed
    // secret is read whatever the flag says (webhooks/signingSecretStore.js).
    // On without a usable key, creating an endpoint or rotating its secret
    // answers 503 WEBHOOK_SECRETS_NOT_CONFIGURED. Under NODE_ENV=test it
    // starts off; a test sets it.
    secretSealing: process.env.NODE_ENV !== 'test' && process.env.WEBHOOK_SECRET_SEALING === 'true',
    secretsKey: (process.env.WEBHOOK_SECRETS_KEY || '').trim(),
    // While rotating the key: the old one, read only (a sealed secret that
    // does not open with WEBHOOK_SECRETS_KEY is tried with it). Empty once
    // scripts/seal-webhook-secrets.js --reseal has moved every row.
    secretsKeyPrevious: (process.env.WEBHOOK_SECRETS_KEY_PREVIOUS || '').trim(),
    // WEBHOOKS_REQUIRE_API_ACCESS=true: adding an endpoint needs the plan's
    // api_access, as minting an API key does — refused only while
    // PLAN_FEATURE_ENFORCEMENT is on too (webhooks/webhookPlanGate.js).
    // Existing endpoints are never touched. Off (the default): as before.
    requireApiAccess: process.env.NODE_ENV !== 'test' && process.env.WEBHOOKS_REQUIRE_API_ACCESS === 'true',
    // Largest delivery body; an event over it is sent with ids only and
    // `truncated: true` (webhooks/webhookPayloadCap.js). Unset (or not a
    // number): 262144 = 256 KB, on by default by decision. 0 turns it off.
    maxPayloadBytes: /^\d+$/.test((process.env.WEBHOOKS_MAX_PAYLOAD_BYTES || '').trim()) ? parseInt(process.env.WEBHOOKS_MAX_PAYLOAD_BYTES, 10) : 262144,
    // Days the delivery log keeps (webhooks/deliveryRetention.js): older ones
    // that are done are deleted once a day. Unset or 0: nothing is deleted.
    deliveryRetentionDays: /^\d+$/.test((process.env.WEBHOOK_DELIVERY_RETENTION_DAYS || '').trim()) ? parseInt(process.env.WEBHOOK_DELIVERY_RETENTION_DAYS, 10) : 0,
  },

  // The order as integrations see it (public API, webhooks) and the pull
  // integrations of tills and kitchens. Each off unless exactly "true"; under
  // NODE_ENV=test each starts off and a test sets it.
  publicApi: {
    // ORDER_PAYLOAD_OPTIONS_ENABLED: order lines carry their menu options
    // (with each choice's external code) and custom-field answers
    // (publicApi/publicOrderOptions.js). Off: the order as before.
    orderOptions: process.env.NODE_ENV !== 'test' && process.env.ORDER_PAYLOAD_OPTIONS_ENABLED === 'true',
    // PUBLIC_API_ACK_ENABLED: the accepted-orders feed, its per-key receipts
    // and the kitchen status (publicApi/acceptedOrdersFeed.js). Off: those
    // routes answer 404, as before they existed.
    ack: process.env.NODE_ENV !== 'test' && process.env.PUBLIC_API_ACK_ENABLED === 'true',
  },

  // Merchant courier accounts (modules/shipping/carriers). The key encrypts
  // the credentials each merchant connects (AES-256-GCM, see
  // core/utils/credentialsCipher.js): 32 bytes, base64. Unset or malformed
  // disables carrier features with a 503 — it never stops the app booting.
  carriers: {
    credentialsKey: (process.env.CARRIER_CREDENTIALS_KEY || '').trim(),
    // POST /webhooks/carriers/:code/:token, per token per window.
    webhookRateLimitMax: parseInt(process.env.CARRIER_WEBHOOK_RATE_LIMIT_MAX || '300', 10),
    // Failed requests (4xx/5xx) one IP may make to that route per window,
    // whatever tokens it names; past it the IP is refused until the window
    // ends. 0 or unset is off (no such limit, as before): a courier's servers
    // share their addresses across merchants, so pick it with a disconnected
    // account's pushes (404) in mind.
    webhookFailuresPerIp: limitOrOff('CARRIER_WEBHOOK_FAILURES_PER_IP'),
    // Which adapters exist on this server (modules/shipping/carriers/index.js).
    // CARRIERS_ENABLED: for every store (unset: bosta; set but empty: none).
    // CARRIERS_BETA: only for the stores whose slugs are in
    // CARRIERS_BETA_WORKSPACES; every other store never sees them.
    enabled: csvList(process.env.CARRIERS_ENABLED, 'bosta'),
    beta: csvList(process.env.CARRIERS_BETA, ''),
    betaWorkspaces: csvList(process.env.CARRIERS_BETA_WORKSPACES, ''),
    // scripts/sync-carrier-shipments.js: shipments per run, and how long a
    // shipment is polled at all after it was booked.
    syncBatchSize: Math.max(1, parseInt(process.env.CARRIER_SYNC_BATCH_SIZE || '200', 10) || 200),
    pollMaxAgeDays: Math.max(1, parseInt(process.env.CARRIER_POLL_MAX_AGE_DAYS || '45', 10) || 45),
  },

  // Storefront analytics (modules/analytics). The event ingest can read a
  // visitor's country/region/city from CDN geo headers, but only from the
  // CDNs named here: this API is not behind a CDN today, so any client could
  // send those headers itself. Unset or empty trusts none and geo is null.
  // Accepted: cloudflare, vercel, cloudfront.
  analytics: {
    geoHeaders: csvList(process.env.ANALYTICS_GEO_HEADERS, ''),
  },

  // Anonymous visits to the marketing site (siteAnalytics/), shown in the
  // console. Off unless exactly "true": POST /public/site-events then answers
  // 404 like an unknown path and sign-up ignores siteSessionId. Under
  // NODE_ENV=test it starts off; a test flips it on this object. Origins is
  // the CORS allowlist for that endpoint only (e.g. https://zimos.co); a
  // request from any other origin is refused.
  siteAnalytics: {
    enabled: process.env.NODE_ENV !== 'test' && process.env.SITE_ANALYTICS_ENABLED === 'true',
    origins: csvList(process.env.SITE_ANALYTICS_ORIGINS, ''),
    // SITE_TRAFFIC_DETAILS_ENABLED (exactly "true"): each visit also keeps its
    // browser, its governorate (Cloudflare's region header, through
    // ANALYTICS_GEO_HEADERS) and which dashboard link a click was; bots and
    // refused requests are counted per day (analytics/traffic); and the
    // console's detailed Site visits endpoints answer. Off: today's behaviour
    // exactly, and those endpoints answer 404. Starts off under NODE_ENV=test.
    detailsEnabled: process.env.NODE_ENV !== 'test' && process.env.SITE_TRAFFIC_DETAILS_ENABLED === 'true',
    // SITE_LIVE_ENABLED (exactly "true"): the console's Live view of zimos.co
    // answers (GET /admin/site-traffic/live, siteAnalytics/siteTrafficLive.js),
    // and each visit also keeps its operating system's family (site_visits.os,
    // migration 709). Off: that endpoint answers 404 and the beacon stores what
    // it did before this switch existed. Apart from SITE_TRAFFIC_DETAILS_ENABLED:
    // without that one, Live shows what every visit keeps (country, source and
    // UTM, device, page) and no governorate, browser or link kind. Starts off
    // under NODE_ENV=test; a test flips it on this object.
    liveEnabled: process.env.NODE_ENV !== 'test' && process.env.SITE_LIVE_ENABLED === 'true',
  },

  // The storefront events guard (analytics/traffic). Off unless exactly
  // "true": POST /store/:id/events behaves as it always has. On: known bots
  // and refused requests are counted per day instead of stored; events per
  // minute are limited per IP, per visitor and per store (429); the same event
  // twice within a second counts once; a visitor faster than a person is kept
  // out of the numbers; and a store stores at most storeDailyCap raw events a
  // UTC day — past it events are only counted, and the console is told once.
  // Under NODE_ENV=test it starts off; a test flips it on this object.
  //   originCheck   off (default) | report: counts requests whose Origin is not
  //                 one of the store's hosts and still stores them | enforce:
  //                 refuses them (403). Read only while the guard is on.
  //   extraOrigins  hosts every store may also send from (the storefront's own
  //                 host, if it ever serves /store/<slug> paths to shoppers).
  trafficGuard: {
    enabled: process.env.NODE_ENV !== 'test' && process.env.TRAFFIC_GUARD_ENABLED === 'true',
    originCheck: oneOf('TRAFFIC_ORIGIN_CHECK', ['off', 'report', 'enforce'], 'off'),
    extraOrigins: csvList(process.env.TRAFFIC_EXTRA_ORIGINS, ''),
    storeDailyCap: positiveInt('TRAFFIC_STORE_DAILY_CAP', 100000),
  },

  // What each visit was, for the visitors screens (analytics/traffic/visitorDetails.js).
  // Off unless exactly "true": the events endpoint stores what it always has.
  // On: the session row keeps its source, UTM, ad click ids (as yes/no only),
  // governorate (from the IP region, then from the shopper's order) and the
  // funnel steps it reached, and page views get their visible time from the
  // tracker's reports. Under NODE_ENV=test it starts off; a test flips it.
  trafficDetails: {
    enabled: process.env.NODE_ENV !== 'test' && process.env.TRAFFIC_DETAILS_ENABLED === 'true',
  },

  // Raw storefront analytics (analytics_events, analytics_sessions) older than
  // this many days are deleted every night, after their days are counted into
  // analytics_daily (analytics/traffic/retention.js). 0 or unset keeps them for
  // ever, as before. The web analytics screens read raw events: with this set,
  // their periods reach this far back only.
  analyticsRawRetentionDays: limitOrOff('ANALYTICS_RAW_RETENTION_DAYS'),

  // zimos.co visits (site_visits) older than this many days are deleted every
  // six hours (siteAnalytics/siteVisitsRetention.js). 0 or unset keeps them for
  // ever, as before. The console's Site traffic pages read these rows, so with
  // this set they reach this far back only. Not ANALYTICS_RAW_RETENTION_DAYS:
  // that one is the stores', and changing it must not change this.
  siteVisitsRetentionDays: limitOrOff('SITE_VISITS_RETENTION_DAYS'),

  // Merchant custom domains (modules/domains). Off unless exactly "true": every
  // dashboard route under /workspaces/:id/domains answers 404 like an unknown
  // path. Domains already verified keep resolving: GET /store/resolve-host and
  // the host resolver are not behind it. Under NODE_ENV=test it starts off; a
  // test flips it on this object.
  // cnameTarget is the one host every merchant domain points its CNAME at (the
  // Cloudflare for SaaS entry, e.g. customers.zimos.co); unset, customers.
  // under PLATFORM_ROOT_DOMAIN. maxPerStore counts every domain of a store,
  // verified or not. resolvers are the public DNS servers verification and
  // the DNS check ask, so a lookup never goes to the host's internal resolver.
  customDomains: {
    enabled: process.env.NODE_ENV !== 'test' && process.env.CUSTOM_DOMAINS_ENABLED === 'true',
    cnameTarget: (
      process.env.CUSTOM_DOMAIN_CNAME_TARGET || `customers.${process.env.PLATFORM_ROOT_DOMAIN || 'zimos.test'}`
    )
      .trim()
      .toLowerCase()
      .replace(/\.$/, ''),
    maxPerStore: positiveInt('CUSTOM_DOMAINS_MAX_PER_STORE', 1),
    // The most orphan hostnames (at Cloudflare, with no domain row) one daily
    // reconciliation run queues for deletion; more than that queues none and
    // logs a warning (modules/domains/domainJobs.js).
    reconcileMax: positiveInt('CUSTOM_DOMAINS_RECONCILE_MAX', 20),
    resolvers: csvList(process.env.DOMAIN_VERIFY_RESOLVERS, '1.1.1.1,8.8.8.8'),
    // Cloudflare for SaaS custom hostnames (domains/certificates/cloudflare.js,
    // CERTIFICATE_PROVIDER=cloudflare). The token needs Zone > SSL and
    // Certificates: Edit on that zone only. Empty under NODE_ENV=test, so a
    // dev .env never reaches the suite; a test sets them here.
    cloudflare: {
      apiToken: process.env.NODE_ENV === 'test' ? '' : (process.env.CLOUDFLARE_API_TOKEN || '').trim(),
      zoneId: process.env.NODE_ENV === 'test' ? '' : (process.env.CLOUDFLARE_ZONE_ID || '').trim(),
    },
  },
};

module.exports = env;
