'use strict';

const Joi = require('joi');

// The three things the gallery grid can hold. Shared with the admin write
// path via TEMPLATE_KINDS so the tab filter and the editor can never drift.
const TEMPLATE_KINDS = ['store', 'funnel', 'landing'];

module.exports = {
  TEMPLATE_KINDS,

  // `kind` is the grid's tab. Omitted means every kind, which is the tab the
  // picker opens on, so it stays optional with no default.
  list: { query: Joi.object({ kind: Joi.string().valid(...TEMPLATE_KINDS).optional() }) },

  getOne: { params: Joi.object({ id: Joi.string().uuid().required() }) },
};
