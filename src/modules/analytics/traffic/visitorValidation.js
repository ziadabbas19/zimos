'use strict';

const Joi = require('joi');
const { GOVERNORATE_CODES } = require('../../shipping/governorates');
const insights = require('./visitorInsightsService');

// The filters every visitors screen takes (visitorInsightsService). A custom
// period is `from` / `to` (at most MAX_DAYS, checked by the service).
const filters = {
  range: Joi.string().valid(...insights.RANGES).default('7d'),
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
  country: Joi.string().pattern(/^[A-Za-z]{2}$/).uppercase().optional(),
  governorate: Joi.string().valid(...GOVERNORATE_CODES).optional(),
  device: Joi.string().valid('mobile', 'tablet', 'desktop', 'laptop').optional(),
  source: Joi.string().trim().min(1).max(255).optional(),
};
const list = {
  page: Joi.number().integer().min(1).max(10000).default(1),
  pageSize: Joi.number().integer().min(1).max(insights.PAGE_MAX).default(25),
  sort: Joi.string().valid(...Object.keys(insights.SORTS)).default('recent'),
};
const outcomes = { range: Joi.string().valid(...Object.keys(insights.RETURN_RANGES)).default('90d') };
const sessionId = Joi.string().min(8).max(64).pattern(/^[A-Za-z0-9_.:-]+$/).required();
const ws = { workspaceId: Joi.string().uuid().required() };

module.exports = {
  merchant: {
    summary: { params: Joi.object(ws), query: Joi.object(filters) },
    sessions: { params: Joi.object(ws), query: Joi.object({ ...filters, ...list }) },
    session: { params: Joi.object({ ...ws, sessionId }) },
    campaigns: { params: Joi.object(ws), query: Joi.object(filters) },
    governorates: { params: Joi.object(ws), query: Joi.object(outcomes) },
  },
  console: {
    summary: { query: Joi.object({ ...filters, workspaceId: Joi.string().uuid().optional() }) },
    sessions: { query: Joi.object({ ...filters, ...list, workspaceId: Joi.string().uuid().optional() }) },
    session: { params: Joi.object({ ...ws, sessionId }) },
    campaigns: { query: Joi.object({ ...filters, workspaceId: Joi.string().uuid().optional() }) },
    governorates: { query: Joi.object({ ...outcomes, workspaceId: Joi.string().uuid().optional() }) },
  },
};
