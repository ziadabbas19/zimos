'use strict';

const env = require('../../../config/env');
const { AppError, RateLimitError } = require('../../../core/errors/AppError');
const { clientIp } = require('../../../core/middleware/clientIp');
const { getLocation } = require('../clientDetect');
const { LIMITS, guardEnabled, originMode } = require('./guardConfig');
const { classify } = require('./botClassifier');
const { checkOrigin } = require('./originCheck');
const { createWindowCounter } = require('./windowCounter');
const { hashIp, ipKey } = require('./ipHash');
const counters = require('./trafficCounters');

/**
 * The guard in front of POST /store/:workspaceId/events (TRAFFIC_GUARD_ENABLED;
 * off, every step below passes straight through and the route behaves as it
 * always has). In order:
 *
 *  1. screen     a known bot is answered 202 { accepted: 0, bot: true } — what
 *                it always got — and only counted (traffic_filter_days, by
 *                family: googlebot, curl, …); then the Origin check
 *                (TRAFFIC_ORIGIN_CHECK: report counts, enforce refuses with 403).
 *  2. validated  the route's Joi validation, with a refused body counted.
 *  3. limit      events per minute per visitor, per IP and per store
 *                (guardConfig LIMITS): past one of them 429 with Retry-After,
 *                nothing stored, nothing counted against the other two.
 *
 * Counting never writes per request (trafficCounters flushes every 15 s), so
 * a flood of refused requests costs memory, not database writes. Whatever is
 * refused here never reaches storefrontEventsService or the ad pixel relay.
 *
 * The request's country for these counts comes from the CDN header only when
 * ANALYTICS_GEO_HEADERS trusts that CDN, as everywhere else.
 */

const limiter = createWindowCounter({ windowMs: LIMITS.WINDOW_MS });

const countryOf = (req) => getLocation((name) => req.get(name), env.analytics.geoHeaders).country || '';
const eventCount = (body) => (body && Array.isArray(body.events) ? Math.min(body.events.length, LIMITS.MAX_EVENTS_PER_REQUEST) : 1) || 1;

async function screen(req, res, next) {
  if (!guardEnabled()) return next();
  try {
    const workspaceId = req.tenant.workspaceId;
    const country = countryOf(req);
    req.trafficGuard = { country };

    const bot = classify(req.get('user-agent'));
    if (bot.bot) {
      counters.recordFiltered({
        workspaceId,
        kind: 'bot',
        reason: bot.good ? 'good_bot' : 'bad_bot',
        label: `${bot.kind}:${bot.label}`,
        country,
        count: eventCount(req.body),
      });
      return res.status(202).json({ accepted: 0, bot: true });
    }

    const mode = originMode();
    if (mode !== 'off') {
      const origin = await checkOrigin(req, workspaceId);
      if (!origin.ok) {
        counters.recordFiltered({
          workspaceId,
          kind: 'rejected',
          reason: mode === 'enforce' ? origin.reason : `${origin.reason}_seen`,
          label: origin.host,
          country,
          count: eventCount(req.body),
        });
        if (mode === 'enforce') {
          return next(new AppError('ORIGIN_NOT_ALLOWED', "Events are accepted from the store's own pages only", 403));
        }
      }
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Wraps the route's validation so a refused body is counted (the 422 itself is unchanged). */
function validated(validator) {
  return (req, res, next) =>
    validator(req, res, (err) => {
      if (err && guardEnabled() && req.tenant) {
        counters.recordFiltered({
          workspaceId: req.tenant.workspaceId,
          kind: 'rejected',
          reason: 'invalid_body',
          country: (req.trafficGuard && req.trafficGuard.country) || '',
          count: 1,
        });
      }
      next(err);
    });
}

async function limit(req, res, next) {
  if (!guardEnabled()) return next();
  try {
    const workspaceId = req.tenant.workspaceId;
    const n = req.body.events.length;
    const ip = clientIp(req);
    const buckets = [
      ['rate_visitor', `v:${workspaceId}:${req.body.visitorId}`, LIMITS.EVENTS_PER_VISITOR_MINUTE],
      ['rate_ip', `i:${ipKey(ip) || 'unknown'}`, LIMITS.EVENTS_PER_IP_MINUTE],
      ['rate_store', `s:${workspaceId}`, LIMITS.EVENTS_PER_STORE_MINUTE],
    ];
    const hit = buckets.find(([, key, max]) => limiter.wouldExceed(key, n, max));
    if (hit) {
      const [reason, key] = hit;
      counters.recordFiltered({
        workspaceId,
        kind: 'rejected',
        reason,
        // Which network is flooding, without its address (ipHash.js).
        label: reason === 'rate_ip' ? (await hashIp(ip)) || '' : '',
        country: req.trafficGuard.country,
        count: n,
      });
      res.set('Retry-After', String(limiter.retryAfter(key)));
      return next(new RateLimitError('Too many analytics events'));
    }
    for (const [, key] of buckets) limiter.add(key, n);
    req.trafficGuard.ip = ip;
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Tests: forget the per-minute counts. */
function reset() {
  limiter.clear();
}

module.exports = { screen, validated, limit, reset };
