'use strict';

require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    // Fail fast at boot rather than deep inside a request handler.
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
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
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    name:
      process.env.NODE_ENV === 'test'
        ? process.env.DB_NAME_TEST || 'zimos_test'
        : required('DB_NAME', 'zimos_dev'),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    ssl: process.env.DB_SSL === 'true',
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
  },

  notifications: {
    emailProvider: process.env.EMAIL_PROVIDER || 'console',
    smsProvider: process.env.SMS_PROVIDER || 'console',
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

  payments: {
    defaultProvider: process.env.PAYMENTS_DEFAULT_PROVIDER || 'mock',
  },

  webhooks: {
    signingAlgo: process.env.WEBHOOK_SIGNING_ALGO || 'sha256',
  },
};

module.exports = env;
