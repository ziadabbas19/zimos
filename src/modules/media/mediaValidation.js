'use strict';

const Joi = require('joi');

const uuid = Joi.string().uuid();

module.exports = {
  // The media library grid. `before` is the previous page's `nextCursor` — the
  // id of its last row — not an offset, so inserting a file mid-scroll cannot
  // make the next page repeat or skip one.
  list: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({
      limit: Joi.number().integer().min(1).max(100).default(30),
      before: uuid.optional(),
    }),
  },

  remove: {
    params: Joi.object({ workspaceId: uuid.required(), mediaId: uuid.required() }),
  },
};
