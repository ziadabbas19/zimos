'use strict';

const Joi = require('joi');

const uuid = Joi.string().uuid();

// Matches the admin UI's own rule: lowercase segments joined by dots or
// underscores, e.g. "checkout.one_page_v2".
const FLAG_KEY = /^[a-z0-9]+([._][a-z0-9]+)*$/;
const PLAN_CODE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const planBody = Joi.object({
  name: Joi.string().trim().min(1).max(150).required(),
  code: Joi.string().trim().lowercase().pattern(PLAN_CODE).max(50).required().messages({
    'string.pattern.base': 'Use lowercase letters, numbers and hyphens (e.g. "growth-plus")',
  }),
  // Minor units (e.g. piastres), so an integer is the only valid shape.
  monthlyPrice: Joi.number().integer().min(0).required(),
  yearlyPrice: Joi.number().integer().min(0).required(),
  currency: Joi.string().uppercase().length(3).optional(),
  trialDays: Joi.number().integer().min(0).max(365).required(),
  // null = unlimited.
  orderQuota: Joi.number().integer().min(0).allow(null).default(null),
  transactionFeeBp: Joi.number().integer().min(0).max(10000).default(0),
  codFeeBp: Joi.number().integer().min(0).max(10000).default(0),
  features: Joi.array().items(Joi.string().max(60)).default([]),
  active: Joi.boolean().default(true),
});

const flagBody = Joi.object({
  key: Joi.string().trim().max(120).pattern(FLAG_KEY).required().messages({
    'string.pattern.base': 'Use lowercase letters, numbers, dots and underscores (e.g. checkout.one_page_v2)',
  }),
  description: Joi.string().allow('').max(2000).default(''),
  enabled: Joi.boolean().default(false),
  rollout: Joi.number().integer().min(0).max(100).default(0),
  targetWorkspaceIds: Joi.array().items(uuid).default([]),
});

const announcementBody = Joi.object({
  title: Joi.string().trim().min(1).max(200).required(),
  body: Joi.string().trim().min(1).max(10000).required(),
  severity: Joi.string().valid('info', 'warning').default('info'),
  audience: Joi.string().valid('all', 'plan', 'workspace').required(),
  // Required by, and only allowed with, the matching audience — so an edit
  // that narrows the audience can't leave a stale target behind.
  planId: uuid.allow(null).when('audience', {
    is: 'plan',
    then: Joi.required().invalid(null),
    otherwise: Joi.valid(null).default(null),
  }),
  workspaceId: uuid.allow(null).when('audience', {
    is: 'workspace',
    then: Joi.required().invalid(null),
    otherwise: Joi.valid(null).default(null),
  }),
  startsAt: Joi.date().iso().optional(),
  endsAt: Joi.date().iso().allow(null).default(null),
  dismissible: Joi.boolean().default(true),
});

module.exports = {
  createPlan: { body: planBody },
  updatePlan: { params: Joi.object({ planId: uuid.required() }), body: planBody },
  deletePlan: { params: Joi.object({ planId: uuid.required() }) },

  listSubscriptions: {
    query: Joi.object({
      status: Joi.string().valid('trialing', 'active', 'past_due', 'suspended', 'cancelled').optional(),
    }),
  },

  createFlag: { body: flagBody },
  updateFlag: { params: Joi.object({ flagId: uuid.required() }), body: flagBody },
  deleteFlag: { params: Joi.object({ flagId: uuid.required() }) },

  createAnnouncement: { body: announcementBody },
  updateAnnouncement: {
    params: Joi.object({ announcementId: uuid.required() }),
    body: announcementBody,
  },
  deleteAnnouncement: { params: Joi.object({ announcementId: uuid.required() }) },
};
