'use strict';

const Joi = require('joi');
const orderSchemas = require('./orderValidation');
const { COLUMN_KEYS } = require('./orderExportService');

const uuid = Joi.string().uuid();

// `columns=a,b,c` or a repeated `columns=` — one de-duplicated list either way.
const columns = Joi.alternatives()
  .try(Joi.array().items(Joi.string().max(40)).max(COLUMN_KEYS.length), Joi.string().max(2000))
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
  // The orders list's own filters and sort, so the file and the screen agree;
  // paging belongs to the export itself.
  exportCsv: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: orderSchemas.list.query.keys({
      limit: Joi.forbidden(),
      cursor: Joi.forbidden(),
      columns: columns.optional(),
      rowPer: Joi.string().valid('order', 'item').default('order'),
      lang: Joi.string().valid('en', 'ar').default('en'),
    }),
  },
};
