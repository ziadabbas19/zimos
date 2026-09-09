'use strict';

const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');

// Password strength is enforced here, server-side, so that a request hitting
// the API directly (bypassing the frontend's own check) still can't set a weak
// password at registration or password reset. Rules: at least 8 characters,
// at least one lowercase letter, at least one uppercase letter, and at least
// one character that is not a letter. The last class is "digit OR special
// character" (`[^A-Za-z]`) rather than "special character only" because it is
// the simpler class to express correctly in a single pattern and still
// rejects every all-alphabetic password; the frontend is free to layer a
// stricter symbol requirement on top of this floor.
const PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z]).{8,}$/;
const PASSWORD_MESSAGE =
  'Password must be at least 8 characters and include a lowercase letter, an uppercase letter, and a number or special character';

const password = Joi.string()
  .min(8)
  .max(200)
  .pattern(PASSWORD_PATTERN)
  .messages({ 'string.pattern.base': PASSWORD_MESSAGE })
  .required();

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
  resendVerification: {
    body: Joi.object({ email: joiEmail().required() }),
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
