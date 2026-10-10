'use strict';

const Joi = require('joi');
const { AppError } = require('../../core/errors/AppError');

/**
 * How the dashboard looks for one account, kept in users.ui_preferences
 * (migration 701) so it follows the person from one device to another:
 *
 *   { appearance: { look, darkTone, glass, glowLeft, glowRight, glowIntensity, updatedAt } }
 *
 *   look            'light' | 'black' | 'dark'; null while the dashboard follows the device
 *   darkTone        0 (midnight) to 100 (slate), a whole number
 *   glass           the glass surfaces are on
 *   glowLeft/Right  '#rrggbb', kept in lower case; null for the colours the backdrop has by itself
 *   glowIntensity   0 to 100, a whole number
 *   updatedAt       when it was last saved: set here, never taken from the client
 *
 * Nothing in it is free text: each value is one of a few words, a whole
 * number, a boolean or a colour, so there is no markup to keep out. The rules
 * and the shape are here, with no database; uiPreferencesService reads and
 * writes the column.
 */

const LOOKS = ['light', 'black', 'dark'];
const APPEARANCE_KEYS = ['look', 'darkTone', 'glass', 'glowLeft', 'glowRight', 'glowIntensity'];

// With every key filled the body is under 200 bytes.
const MAX_BODY_BYTES = 1024;

// strict(): a number or a boolean sent as text is refused, not converted.
const percent = Joi.number().strict().integer().min(0).max(100).required();
const colour = Joi.string()
  .pattern(/^#[0-9a-fA-F]{6}$/)
  .lowercase()
  .allow(null)
  .required()
  .messages({ 'string.pattern.base': '{{#label}} must be a colour like #1a2b3c' });

// unknown(false): validate() drops the keys a schema does not name; here one
// is refused instead, `updatedAt` among them.
const appearance = Joi.object({
  look: Joi.string().valid(...LOOKS).allow(null).required(),
  darkTone: percent,
  glass: Joi.boolean().strict().required(),
  glowLeft: colour,
  glowRight: colour,
  glowIntensity: percent,
})
  .unknown(false)
  .required();

// PATCH /auth/me/ui-preferences
const schema = {
  body: Joi.object({ appearance }).unknown(false).required(),
};

/**
 * Refuses a larger body before it is validated: the API-wide parser reads up
 * to 2mb, and a body of unknown keys would be answered with one line each.
 */
function bodyLimit(req, res, next) {
  const size = Buffer.isBuffer(req.rawBody) ? req.rawBody.length : Buffer.byteLength(JSON.stringify(req.body === undefined ? null : req.body));
  if (size > MAX_BODY_BYTES) {
    return next(new AppError('PAYLOAD_TOO_LARGE', `The request body is larger than ${MAX_BODY_BYTES} bytes`, 413));
  }
  return next();
}

/** The appearance part as it is stored: the validated values, with the time of this save. */
function stamp(values, now = new Date()) {
  const stored = {};
  for (const key of APPEARANCE_KEYS) stored[key] = values[key];
  stored.updatedAt = now.toISOString();
  return stored;
}

/**
 * What the API answers for a stored value: the keys above and nothing else,
 * or null when the account never saved anything.
 */
function present(stored) {
  const saved = stored && typeof stored === 'object' ? stored.appearance : null;
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
  const answer = {};
  for (const key of APPEARANCE_KEYS) answer[key] = saved[key] === undefined ? null : saved[key];
  answer.updatedAt = typeof saved.updatedAt === 'string' ? saved.updatedAt : null;
  return { appearance: answer };
}

module.exports = { LOOKS, APPEARANCE_KEYS, MAX_BODY_BYTES, schema, bodyLimit, stamp, present };
