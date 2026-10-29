'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { cleanText } = require('../platformSettings/rules');

/*
 * Reviews added by the merchant (SPEC §7.7).
 *
 *   manual    a real review that reached the merchant somewhere else, typed
 *             in by hand (before external reviews existed; the dashboard
 *             still reads them, and the merchant can give one a source)
 *   external  a review written on another site — Facebook, Google,
 *             Instagram, WhatsApp, or one the merchant names — with an
 *             optional link to it and the day it was written. On a product
 *             or on the whole store.
 *
 * Neither has a customer row or an order, so neither is ever marked as a
 * verified buyer nor counts in the stars (reviews/reviewRating.js); the
 * storefront shows external reviews apart, with their source
 * (reviewService.publicExternal). Only the merchant's team (products.manage)
 * adds or edits them; a shopper's own review is never edited, only
 * published, hidden or deleted.
 *
 * The router is mounted by reviewRoutes, behind its authenticate →
 * resolveTenant → requirePermission(products.manage).
 */

const EXTERNAL_SOURCES = ['facebook', 'google', 'instagram', 'whatsapp', 'other'];
const MERCHANT_SOURCES = ['manual', 'import', 'external'];

const uuid = Joi.string().uuid();
const photo = Joi.string()
  .uri({ scheme: ['http', 'https'] })
  .max(1000);
/** Text as the store will show it: no tags, no control or hidden characters. */
const plain = (max, multiline = false) =>
  Joi.string()
    .max(max * 4)
    .custom((value, helpers) => {
      const cleaned = cleanText(value, { multiline });
      if (cleaned.length > max) return helpers.message(`${helpers.state.path.join('.')} must be at most ${max} characters`);
      return cleaned;
    });

// What a merchant-added review holds; `externalSource` makes it an external one.
const fields = {
  kind: Joi.string().valid('product', 'store'),
  productId: uuid.allow(null),
  authorName: plain(120),
  rating: Joi.number().integer().min(1).max(5),
  comment: plain(2000, true).allow('', null),
  photos: Joi.array().items(photo).max(6),
  externalSource: Joi.string().valid(...EXTERNAL_SOURCES),
  // The site's name when the source is "other".
  externalSourceLabel: plain(60).allow('', null),
  externalUrl: Joi.string().uri({ scheme: ['http', 'https'] }).max(1000).allow('', null),
  // The day it was written there: not in the future.
  reviewedAt: Joi.date().iso().max('now').allow(null),
};

const schemas = {
  create: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      ...fields,
      kind: fields.kind.default('product'),
      authorName: fields.authorName.required(),
      rating: fields.rating.required(),
      photos: fields.photos.default([]),
      // The merchant typed it in, so it goes live unless they say otherwise.
      status: Joi.string().valid('approved', 'pending').default('approved'),
    }),
  },
  update: {
    params: Joi.object({ workspaceId: uuid.required(), reviewId: uuid.required() }),
    body: Joi.object(fields).min(1),
  },
};

const ymd = (date) => (date ? new Date(date).toISOString().slice(0, 10) : null);

/** The product a review is on (for kind product), or null for the store. */
async function productFor(workspaceId, kind, productId) {
  if (kind === 'store') return null;
  if (!productId) throw new AppError('VALIDATION_ERROR', 'Choose the product', 422, [{ field: 'productId', message: 'Required for a product review' }]);
  const product = await db.Product.findOne({ where: { id: productId, workspaceId }, attributes: ['id', 'name'] });
  if (!product) throw new NotFoundError('Product');
  return product;
}

/** The source columns: set for an external review, cleared otherwise. */
function sourceColumns(data) {
  if (!data.externalSource) return {};
  return {
    source: 'external',
    externalSource: data.externalSource,
    externalSourceLabel: data.externalSource === 'other' ? data.externalSourceLabel || null : null,
    externalUrl: data.externalUrl || null,
    reviewedAt: ymd(data.reviewedAt),
  };
}

async function createManualReview(workspaceId, data, req) {
  const product = await productFor(workspaceId, data.kind, data.productId);
  const review = await db.Review.create({
    workspaceId,
    kind: data.kind,
    productId: product ? product.id : null,
    customerId: null,
    orderId: null,
    authorName: data.authorName,
    rating: data.rating,
    comment: data.comment || null,
    photos: data.photos,
    source: 'manual',
    status: data.status,
    ...sourceColumns(data),
  });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'review.create_manual',
    entityType: 'Review',
    entityId: review.id,
    after: review.toJSON(),
    req,
  });
  return { ...review.toJSON(), product: product ? { id: product.id, name: product.name } : null, customer: null };
}

/** Edits a review the merchant added (by hand, imported or external); a shopper's own words are never edited. */
async function updateManualReview(workspaceId, reviewId, data, req) {
  const review = await db.Review.findOne({ where: { id: reviewId, workspaceId } });
  if (!review) throw new NotFoundError('Review');
  if (!MERCHANT_SOURCES.includes(review.source)) {
    throw new AppError('REVIEW_NOT_EDITABLE', "A customer's review cannot be edited; publish, hide or delete it", 409);
  }
  const before = review.toJSON();
  const kind = data.kind || review.kind;
  const productId = data.productId !== undefined ? data.productId : review.productId;
  const product = await productFor(workspaceId, kind, productId);
  const next = {
    kind,
    productId: product ? product.id : null,
    ...(data.authorName !== undefined ? { authorName: data.authorName } : {}),
    ...(data.rating !== undefined ? { rating: data.rating } : {}),
    ...(data.comment !== undefined ? { comment: data.comment || null } : {}),
    ...(data.photos !== undefined ? { photos: data.photos } : {}),
  };
  // Where it came from: given whole (an external review keeps its source unless a new one is sent).
  const external = data.externalSource || (review.source === 'external' ? review.externalSource : null);
  if (external) {
    Object.assign(
      next,
      sourceColumns({
        externalSource: external,
        externalSourceLabel: data.externalSourceLabel !== undefined ? data.externalSourceLabel : review.externalSourceLabel,
        externalUrl: data.externalUrl !== undefined ? data.externalUrl : review.externalUrl,
        reviewedAt: data.reviewedAt !== undefined ? data.reviewedAt : review.reviewedAt,
      })
    );
  }
  await review.update(next);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'review.update_manual',
    entityType: 'Review',
    entityId: review.id,
    before,
    after: review.toJSON(),
    req,
  });
  return { ...review.toJSON(), product: product ? { id: product.id, name: product.name } : null, customer: null };
}

const router = Router({ mergeParams: true });

router.post(
  '/',
  validate(schemas.create),
  asyncHandler(async (req, res) => {
    res.status(201).json({ review: await createManualReview(req.tenant.workspaceId, req.body, req) });
  })
);

router.patch(
  '/:reviewId/content',
  validate(schemas.update),
  asyncHandler(async (req, res) => {
    res.json({ review: await updateManualReview(req.tenant.workspaceId, req.params.reviewId, req.body, req) });
  })
);

// Deleting any review, and what the storefront shows of them, live in reviewService.
module.exports = {
  EXTERNAL_SOURCES,
  MERCHANT_SOURCES,
  router,
  createManualReview,
  updateManualReview,
  publicReviews: (...args) => require('./reviewService').publicProductReviews(...args),
};
