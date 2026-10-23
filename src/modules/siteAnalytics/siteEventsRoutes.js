'use strict';

const express = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const env = require('../../config/env');
const { AppError, ValidationError } = require('../../core/errors/AppError');
const { createIpMinuteLimiter } = require('../../core/middleware/rateLimiters');
const { notFoundHandler } = require('../../core/middleware/errorHandler');
const { isBot, getLocation } = require('../analytics/clientDetect');
const { classify } = require('../analytics/traffic/botClassifier');
const trafficCounters = require('../analytics/traffic/trafficCounters');
const { hashIp } = require('../analytics/traffic/ipHash');
const { clientIp } = require('../../core/middleware/clientIp');
const siteTraffic = require('./siteTrafficService');

/**
 * POST /api/v1/public/site-events — the marketing site's anonymous beacon
 * (siteTrafficService). app.js mounts it before the API-wide body parser, so
 * this route reads its own small body. Off (env.siteAnalytics.enabled, read
 * per request) the path answers 404 like any unknown one.
 *
 * The client sends text/plain so the browser makes no preflight; CORS headers
 * go only to SITE_ANALYTICS_ORIGINS (core/middleware/cors.js), and a request
 * from any other origin, or with none, is refused here as well.
 *
 * With SITE_TRAFFIC_DETAILS_ENABLED (env.siteAnalytics.detailsEnabled) the
 * store events guard's pieces are used here too (analytics/traffic): bots are
 * classified by family and counted, and every refused request (rate limit,
 * size, origin, body) is counted per day — scope "site" in
 * traffic_filter_days, never stored as a visit. A cta_click may say which link
 * it was (cta: register | login). Off, all of this is skipped exactly.
 */

const MAX_BODY_BYTES = 2 * 1024;
const PER_IP_PER_MINUTE = 120;

const id = Joi.string().pattern(/^[A-Za-z0-9-]{8,64}$/);
const short = Joi.string().trim().max(100).allow('');

// Strict: an unknown key is an error, not dropped (validate() strips them).
const eventSchema = Joi.object({
  visitorId: id.required(),
  sessionId: id.required(),
  event: Joi.string().valid('view', 'ping', 'cta_click').required(),
  path: Joi.string().max(300).pattern(/^\//).required(),
  locale: Joi.string().valid('ar', 'en').optional(),
  referrer: Joi.string().max(500).allow('').optional(),
  utmSource: short.optional(),
  utmMedium: short.optional(),
  utmCampaign: short.optional(),
}).unknown(false);
// The same, with the details on: a cta_click may say which dashboard link it was.
const detailedSchema = eventSchema.keys({ cta: Joi.string().valid('register', 'login').optional() });

const jsonParser = express.json({ limit: MAX_BODY_BYTES, type: ['application/json', 'text/plain'] });

function bodyParser(req, res, next) {
  jsonParser(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') return next(new AppError('PAYLOAD_TOO_LARGE', `Body is larger than ${MAX_BODY_BYTES} bytes`, 413));
    if (err.status >= 400 && err.status < 500) return next(new AppError('INVALID_BODY', 'The request body is not valid JSON', 400));
    return next(err);
  });
}

// Off: the same 404 as an unknown path. Falling through would reach the
// /public API router, which asks for an API key (401) and so would tell a
// caller the path exists.
function enabled(req, res, next) {
  return env.siteAnalytics.enabled ? next() : notFoundHandler(req, res, next);
}

function allowedOrigin(req, res, next) {
  const origin = String(req.get('origin') || '').toLowerCase();
  if (!origin || !env.siteAnalytics.origins.includes(origin)) {
    return next(new AppError('ORIGIN_NOT_ALLOWED', 'This origin may not send site events', 403));
  }
  return next();
}

const countryOf = (req) => getLocation((name) => req.get(name), env.analytics.geoHeaders).country || '';

// Known crawlers are answered as if stored, and nothing is kept. With the
// details on they are classified (good crawler or not) and counted.
function ignoreBots(req, res, next) {
  if (!env.siteAnalytics.detailsEnabled) return isBot(req.get('user-agent')) ? res.status(204).end() : next();
  const bot = classify(req.get('user-agent'));
  if (!bot.bot) return next();
  trafficCounters.recordFiltered({
    scope: 'site',
    kind: 'bot',
    reason: bot.good ? 'good_bot' : 'bad_bot',
    label: `${bot.kind}:${bot.label}`,
    country: countryOf(req),
  });
  return res.status(204).end();
}

function strictBody(req, res, next) {
  const schema = env.siteAnalytics.detailsEnabled ? detailedSchema : eventSchema;
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: false });
  if (error) {
    return next(new ValidationError(error.details.map((d) => ({ field: d.path.join('.'), message: d.message })), 'Invalid body'));
  }
  req.body = value;
  return next();
}

const defaultLimiter = createIpMinuteLimiter('site-events', PER_IP_PER_MINUTE, { skip: () => env.isTest });

const REFUSED = {
  RATE_LIMITED: 'rate_ip',
  PAYLOAD_TOO_LARGE: 'too_large',
  INVALID_BODY: 'invalid_json',
  ORIGIN_NOT_ALLOWED: 'origin_mismatch',
  VALIDATION_ERROR: 'invalid_body',
};

// With the details on, a refused request is counted (per day, by reason, the
// origin's host or the hashed IP as its label) before the usual error answer.
function countRefused(err, req, res, next) {
  const reason = env.siteAnalytics.detailsEnabled && err && REFUSED[err.code];
  if (!reason) return next(err);
  const record = (label = '') => trafficCounters.recordFiltered({ scope: 'site', kind: 'rejected', reason, label, country: countryOf(req) });
  if (reason === 'origin_mismatch') {
    let host = '';
    try {
      host = new URL(String(req.get('origin') || '')).hostname;
    } catch {
      host = '';
    }
    record(host);
    return next(err);
  }
  if (reason === 'rate_ip') {
    return hashIp(clientIp(req)).then(
      (label) => {
        record(label || '');
        next(err);
      },
      () => next(err)
    );
  }
  record();
  return next(err);
}

function createSiteEventsRouter({ limiter = defaultLimiter } = {}) {
  const router = express.Router();
  router.use(enabled);
  router.post(
    '/',
    limiter,
    bodyParser,
    ignoreBots,
    allowedOrigin,
    strictBody,
    asyncHandler(async (req, res) => {
      await siteTraffic.recordEvent(req.body, req);
      res.status(204).end();
    })
  );
  router.use(countRefused);
  return router;
}

module.exports = createSiteEventsRouter();
module.exports.createSiteEventsRouter = createSiteEventsRouter;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
module.exports.PATH = `/api/${env.apiVersion}/public/site-events`;
