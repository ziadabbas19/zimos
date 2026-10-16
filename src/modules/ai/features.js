'use strict';

const Joi = require('joi');
const { ALLOWED_ELEMENT_TYPES } = require('../pages/pageTree');
const { isXsType } = require('../pages/xsElements');

/**
 * The AI features (SPEC §19.2, the P1 rows). Each one names its prompt file,
 * the shape of what the merchant sends (`input`) and the shape the provider
 * must answer with (`output`). A provider's answer that does not match
 * `output` is a failed job — nothing unvalidated is ever stored or applied.
 */

const DIALECTS = ['egyptian', 'gulf', 'msa', 'english', 'french'];
const text = (max) => Joi.string().trim().max(max);

const FEATURES = {
  product: {
    // v2: tells the model about the attached photos (aiService passes them as `images`).
    prompt: 'product_content.v2',
    input: Joi.object({
      name: text(200).min(2).required(),
      price: text(40).allow('', null),
      link: Joi.string().uri({ scheme: ['http', 'https'] }).max(1000).allow('', null),
      notes: text(2000).allow('', null),
      imageUrls: Joi.array().items(Joi.string().uri({ scheme: ['http', 'https'] }).max(1000)).max(6).default([]),
      dialect: Joi.string().valid(...DIALECTS).default('egyptian'),
    }),
    output: Joi.object({
      name: text(200).min(1).required(),
      description: text(5000).min(1).required(),
      features: Joi.array().items(Joi.object({ title: text(120).required(), description: text(600).allow('') })).min(1).max(12).required(),
      faqs: Joi.array().items(Joi.object({ question: text(200).required(), answer: text(1500).required() })).max(20).required(),
      metaDescription: text(300).allow('').required(),
      slug: Joi.string().trim().lowercase().pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120).required(),
      specialOfferText: text(200).allow('').required(),
    }),
  },
  page: {
    prompt: 'page_tree.v1',
    input: Joi.object({
      productId: Joi.string().uuid().required(),
      audience: text(500).allow('', null),
      template: Joi.string().valid('classic', 'problem_solution', 'short').default('classic'),
      dialect: Joi.string().valid(...DIALECTS).default('egyptian'),
    }),
    // The tree itself is checked by pages/pageTree.validatePageTree in aiService.
    output: Joi.object({ title: text(200).min(1).required(), tree: Joi.object().required() }),
  },
  translate: {
    prompt: 'translation.v1',
    input: Joi.object({
      fields: Joi.object().pattern(Joi.string().max(60), Joi.string().max(5000).allow('')).min(1).max(20).required(),
      targetLanguage: Joi.string().valid(...DIALECTS).required(),
    }),
    output: Joi.object({ fields: Joi.object().pattern(Joi.string().max(60), Joi.string().max(8000).allow('')).required() }),
  },
  policies: {
    prompt: 'store_policies.v1',
    input: Joi.object({
      storeName: text(200).allow('', null),
      country: text(60).allow('', null),
      sells: text(500).allow('', null),
      deliveryDays: text(40).allow('', null),
      returnDays: text(40).allow('', null),
      contact: text(200).allow('', null),
      dialect: Joi.string().valid(...DIALECTS).default('egyptian'),
    }),
    output: Joi.object({ shipping: text(6000).min(1).required(), returns: text(6000).min(1).required(), privacy: text(6000).min(1).required() }),
  },
};

// The P2 rows: page review, ad creatives, store builder, suggested WhatsApp replies (featuresP2.js).
Object.assign(FEATURES, require('./featuresP2').specs(DIALECTS, text));

const FEATURE_KEYS = Object.keys(FEATURES);

/**
 * The element types a generated page may use — what the page validator
 * allows, but for the imported templates' bands, which only a template's own
 * look can draw (pages/xsElements.js).
 */
const allowedElements = () => [...ALLOWED_ELEMENT_TYPES].filter((type) => !isXsType(type));

module.exports = { FEATURES, FEATURE_KEYS, DIALECTS, allowedElements };
