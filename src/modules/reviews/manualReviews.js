'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Reviews added by the merchant (SPEC §7.7). A manual review is a real review
 * that reached the merchant somewhere else; it is stored with source
 * 'manual', has no customer row or order, is never marked as a verified buyer
 * and never counts in the stars (reviews/reviewRating.js).
 *
 * The router is mounted by reviewRoutes, behind its authenticate →
 * resolveTenant → requirePermission(products.manage).
 */

const uuid = Joi.string().uuid();
const photo = Joi.string()
  .uri({ scheme: ['http', 'https'] })
  .max(1000);

const schemas = {
  create: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      productId: uuid.required(),
      authorName: Joi.string().trim().min(1).max(120).required(),
      rating: Joi.number().integer().min(1).max(5).required(),
      comment: Joi.string().trim().max(2000).allow('', null),
      photos: Joi.array().items(photo).max(6).default([]),
      // The merchant typed it in, so it goes live unless they say otherwise.
      status: Joi.string().valid('approved', 'pending').default('approved'),
    }),
  },
};

async function createManualReview(workspaceId, data, req) {
  const product = await db.Product.findOne({ where: { id: data.productId, workspaceId }, attributes: ['id', 'name'] });
  if (!product) throw new NotFoundError('Product');

  const review = await db.Review.create({
    workspaceId,
    productId: product.id,
    customerId: null,
    orderId: null,
    authorName: data.authorName,
    rating: data.rating,
    comment: data.comment || null,
    photos: data.photos,
    source: 'manual',
    status: data.status,
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
  return { ...review.toJSON(), product: { id: product.id, name: product.name }, customer: null };
}

const router = Router({ mergeParams: true });

router.post(
  '/',
  validate(schemas.create),
  asyncHandler(async (req, res) => {
    res.status(201).json({ review: await createManualReview(req.tenant.workspaceId, req.body, req) });
  })
);

// Deleting any review, and what the storefront shows of them, live in reviewService.
module.exports = { router, createManualReview, publicReviews: (...args) => require('./reviewService').publicProductReviews(...args) };
