'use strict';

const { ValidationError } = require('../../core/errors/AppError');

/**
 * Which optional checkout fields a store asks for, and how hard it asks.
 * Stored under `workspaces.settings.checkout_settings` (PATCH /workspaces/:id),
 * read back by the storefront from GET /store/:workspaceId as `checkout`, and
 * enforced here on the way in so a 'required' field cannot be skipped by
 * calling the API directly.
 *
 * The keys are named after the request fields they govern, not after the form
 * labels the merchant sees:
 *   email       -> body.contact.email
 *   postal_code -> body.shippingAddress.postalCode
 *   notes       -> body.notes            (the shopper's order note)
 *
 * There is deliberately no "address line 2" knob: the checkout schema has a
 * single `addressLine`, so there is no second line to hide or require. Add the
 * field first if the storefront ever needs one.
 *
 * The defaults reproduce the behaviour of a store that has never configured
 * anything — every one of these fields is optional in checkoutValidation.js —
 * so turning the feature on changes nothing until a merchant actually moves a
 * switch.
 */

const MODES = ['hidden', 'optional', 'required'];
// A note the shopper never sees cannot be demanded of them, so `notes` has no
// 'required'.
const NOTES_MODES = ['hidden', 'optional'];

const DEFAULTS = Object.freeze({
  email: 'optional',
  postal_code: 'optional',
  notes: 'optional',
});

/** The effective settings for a workspace: stored values over the defaults. */
function resolveCheckoutSettings(workspace) {
  const stored = (workspace && workspace.settings && workspace.settings.checkout_settings) || {};
  return {
    email: MODES.includes(stored.email) ? stored.email : DEFAULTS.email,
    postal_code: MODES.includes(stored.postal_code) ? stored.postal_code : DEFAULTS.postal_code,
    notes: NOTES_MODES.includes(stored.notes) ? stored.notes : DEFAULTS.notes,
  };
}

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/**
 * Refuses a checkout that leaves a merchant-required field empty, in the same
 * 422 shape Joi produces so the storefront can render it with the code it
 * already has. 'hidden' and 'optional' are enforced nowhere: a hidden field
 * that arrives anyway is simply stored, exactly as it is today.
 *
 * @param {object} workspace  req.publicWorkspace
 * @param {object} body       the validated checkout body
 * @throws {ValidationError}
 */
function assertRequiredCheckoutFields(workspace, body) {
  const settings = resolveCheckoutSettings(workspace);
  const address = body.shippingAddress || {};
  const problems = [];

  if (settings.email === 'required' && isBlank(body.contact && body.contact.email)) {
    problems.push({ field: 'contact.email', message: '"email" is required' });
  }
  if (settings.postal_code === 'required' && isBlank(address.postalCode)) {
    problems.push({ field: 'shippingAddress.postalCode', message: '"postalCode" is required' });
  }

  if (problems.length) throw new ValidationError(problems, 'Invalid body');
}

module.exports = {
  CHECKOUT_FIELD_MODES: MODES,
  CHECKOUT_NOTES_MODES: NOTES_MODES,
  CHECKOUT_SETTINGS_DEFAULTS: DEFAULTS,
  resolveCheckoutSettings,
  assertRequiredCheckoutFields,
};
