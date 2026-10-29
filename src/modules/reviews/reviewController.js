'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./reviewService');
const env = require('../../config/env');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { clientIp } = require('../../core/middleware/clientIp');

// --- Public (storefront) --------------------------------------------------

// Sending a review stays closed unless REVIEWS_PUBLIC_SUBMISSION_ENABLED is
// "true" (env.reviews). Closed, every send gets the same 404, naming no
// phone, product or store detail; reading reviews, moderation and the rating
// are untouched.
function submissionGate(req, res, next) {
  if (env.reviews.publicSubmissionEnabled) return next();
  return next(new AppError('NOT_FOUND', 'Not found', 404));
}

// The visitor id the photo upload was sent with (customerUploads); optional when there are no photos.
const visitorOf = (req) => {
  const value = req.headers['x-visitor-id'];
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
};

const submit = asyncHandler(async (req, res) => {
  const result = await service.submitReview(req.tenant.workspaceId, {
    kind: 'product',
    productId: req.params.productId,
    body: req.body,
    visitorId: visitorOf(req),
    ip: clientIp(req),
  });
  res.status(201).json({ review: result });
});

const submitStore = asyncHandler(async (req, res) => {
  const result = await service.submitReview(req.tenant.workspaceId, { kind: 'store', body: req.body, visitorId: visitorOf(req), ip: clientIp(req) });
  res.status(201).json({ review: result });
});

const storeReviews = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json(await service.publicStoreReviews(req.tenant.workspaceId));
});

// A shopper's photo on a published review. The same 404 for an unknown photo and a hidden review.
const photo = asyncHandler(async (req, res) => {
  const file = await service.publicPhoto(req.tenant.workspaceId, req.params.uploadId);
  if (!file) throw new NotFoundError('Photo');
  res.set({
    'Content-Type': file.mime,
    'Content-Length': String(file.buffer.length),
    // Short: a review the merchant hides stops showing its photos within minutes.
    'Cache-Control': 'public, max-age=300',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  res.end(file.buffer);
});

// --- Staff moderation ---------------------------------------------------
const list = asyncHandler(async (req, res) => {
  res.json(await service.listReviews(req.tenant.workspaceId, req.query, req));
});

const summary = asyncHandler(async (req, res) => {
  res.json({ counts: await service.countsByStatus(req.tenant.workspaceId) });
});

const moderate = asyncHandler(async (req, res) => {
  res.json({ review: await service.moderateReview(req.tenant.workspaceId, req.params.reviewId, req.body, req) });
});

const remove = asyncHandler(async (req, res) => {
  res.json(await service.deleteReview(req.tenant.workspaceId, req.params.reviewId, req));
});

module.exports = { submissionGate, submit, submitStore, storeReviews, photo, list, summary, moderate, remove };
