'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { requirePlatformPermission: can } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../core/security/platformPermissions');
const env = require('../../config/env');
const { notFoundHandler } = require('../../core/middleware/errorHandler');
const { GOVERNORATE_CODES } = require('../shipping/governorates');
const siteTraffic = require('./siteTrafficService');
const details = require('./siteTrafficDetails');
const live = require('./siteTrafficLive');

// The console's "Site traffic" page, mounted under /api/v1/admin like the
// rest of the console (after its authenticate). Read-only, not audited, and
// answered whether collection is on or off (the body says which).
const router = Router();

const schemas = {
  summary: {
    query: Joi.object({ range: Joi.string().valid(...Object.keys(siteTraffic.RANGES)).default('today') }),
  },
};

// The detailed Site visits (siteTrafficDetails.js): the same permission as the
// summary above. While SITE_TRAFFIC_DETAILS_ENABLED is off they answer 404,
// like paths that do not exist.
const detailsOn = (req, res, next) => (env.siteAnalytics.detailsEnabled ? next() : notFoundHandler(req, res, next));
const filters = {
  range: Joi.string().valid(...Object.keys(details.RANGES)).default('7d'),
  country: Joi.string().pattern(/^[A-Za-z]{2}$/).uppercase().optional(),
  governorate: Joi.string().valid(...GOVERNORATE_CODES).optional(),
  device: Joi.string().valid('mobile', 'tablet', 'desktop', 'unknown').optional(),
  source: Joi.string().trim().min(1).max(255).optional(),
};
schemas.details = { query: Joi.object(filters) };
schemas.sessions = {
  query: Joi.object({
    ...filters,
    page: Joi.number().integer().min(1).max(10000).default(1),
    pageSize: Joi.number().integer().min(1).max(details.PAGE_MAX).default(25),
    sort: Joi.string().valid(...Object.keys(details.SORTS)).default('recent'),
  }),
};
schemas.session = { params: Joi.object({ sessionId: Joi.string().pattern(/^[A-Za-z0-9-]{8,64}$/).required() }) };
schemas.protection = { query: Joi.object({ range: Joi.string().valid('today', '7d', '30d').default('7d') }) };

router.get(
  '/site-traffic/summary',
  can(P.OVERVIEW_VIEW),
  validate(schemas.summary),
  asyncHandler(async (req, res) => res.json(await siteTraffic.summary(req.query.range)))
);

router.get(
  '/site-traffic/details/summary',
  can(P.OVERVIEW_VIEW),
  detailsOn,
  validate(schemas.details),
  asyncHandler(async (req, res) => res.json(await details.summary(req.query)))
);
router.get(
  '/site-traffic/campaigns',
  can(P.OVERVIEW_VIEW),
  detailsOn,
  validate(schemas.details),
  asyncHandler(async (req, res) => res.json(await details.campaigns(req.query)))
);
router.get(
  '/site-traffic/sessions',
  can(P.OVERVIEW_VIEW),
  detailsOn,
  validate(schemas.sessions),
  asyncHandler(async (req, res) => res.json(await details.sessions(req.query)))
);
router.get(
  '/site-traffic/sessions/:sessionId',
  can(P.OVERVIEW_VIEW),
  detailsOn,
  validate(schemas.session),
  asyncHandler(async (req, res) => res.json(await details.sessionTimeline(req.params.sessionId)))
);
// The Live view: sessions seen in the last five minutes (siteTrafficLive.js).
// The console asks every 15 seconds; behind the same switch as the details.
router.get(
  '/site-traffic/live',
  can(P.OVERVIEW_VIEW),
  detailsOn,
  asyncHandler(async (req, res) => res.json(await live.live()))
);
router.get(
  '/site-traffic/protection',
  can(P.OVERVIEW_VIEW),
  detailsOn,
  validate(schemas.protection),
  asyncHandler(async (req, res) => res.json(await details.protectionSummary(req.query)))
);

module.exports = router;
