'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./templateService');

// The public gallery is the same for everyone and changes only when the
// platform publishes a template: cacheable for a minute, as the public plans
// are. Express's ETag lets a browser revalidate it with a 304 after that.
const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=300';

const list = asyncHandler(async (req, res) => {
  const templates = await service.listPublishedTemplates({ kind: req.query.kind });
  res.set('Cache-Control', PUBLIC_CACHE);
  res.json({ templates });
});

const get = asyncHandler(async (req, res) => {
  const template = await service.getTemplateDetail(req.params.id);
  res.set('Cache-Control', PUBLIC_CACHE);
  res.json({ template });
});

module.exports = { list, get };
