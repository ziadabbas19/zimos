'use strict';

const Joi = require('joi');

const uuid = Joi.string().uuid();

// A step "key" — stable identifier referenced by edges. Lowercase slug.
const stepKey = Joi.string()
  .min(1)
  .max(100)
  .pattern(/^[a-z0-9](?:[a-z0-9-_]*[a-z0-9])?$/)
  .message('"key" may only contain lowercase letters, numbers, hyphens and underscores');

const stepTypeEnum = Joi.string().valid(
  'landing',
  'sales',
  'opt_in',
  'checkout',
  'upsell',
  'downsell',
  'thank_you',
  'custom'
);

const seo = Joi.object({
  title: Joi.string().allow('').max(300),
  description: Joi.string().allow('').max(1000),
  ogTitle: Joi.string().allow('').max(300),
  ogDescription: Joi.string().allow('').max(1000),
  ogImage: Joi.string().allow('').max(1000),
  canonical: Joi.string().allow('').max(1000),
  noindex: Joi.boolean(),
}).unknown(true);

// builderData is deep-validated by funnelGraph.validateStepData in the service
// so shape errors are specific; here it only has to be present.
const treeData = Joi.any();

const condition = Joi.alternatives()
  .try(
    Joi.valid(null),
    Joi.object({ type: Joi.string().valid('always', 'completed_checkout', 'accepted_offer', 'declined_offer').required() }).unknown(true)
  );

// --- staff ---------------------------------------------------------------

const createFunnel = {
  params: Joi.object({ workspaceId: uuid.required() }),
  body: Joi.object({
    name: Joi.string().min(1).max(200).required(),
    subdomain: Joi.string()
      .lowercase()
      .min(3)
      .max(63)
      .pattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
      .optional(),
  }),
};

const updateFunnel = {
  params: Joi.object({ workspaceId: uuid.required(), funnelId: uuid.required() }),
  body: Joi.object({ name: Joi.string().min(1).max(200).optional() }).min(1),
};

const funnelIdParam = {
  params: Joi.object({ workspaceId: uuid.required(), funnelId: uuid.required() }),
};

const createStep = {
  params: Joi.object({ workspaceId: uuid.required(), funnelId: uuid.required() }),
  body: Joi.object({
    key: stepKey.required(),
    stepType: stepTypeEnum.required(),
    name: Joi.string().min(1).max(200).required(),
    builderData: treeData.optional(),
    offerId: uuid.optional(),
    seo: seo.default({}),
  }),
};

const updateStep = {
  params: Joi.object({ workspaceId: uuid.required(), funnelId: uuid.required(), stepId: uuid.required() }),
  body: Joi.object({
    // `key` is immutable after create — edges reference it.
    stepType: stepTypeEnum.optional(),
    name: Joi.string().min(1).max(200).optional(),
    builderData: treeData.optional(),
    offerId: uuid.allow(null).optional(),
    seo: seo.optional(),
  }).min(1),
};

const stepIdParam = {
  params: Joi.object({ workspaceId: uuid.required(), funnelId: uuid.required(), stepId: uuid.required() }),
};

const createEdge = {
  params: Joi.object({ workspaceId: uuid.required(), funnelId: uuid.required() }),
  body: Joi.object({
    fromStepKey: stepKey.required(),
    toStepKey: stepKey.required(),
    condition: condition.optional(),
    priority: Joi.number().integer().default(0),
  }),
};

const updateEdge = {
  params: Joi.object({ workspaceId: uuid.required(), funnelId: uuid.required(), edgeId: uuid.required() }),
  body: Joi.object({
    fromStepKey: stepKey.optional(),
    toStepKey: stepKey.optional(),
    condition: condition.optional(),
    priority: Joi.number().integer().optional(),
  }).min(1),
};

const edgeIdParam = {
  params: Joi.object({ workspaceId: uuid.required(), funnelId: uuid.required(), edgeId: uuid.required() }),
};

const publish = {
  params: Joi.object({ workspaceId: uuid.required(), funnelId: uuid.required() }),
  body: Joi.object({ note: Joi.string().max(300).allow('').optional() }).default({}),
};

const rollback = {
  params: Joi.object({
    workspaceId: uuid.required(),
    funnelId: uuid.required(),
    revisionId: uuid.required(),
  }),
};

// --- public runtime (no staff auth) -----------------------------------

const startSession = {
  params: Joi.object({ workspaceId: uuid.required(), funnelRef: Joi.string().max(100).required() }),
  body: Joi.object({
    visitorId: Joi.string().min(1).max(64).required(),
    attribution: Joi.object().unknown(true).default({}),
  }),
};

const sessionStep = {
  params: Joi.object({
    workspaceId: uuid.required(),
    funnelId: uuid.required(),
    sessionId: uuid.required(),
  }),
};

const advance = {
  params: Joi.object({
    workspaceId: uuid.required(),
    funnelId: uuid.required(),
    sessionId: uuid.required(),
  }),
  body: Joi.object({
    outcome: Joi.object({
      type: Joi.string()
        .valid('completed_checkout', 'accepted_offer', 'declined_offer', 'clicked_through')
        .required(),
      orderId: uuid.optional(),
    }).required(),
  }),
};

module.exports = {
  createFunnel,
  updateFunnel,
  funnelIdParam,
  createStep,
  updateStep,
  stepIdParam,
  createEdge,
  updateEdge,
  edgeIdParam,
  publish,
  rollback,
  startSession,
  sessionStep,
  advance,
};
