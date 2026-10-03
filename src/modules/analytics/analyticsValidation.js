'use strict';

const Joi = require('joi');

const rangeQuery = Joi.object({
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
});

// --- Web analytics (Umami port) --------------------------------------------
const { FILTER_KEYS, METRIC_TYPES } = require('./webAnalyticsService');

// A filter may be repeated (`?browser=chrome&browser=firefox`) → any match.
const filterValue = Joi.alternatives().try(Joi.string().max(500), Joi.array().items(Joi.string().max(500)).max(50));
const webFilters = Object.fromEntries(FILTER_KEYS.map((k) => [k, filterValue.optional()]));

const webQuery = Joi.object({
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
  compare: Joi.string().valid('prev', 'yoy').optional(),
  unit: Joi.string().valid('minute', 'hour', 'day', 'month').optional(),
  tz: Joi.string().max(64).optional(),
  ...webFilters,
});
const wsParams = Joi.object({ workspaceId: Joi.string().uuid().required() });

// --- Dashboard home and sales by UTM ----------------------------------------
// The 366-day ceiling and from < to are checked by reportRange.resolveReportRange.
const { GROUP_BY_KEYS: UTM_GROUP_BY } = require('./utmReportService');

const utmValue = (max) => Joi.string().trim().min(1).max(max).optional();

module.exports = {
  webStats: { params: wsParams, query: webQuery },
  webSeries: { params: wsParams, query: webQuery },
  webMetrics: {
    params: wsParams,
    query: webQuery.keys({
      type: Joi.string().valid(...METRIC_TYPES).required(),
      limit: Joi.number().integer().min(1).max(500).optional(),
    }),
  },
  webWeekly: { params: wsParams, query: webQuery },
  webRealtime: { params: wsParams, query: Joi.object({ tz: Joi.string().max(64).optional(), ...webFilters }) },
  summary: {
    params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
    query: rangeQuery,
  },
  overview: {
    params: wsParams,
    query: rangeQuery.keys({ compare: Joi.string().valid('previous', 'none').default('previous') }),
  },
  utm: {
    params: wsParams,
    query: rangeQuery.keys({
      groupBy: Joi.string().valid(...UTM_GROUP_BY).default('source'),
      source: utmValue(100),
      medium: utmValue(100),
      campaign: utmValue(150),
    }),
  },
  funnels: {
    params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
    query: rangeQuery,
  },
  funnelDetail: {
    params: Joi.object({
      workspaceId: Joi.string().uuid().required(),
      funnelId: Joi.string().uuid().required(),
    }),
    query: rangeQuery,
  },
};
