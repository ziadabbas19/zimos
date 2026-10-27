'use strict';

const Joi = require('joi');
const { MAX_ENDPOINT_LENGTH } = require('./pushEndpoints');

// Every field is named: validate() strips anything else.

const APPS = ['dashboard', 'console'];
const LOCALES = ['ar', 'en'];

/** A base64url key that decodes to `bytes` bytes (and, for p256dh, an uncompressed P-256 point). */
const key = (bytes, { point = false } = {}) =>
  Joi.string()
    .pattern(/^[A-Za-z0-9_-]+={0,2}$/)
    .max(200)
    .custom((value, helpers) => {
      const raw = Buffer.from(value, 'base64url');
      if (raw.length !== bytes || (point && raw[0] !== 4)) return helpers.error('any.invalid');
      return value;
    });

const id = Joi.object({ id: Joi.string().uuid().required() });

module.exports = {
  subscribe: {
    body: Joi.object({
      app: Joi.string()
        .valid(...APPS)
        .required(),
      subscription: Joi.object({
        endpoint: Joi.string()
          .uri({ scheme: ['https'] })
          .max(MAX_ENDPOINT_LENGTH)
          .required(),
        expirationTime: Joi.number().integer().allow(null),
        keys: Joi.object({
          p256dh: key(65, { point: true }).required(),
          auth: key(16).required(),
        }).required(),
      }).required(),
      locale: Joi.string().valid(...LOCALES),
    }),
  },
  list: {
    query: Joi.object({ app: Joi.string().valid(...APPS) }),
  },
  setEnabled: {
    params: id,
    body: Joi.object({ enabled: Joi.boolean().required() }),
  },
  remove: {
    params: id,
  },
  test: {
    body: Joi.object({ id: Joi.string().uuid() }),
  },
};
