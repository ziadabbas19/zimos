'use strict';

const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');
const { LABELS: RFM_LABELS } = require('../rfm');

/*
 * What a campaign is made of. Everything a merchant types is plain text or a
 * checked value: the email is rendered on the server from these blocks
 * (campaignContent.js), escaped, with http(s) links only — never raw HTML.
 *
 *   heading   { text, align?, size?: 'lg' | 'md' }
 *   text      { text, align? }                    blank lines are paragraphs
 *   image     { url, alt?, link?, width? }        http(s) picture, optional link
 *   button    { label, url, align?, color? }
 *   products  { productIds: 1–6, showPrice? }     the store's own products, read when sent
 *   divider   {}
 *
 * Audience — who of the customers that agreed to marketing emails gets it:
 *   { type: 'all' }
 *   { type: 'segment', segmentId }                a saved segment (contacts/segmentRules.js)
 *   { type: 'rfm', labels: [...] }                RFM groups (modules/rfm)
 *   { type: 'rules', rules: { minOrders?, maxOrders?, minSpent?, maxSpent?,
 *                             lastOrderWithinDays?, lastOrderOlderThanDays? } }
 */

const MAX_BLOCKS = 40;
const MAX_PRODUCTS = 6;
const ALIGN = ['start', 'center', 'end'];
const uuid = Joi.string().uuid();
const httpUrl = Joi.string()
  .trim()
  .max(1000)
  .pattern(/^https?:\/\/[^\s"'<>]+$/i)
  .messages({ 'string.pattern.base': 'Use a link starting with https://' });
// Header text: one line, no control characters (a newline would start a new mail header).
const oneLine = (max) => Joi.string().trim().max(max).pattern(/^[^\r\n\u0000-\u001f]*$/).messages({ 'string.pattern.base': 'Use one line of text' });

const blockSchema = Joi.object({
  type: Joi.string().valid('heading', 'text', 'image', 'button', 'products', 'divider').required(),
  text: Joi.when('type', {
    switch: [
      { is: 'heading', then: Joi.string().trim().min(1).max(200).required() },
      { is: 'text', then: Joi.string().trim().min(1).max(5000).required() },
    ],
    otherwise: Joi.forbidden(),
  }),
  size: Joi.when('type', { is: 'heading', then: Joi.string().valid('lg', 'md'), otherwise: Joi.forbidden() }),
  label: Joi.when('type', { is: 'button', then: Joi.string().trim().min(1).max(80).required(), otherwise: Joi.forbidden() }),
  url: Joi.when('type', { is: Joi.valid('button', 'image'), then: httpUrl.required(), otherwise: Joi.forbidden() }),
  link: Joi.when('type', { is: 'image', then: httpUrl.allow(null, ''), otherwise: Joi.forbidden() }),
  alt: Joi.when('type', { is: 'image', then: Joi.string().trim().max(200).allow(''), otherwise: Joi.forbidden() }),
  width: Joi.when('type', { is: 'image', then: Joi.number().integer().min(40).max(600), otherwise: Joi.forbidden() }),
  color: Joi.when('type', { is: 'button', then: Joi.string().pattern(/^#[0-9a-fA-F]{6}$/), otherwise: Joi.forbidden() }),
  productIds: Joi.when('type', {
    is: 'products',
    then: Joi.array().items(uuid).min(1).max(MAX_PRODUCTS).unique().required(),
    otherwise: Joi.forbidden(),
  }),
  showPrice: Joi.when('type', { is: 'products', then: Joi.boolean(), otherwise: Joi.forbidden() }),
  align: Joi.when('type', { is: Joi.valid('heading', 'text', 'image', 'button'), then: Joi.string().valid(...ALIGN), otherwise: Joi.forbidden() }),
});

const blocksSchema = Joi.array().items(blockSchema).max(MAX_BLOCKS);

const RULE_KEYS = ['minOrders', 'maxOrders', 'minSpent', 'maxSpent', 'lastOrderWithinDays', 'lastOrderOlderThanDays'];
const rulesSchema = Joi.object({
  minOrders: Joi.number().integer().min(0).max(100000),
  maxOrders: Joi.number().integer().min(0).max(100000),
  // Minor units, over the orders that stand as sales (contacts/segmentRules.js).
  minSpent: Joi.number().integer().min(0).max(1e13),
  maxSpent: Joi.number().integer().min(0).max(1e13),
  lastOrderWithinDays: Joi.number().integer().min(1).max(3650),
  lastOrderOlderThanDays: Joi.number().integer().min(1).max(3650),
}).min(1);

const audienceSchema = Joi.object({
  type: Joi.string().valid('all', 'segment', 'rfm', 'rules').required(),
  segmentId: Joi.when('type', { is: 'segment', then: uuid.required(), otherwise: Joi.forbidden() }),
  labels: Joi.when('type', {
    is: 'rfm',
    then: Joi.array().items(Joi.string().valid(...RFM_LABELS)).min(1).max(RFM_LABELS.length).unique().required(),
    otherwise: Joi.forbidden(),
  }),
  rules: Joi.when('type', { is: 'rules', then: rulesSchema.required(), otherwise: Joi.forbidden() }),
});

const content = {
  subject: oneLine(200).allow(''),
  preheader: oneLine(200).allow('', null),
  blocks: blocksSchema,
  locale: Joi.string().valid('ar', 'en'),
  replyTo: joiEmail().max(255).allow('', null),
};

const params = Joi.object({ workspaceId: uuid.required() });
const withId = Joi.object({ workspaceId: uuid.required(), campaignId: uuid.required() });

const schemas = {
  list: {
    params,
    query: Joi.object({
      status: Joi.string().valid('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'),
      cursor: Joi.string().max(200),
      limit: Joi.number().integer().min(1).max(50).default(20),
    }),
  },
  plain: { params },
  one: { params: withId },
  create: {
    params,
    body: Joi.object({ name: Joi.string().trim().min(1).max(120).required(), ...content, audience: audienceSchema }),
  },
  update: {
    params: withId,
    body: Joi.object({ name: Joi.string().trim().min(1).max(120), ...content, audience: audienceSchema }).min(1),
  },
  audience: { params, body: Joi.object({ audience: audienceSchema.required() }) },
  preview: { params, body: Joi.object({ ...content, blocks: blocksSchema.required() }) },
  test: { params, body: Joi.object({ ...content, blocks: blocksSchema.min(1).required(), subject: oneLine(200).min(1).required() }) },
  schedule: { params: withId, body: Joi.object({ scheduledAt: Joi.date().iso().required() }) },
  recipients: {
    params: withId,
    query: Joi.object({
      status: Joi.string().valid('queued', 'sending', 'sent', 'failed', 'skipped', 'cancelled'),
      cursor: Joi.string().max(200),
      limit: Joi.number().integer().min(1).max(100).default(50),
    }),
  },
  unsubscribe: { query: Joi.object({ t: Joi.string().max(500).required() }).unknown(true) },
};

module.exports = { schemas, blocksSchema, audienceSchema, RULE_KEYS, MAX_BLOCKS, MAX_PRODUCTS };
