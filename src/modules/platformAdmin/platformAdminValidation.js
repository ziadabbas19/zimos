'use strict';

const Joi = require('joi');
const { TEMPLATE_KINDS } = require('../templates/templateValidation');

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

// A swatch in the gallery grid, so a hex colour and nothing else — the column
// holds 20 characters but anything the grid can't paint is no use to it. ""
// is how the editor clears the field; the service turns it into NULL, which
// is what makes the card fall back to the active version's globalStyles.
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// Every editable column, with no `required` and no defaults — the PATCH body
// is these keys as-is, and the POST body below adds what a create needs.
const templateFields = {
  name: Joi.string().trim().min(1).max(200),
  category: Joi.string().trim().max(100).allow(null, ''),
  thumbnailUrl: Joi.string().trim().uri().max(500).allow(null, ''),
  isPublished: Joi.boolean(),
  kind: Joi.string().valid(...TEMPLATE_KINDS),
  // Minor units, like every other money field in the API.
  priceAmount: Joi.number().integer().min(0),
  // Separate from priceAmount on purpose: a paid template can be given away
  // for a while without losing its list price.
  isFree: Joi.boolean(),
  primaryColor: Joi.string().trim().pattern(HEX_COLOR).allow(null, '').messages({
    'string.pattern.base': 'Use a hex colour such as #2563EB',
  }),
  tags: Joi.array().items(Joi.string().trim().min(1).max(60)).max(20),
  rtl: Joi.boolean(),
};

// Defaults spelled out to match the column defaults, so a minimal create
// returns a fully-populated row instead of one the console has to guess at.
const createTemplateBody = Joi.object({
  ...templateFields,
  name: templateFields.name.required(),
  category: templateFields.category.default(null),
  thumbnailUrl: templateFields.thumbnailUrl.default(null),
  isPublished: templateFields.isPublished.default(false),
  kind: templateFields.kind.default('store'),
  priceAmount: templateFields.priceAmount.default(0),
  isFree: templateFields.isFree.default(true),
  primaryColor: templateFields.primaryColor.default(null),
  tags: templateFields.tags.default([]),
  rtl: templateFields.rtl.default(true),
});

// Partial, unlike the plan/flag PATCHes above: the grid flips one switch at a
// time (publish, price), and a full-body schema would let a form that never
// loaded `tags` reset it to [] via the default.
const updateTemplateBody = Joi.object(templateFields).min(1);

module.exports = {
  createPlan: { body: planBody },
  updatePlan: { params: Joi.object({ planId: uuid.required() }), body: planBody },
  deletePlan: { params: Joi.object({ planId: uuid.required() }) },

  listSubscriptions: {
    query: Joi.object({
      status: Joi.string().valid('trialing', 'active', 'past_due', 'suspended', 'cancelled').optional(),
    }),
  },

  // Every filter is optional: the unfiltered call is the common one (the log
  // landing page). Joi coerces page/pageSize to numbers and from/to to Dates,
  // and `validate` writes the defaults back onto req.query.
  listAuditLog: {
    query: Joi.object({
      workspaceId: uuid.optional(),
      actorUserId: uuid.optional(),
      action: Joi.string().trim().max(100).optional(),
      entityType: Joi.string().trim().max(100).optional(),
      entityId: Joi.string().trim().max(100).optional(),
      from: Joi.date().iso().optional(),
      to: Joi.date().iso().min(Joi.ref('from')).optional(),
      // limit/offset, not page/pageSize — these are the names the admin UI
      // already sends. Capped so a client cannot ask for the whole table.
      limit: Joi.number().integer().min(1).max(200).default(50),
      offset: Joi.number().integer().min(0).default(0),
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

  // Same optional `kind` tab as the public gallery; unlike it, this list shows
  // drafts and templates with no version at all.
  listTemplates: { query: Joi.object({ kind: Joi.string().valid(...TEMPLATE_KINDS).optional() }) },
  createTemplate: { body: createTemplateBody },
  updateTemplate: {
    params: Joi.object({ templateId: uuid.required() }),
    body: updateTemplateBody,
  },
  deleteTemplate: { params: Joi.object({ templateId: uuid.required() }) },
};
