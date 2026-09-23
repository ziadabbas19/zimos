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
    password: (dbUrl && dbUrl.password) || process.env.DB_PASSWORD || 'postgres',
    ssl: dbUrl ? dbUrl.ssl || process.env.DB_SSL === 'true' : process.env.DB_SSL === 'true',
    poolMax: parseInt(process.env.DB_POOL_MAX || '10', 10),
    poolMin: parseInt(process.env.DB_POOL_MIN || '0', 10),
  },

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET', 'dev_only_access_secret_change_me_32chars'),
    refreshSecret: required('JWT_REFRESH_SECRET', 'dev_only_refresh_secret_change_me_32chars'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/api/v1/auth/google/callback',
  },

  // Where the Google callback sends the browser (with tokens in the query).
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  cors: {
    origins: (process.env.CORS_ORIGINS || 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    authMax: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10', 10),
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
    },
    // Twilio SMS (only used when SMS_PROVIDER=twilio).
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      fromNumber: process.env.TWILIO_FROM_NUMBER || '',
    },
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
    },
  },

  payments: {
    defaultProvider: process.env.PAYMENTS_DEFAULT_PROVIDER || 'mock',
  },

  // Shared secret the billing gateway signs its webhook bodies with
  // (HMAC-SHA256, hex, sent as X-Zimos-Signature). Deliberately has no
  // fallback: with nothing configured every webhook is rejected rather than
  // trusted, so a missing value can never become an open endpoint that lets
  // anyone flip a subscription to `active`. See modules/billing/gatewaySignature.js.
  billing: {
    webhookSecret: (process.env.BILLING_WEBHOOK_SECRET || '').trim(),
  },

  webhooks: {
    signingAlgo: process.env.WEBHOOK_SIGNING_ALGO || 'sha256',
  },
};

module.exports = env;
