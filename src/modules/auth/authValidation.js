'use strict';

const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');

const password = Joi.string().min(8).max(200).required();

module.exports = {
  register: {
    body: Joi.object({
      email: joiEmail().max(255).required(),
      password,
      fullName: Joi.string().min(2).max(200).required(),
      phone: Joi.string().max(32).optional(),
    }),
  },
  login: {
    body: Joi.object({
      email: joiEmail().max(255).required(),
      password: Joi.string().required(),
    }),
  },
  verifyEmail: {
    body: Joi.object({ token: Joi.string().required() }),
  },
  googleCallback: {
    // Query comes straight from Google's redirect; keep it lenient.
    query: Joi.object({
      code: Joi.string().max(2048),
      error: Joi.string().max(200),
      state: Joi.string().max(2048),
    })
      .or('code', 'error')
      .unknown(true),
  },
  refresh: {
    body: Joi.object({ refreshToken: Joi.string().required() }),
  },
  logout: {
    body: Joi.object({ refreshToken: Joi.string().required() }),
  },
  requestPasswordReset: {
    body: Joi.object({ email: joiEmail().required() }),
  },
  resetPassword: {
    body: Joi.object({ token: Joi.string().required(), newPassword: password }),
  },
  phoneCode: Joi.string().pattern(/^\d{6}$/),
  verifyPhoneRequest: {
    body: Joi.object({ phone: Joi.string().min(6).max(32).required() }),
  },
  verifyPhoneConfirm: {
    body: Joi.object({ phone: Joi.string().min(6).max(32).required(), code: Joi.string().pattern(/^\d{6}$/).required() }),
  },
  passwordResetSmsRequest: {
    body: Joi.object({ phone: Joi.string().min(6).max(32).required() }),
  },
  passwordResetSmsConfirm: {
    body: Joi.object({
      phone: Joi.string().min(6).max(32).required(),
      code: Joi.string().pattern(/^\d{6}$/).required(),
      newPassword: password,
    }),
  },
};
