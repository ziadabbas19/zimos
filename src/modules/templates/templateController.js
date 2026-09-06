'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./templateService');

const list = asyncHandler(async (req, res) => {
  res.json({ templates: await service.listPublishedTemplates() });
});

const get = asyncHandler(async (req, res) => {
  res.json({ template: await service.getTemplateDetail(req.params.id) });
});

module.exports = { list, get };
