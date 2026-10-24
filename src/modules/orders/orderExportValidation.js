'use strict';

const Joi = require('joi');
const orderSchemas = require('./orderValidation');
const { COLUMN_KEYS, PRESET_NAMES } = require('./orderExportService');

const uuid = Joi.string().uuid();

// `columns=a,b,c` (or repeated `columns=`) — one list either way.
const columns = Joi.alternatives()
  .try(Joi.array().items(Joi.string()), Joi.string())
  .custom((value, helpers) => {
    const keys = (Array.isArray(value) ? value : String(value).split(','))
      .map((k) => k.trim())
      .filter(Boolean);
    const unknown = keys.filter((k) => !COLUMN_KEYS.includes(k));
    if (unknown.length > 0) return helpers.message(`Unknown column: ${unknown.join(', ')}`);
    return [...new Set(keys)];
  });

module.exports = {
  columns: { params: Joi.object({ workspaceId: uuid.required() }) },
  // The orders list's own query, so the file and the screen filter alike;
  // paging belongs to the export itself.
  exportCsv: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: orderSchemas.list.query.keys({
      limit: Joi.forbidden(),
      cursor: Joi.forbidden(),
      // A ready-made export (orderExportService.PRESETS) brings its own columns and rows.
      preset: Joi.string().valid(...PRESET_NAMES).optional(),
      columns: columns.optional().when('preset', { is: Joi.exist(), then: Joi.forbidden() }),
      rowPer: Joi.string().valid('order', 'item').when('preset', { is: Joi.exist(), then: Joi.forbidden(), otherwise: Joi.optional().default('order') }),
      format: Joi.string().valid('csv', 'xlsx').default('csv'),
      lang: Joi.string().valid('en', 'ar').default('en'),
    }),
  },
};
