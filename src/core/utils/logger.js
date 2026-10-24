'use strict';

const env = require('../../config/env');
const requestContext = require('./requestContext');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

// Production logs info and up. Under NODE_ENV=test the default is warn so a
// suite run isn't buried in info/debug lines; LOG_LEVEL overrides it there.
// Level filtering happens inside log(), so jest.spyOn(logger, 'info') etc.
// still sees every call.
function resolveLevel() {
  if (env.isProduction) return LEVELS.info;
  if (env.isTest) {
    const override = LEVELS[String(process.env.LOG_LEVEL || '').trim().toLowerCase()];
    return override ?? LEVELS.warn;
  }
  return LEVELS.debug;
}

const currentLevel = resolveLevel();

// Secrets/PII that must never be written to logs even if accidentally passed in `meta`.
const REDACT_KEYS = new Set([
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cardNumber',
  'cvv',
  'secret',
  'apiSecret',
  // Gateway credentials and signatures.
  'secretKey',
  'apiKey',
  'hmacSecret',
  'hmac',
  'signature',
  'credentials',
  // Fawaterak (billing/fawaterak): OAuth fields as the API names them, and
  // the webhook signatures and legacy key field.
  'clientSecret',
  'client_secret',
  'access_token',
  'refresh_token',
  'hashKey',
  'transactionHashKey',
  'api_key',
  // Webhook endpoints' signing secrets, in clear or sealed (webhooks/signingSecretStore.js).
  'signingSecret',
  'signingSecretSealed',
  'signing_secret',
  'signing_secret_sealed',
]);

function redact(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = Array.isArray(meta) ? [] : {};
  for (const [key, value] of Object.entries(meta)) {
    if (REDACT_KEYS.has(key)) {
      out[key] = '[REDACTED]';
    } else if (value && typeof value === 'object') {
      out[key] = redact(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function log(level, message, meta) {
  if (LEVELS[level] > currentLevel) return;
  // The request or job this line belongs to (core/utils/requestContext).
  const context = requestContext.current();
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(context ? context : {}),
    ...(meta ? { meta: redact(meta) } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

module.exports = {
  error: (message, meta) => log('error', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  info: (message, meta) => log('info', message, meta),
  debug: (message, meta) => log('debug', message, meta),
};
