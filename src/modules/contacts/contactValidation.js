'use strict';
const Joi = require('joi');
const { rulesSchema, tagSchema } = require('./segmentRules');
const { refusesHidden } = require('../../core/utils/refusesHidden');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const tags = Joi.array().items(tagSchema).max(50);

const filter = {
  q: Joi.string().trim().max(100).allow(''),
  type: Joi.string().valid('lead', 'customer'),
  tag: tagSchema,
  consent: Joi.boolean(),
  segmentId: uuid,
};

const segmentBody = {
  name: Joi.string().trim().min(1).max(120),
  description: Joi.string().trim().max(300).allow(null, ''),
  rules: rulesSchema,
};

const text = (max) => Joi.string().max(max).allow('', null);

module.exports = {
  list: {
    params: Joi.object(ws),
    query: Joi.object({ ...filter, limit: Joi.number().integer().min(1).max(200).default(50), cursor: Joi.string().max(200) }),
  },
  exportCsv: { params: Joi.object(ws), query: Joi.object(filter) },
  workspaceOnly: { params: Joi.object(ws) },
  get: { params: Joi.object({ ...ws, customerId: uuid.required() }) },
  create: {
    params: Joi.object(ws),
    body: refusesHidden(Joi.object({
      phone: Joi.string().max(32).required(),
      fullName: text(200),
      email: Joi.string().email().max(255).allow('', null),
      marketingConsent: Joi.boolean().default(false),
      tags: tags.default([]),
    })),
  },
  setTags: { params: Joi.object({ ...ws, customerId: uuid.required() }), body: Joi.object({ tags: tags.required() }) },
  bulkTag: {
    params: Joi.object(ws),
    body: Joi.object({
      customerIds: Joi.array().items(uuid).min(1).max(200).required(),
      add: tags.default([]),
      remove: tags.default([]),
    }).or('add', 'remove'),
  },

  createSegment: {
    params: Joi.object(ws),
    body: Joi.object({ ...segmentBody, name: segmentBody.name.required(), rules: rulesSchema.required() }),
  },
  updateSegment: { params: Joi.object({ ...ws, segmentId: uuid.required() }), body: Joi.object(segmentBody).min(1) },
  segment: { params: Joi.object({ ...ws, segmentId: uuid.required() }) },
  previewSegment: { params: Joi.object(ws), body: Joi.object({ rules: rulesSchema.required() }) },

  listForms: {
    params: Joi.object(ws),
    query: Joi.object({
      limit: Joi.number().integer().min(1).max(200).default(50),
      cursor: Joi.string().max(200),
      formName: Joi.string().max(200),
      unreadOnly: Joi.boolean(),
      q: Joi.string().trim().max(100).allow(''),
    }),
  },
  markForm: {
    params: Joi.object({ ...ws, submissionId: uuid.required() }),
    body: Joi.object({ isRead: Joi.boolean().required() }),
  },
  form: { params: Joi.object({ ...ws, submissionId: uuid.required() }) },

  // Public (storefront). `website` is the honeypot: real shoppers never see it.
  submitForm: {
    body: Joi.object({
      elementId: Joi.string().max(100).allow('', null),
      pagePath: Joi.string().max(500).allow('', null),
      formName: text(200),
      name: text(200),
      phone: text(32),
      email: Joi.string().email().max(255).allow('', null),
      message: text(4000),
      marketingConsent: Joi.boolean().default(false),
      fields: Joi.object().pattern(Joi.string().max(100), Joi.string().max(2000).allow('')).max(30).default({}),
      website: text(200),
      // Who uploaded the form's photo (X-Visitor-Id of POST /store/:ws/uploads).
      visitorId: Joi.string().pattern(/^[A-Za-z0-9_-]{8,64}$/).allow('', null),
    }),
  },
};
