'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./reviewService');

// --- Public (storefront) --------------------------------------------------
const submit = asyncHandler(async (req, res) => {
  const result = await service.submitReview(req.tenant.workspaceId, req.params.productId, req.body);
  res.status(result.created ? 201 : 200).json({ review: result });
});

// --- Staff moderation ---------------------------------------------------
const list = asyncHandler(async (req, res) => {
  res.json({ reviews: await service.listReviews(req.tenant.workspaceId, req.query) });
});

const moderate = asyncHandler(async (req, res) => {
  res.json({ review: await service.moderateReview(req.tenant.workspaceId, req.params.reviewId, req.body, req) });
});

module.exports = { submit, list, moderate };
