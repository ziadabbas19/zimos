'use strict';

const Joi = require('joi');

// Joi's default .email() validates against a public-suffix TLD allowlist,
// which rejects perfectly valid addresses on internal/test/custom domains
// (e.g. "user@storebuilder.test", or a merchant's private mail domain).
// { tlds: { allow: false } } disables that allowlist while keeping full
// RFC 5321 structural email validation.
const joiEmail = () => Joi.string().email({ tlds: { allow: false } });

module.exports = joiEmail;
