'use strict';

const { fn, col } = require('sequelize');
const db = require('../../db/models');
const { scoped } = require('../../core/utils/scopedRepository');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const { recordAudit } = require('../audit/auditService');

/**
 * True when the customer has at least one delivered order that contained
 * `productId`. "Delivered" = the order's fulfillmentState is 'fulfilled', or
 * it has a shipment marked 'delivered'.
 */
async function hasDeliveredPurchase(workspaceId, customerId, productId) {
  const orders = await db.Order.findAll({
    where: { workspaceId, customerId },
    include: [
      { model: db.OrderItem, as: 'items', where: { productId }, required: true, attributes: ['id'] },
      { model: db.Shipment, as: 'shipments', required: false, attributes: ['status'] },
    ],
  });
  return orders.find(
    (o) => o.fulfillmentState === 'fulfilled' || (o.shipments || []).some((s) => s.status === 'delivered')
  );
}

async function submitReview(workspaceId, productId, { phone, rating, comment }) {
  const product = await db.Product.findOne({ where: { id: productId, workspaceId, status: 'active' } });
  if (!product) throw new NotFoundError('Product');

  const phoneNormalized = normalizePhone(phone);
  const customer = phoneNormalized
    ? await db.Customer.findOne({ where: { workspaceId, phoneNormalized } })
    : null;
  if (!customer) {
    throw new AppError('NO_DELIVERED_PURCHASE', 'Only a customer who received this product can review it', 403);
  }

  const order = await hasDeliveredPurchase(workspaceId, customer.id, productId);
  if (!order) {
    throw new AppError('NO_DELIVERED_PURCHASE', 'Only a customer who received this product can review it', 403);
  }

  // One review per (workspace, product, customer) — resubmitting updates it
  // and sends it back to moderation.
  const [review, created] = await db.Review.findOrCreate({
    where: { workspaceId, productId, customerId: customer.id },
    defaults: { workspaceId, productId, customerId: customer.id, orderId: order.id, rating, comment: comment || null, status: 'pending' },
  });
  if (!created) {
    await review.update({ rating, comment: comment || null, status: 'pending', orderId: order.id });
  }

  await recordAudit({
    workspaceId,
    actorUserId: null,
    action: created ? 'review.submit' : 'review.resubmit',
    entityType: 'Review',
    entityId: review.id,
    after: { rating, status: 'pending' },
  });

  return { id: review.id, rating: review.rating, comment: review.comment, status: review.status, created };
}

async function listReviews(workspaceId, { status } = {}) {
  const where = { workspaceId };
  if (status) where.status = status;
  return db.Review.findAll({
    where,
    order: [['createdAt', 'DESC']],
    include: [
      { model: db.Product, as: 'product', attributes: ['id', 'name'] },
      { model: db.Customer, as: 'customer', attributes: ['id', 'fullName'] },
    ],
  });
}

async function moderateReview(workspaceId, reviewId, { action }, req) {
  const review = await scoped(db.Review, workspaceId, 'Review').findByPkOrThrow(reviewId);
  const before = { status: review.status };
  const status = action === 'approve' ? 'approved' : 'rejected';
  await review.update({ status });

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: `review.${action}`,
    entityType: 'Review',
    entityId: review.id,
    before,
    after: { status },
    req,
  });
  return review;
}

/**
 * Public aggregate for a product — average + count over APPROVED reviews
 * only, plus the approved review list.
 */
async function publicRatingFor(workspaceId, productId) {
  const [agg] = await db.Review.findAll({
    where: { workspaceId, productId, status: 'approved' },
    attributes: [
      [fn('AVG', col('rating')), 'avg'],
      [fn('COUNT', col('id')), 'count'],
    ],
    raw: true,
  });
  const count = Number(agg.count) || 0;
  const average = count ? Math.round(Number(agg.avg) * 10) / 10 : null;

  const list = await db.Review.findAll({
    where: { workspaceId, productId, status: 'approved' },
    order: [['createdAt', 'DESC']],
    limit: 50,
    attributes: ['rating', 'comment', 'createdAt'],
  });

  return {
    rating: { average, count },
    reviews: list.map((r) => ({ rating: r.rating, comment: r.comment, createdAt: r.createdAt })),
  };
}

module.exports = { submitReview, listReviews, moderateReview, publicRatingFor };
