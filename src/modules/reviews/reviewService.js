'use strict';

const { Op, UniqueConstraintError } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { scoped } = require('../../core/utils/scopedRepository');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const { PERMISSIONS } = require('../../core/security/permissions');
const { recordAudit } = require('../audit/auditService');
const rating = require('./reviewRating');

/*
 * Product and store reviews.
 *
 *   submit    anyone may send stars (1-5, required), a name, a text and up to
 *             MAX_PHOTOS photos, with a phone or from an order's signed link.
 *             It is linked to an order when it can be (the link's order, else
 *             the phone's customer's best order: reviewRating.bestOrderFor),
 *             waits as `pending`, and the team (products.manage) is told.
 *             One review per phone and per device for the same product, or
 *             for the store; a second one is refused, never merged.
 *   moderate  the merchant publishes it (with its text, or the stars alone),
 *             hides it, or deletes it. Nothing a shopper sends is shown before.
 *   rating    only published reviews from a delivered purchase count
 *             (reviewRating.js).
 *
 * Sending is closed unless REVIEWS_PUBLIC_SUBMISSION_ENABLED
 * (reviewController.submissionGate); reading and moderation are not.
 */

const MAX_PHOTOS = 4;
// One address, across products and the store, in an hour; the route's limiter caps a minute.
const MAX_PER_IP_HOUR = 10;

const ACTIONS = {
  approve: { status: 'approved', showText: true },
  approve_stars: { status: 'approved', showText: false },
  hide: { status: 'rejected' },
  // The older dashboard's name for hide.
  reject: { status: 'rejected' },
};

const alreadyReviewed = () => new AppError('ALREADY_REVIEWED', 'You have already reviewed this', 409);

/** The order a signed order link names, when it belongs to this store (and holds the product). */
async function orderFromLink(workspaceId, token, productId, transaction) {
  if (!token) return null;
  const order = await require('../storefront/orderTrackingExtras').orderFromToken(workspaceId, token);
  if (!order) return null;
  if (productId && !(order.items || []).some((item) => item.productId === productId)) return null;
  const customer = await db.Customer.findOne({ where: { id: order.customerId, workspaceId }, attributes: ['id', 'fullName', 'phoneNormalized'], transaction });
  return customer ? { order, customer } : null;
}

/** The reviewer's photos: pending uploads of this store sent by this visitor. Attached here so the sweep keeps them. */
async function takePhotos(workspaceId, uploadIds, visitorId, transaction) {
  const ids = [...new Set(uploadIds || [])];
  if (ids.length === 0) return [];
  if (ids.length > MAX_PHOTOS) throw new AppError('TOO_MANY_PHOTOS', `At most ${MAX_PHOTOS} photos`, 422);
  const rows = await db.CustomerUpload.findAll({
    where: { id: ids, workspaceId, status: 'pending', ...(visitorId ? { visitorId } : {}) },
    attributes: ['id'],
    lock: transaction.LOCK.UPDATE,
    transaction,
  });
  if (!visitorId || rows.length !== ids.length) {
    throw new AppError('INVALID_PHOTOS', 'A photo was not found; upload it again', 422, [{ field: 'photoUploadIds', message: 'Upload the photos again' }]);
  }
  await db.CustomerUpload.update({ status: 'attached', expiresAt: null }, { where: { id: ids, workspaceId }, transaction });
  return ids;
}

/**
 * A shopper's review. `kind` 'product' (with productId) or 'store'. Returns
 * { received, status, id }; the review waits for the merchant.
 */
async function submitReview(workspaceId, { kind = 'product', productId = null, body, visitorId = null, ip = null }) {
  const product =
    kind === 'product'
      ? await db.Product.findOne({ where: { id: productId, workspaceId, status: 'active' }, attributes: ['id', 'name'] })
      : null;
  if (kind === 'product' && !product) throw new NotFoundError('Product');

  if (ip && (await db.Review.count({ where: { workspaceId, requestIp: ip, createdAt: { [Op.gt]: new Date(Date.now() - 3600e3) } } })) >= MAX_PER_IP_HOUR) {
    throw new AppError('TOO_MANY_REQUESTS', 'Too many reviews from here — try again later', 429);
  }

  const review = await db.sequelize
    .transaction(async (transaction) => {
      // From the store's own message (an order's signed link): that order and its customer.
      const linked = await orderFromLink(workspaceId, body.orderToken, product && product.id, transaction);
      const phoneNormalized = linked ? linked.customer.phoneNormalized : normalizePhone(body.phone);
      if (!phoneNormalized) {
        throw new AppError('INVALID_PHONE', 'Enter a valid phone number', 422, [{ field: 'phone', message: 'Enter a valid phone number' }]);
      }
      const customer = linked
        ? linked.customer
        : await db.Customer.findOne({ where: { workspaceId, phoneNormalized }, attributes: ['id', 'fullName', 'phoneNormalized'], transaction });
      const order = linked
        ? { id: linked.order.id }
        : await rating.bestOrderFor(workspaceId, customer && customer.id, product && product.id, transaction);

      const same = { workspaceId, kind, ...(product ? { productId: product.id } : {}) };
      const deviceId = body.deviceId || null;
      const duplicate = await db.Review.findOne({
        where: {
          ...same,
          [Op.or]: [{ phoneNormalized }, ...(deviceId ? [{ deviceId }] : []), ...(customer && product ? [{ customerId: customer.id }] : [])],
        },
        attributes: ['id'],
        transaction,
      });
      if (duplicate) throw alreadyReviewed();

      const photoUploadIds = await takePhotos(workspaceId, body.photoUploadIds, visitorId, transaction);
      const row = await db.Review.create(
        {
          workspaceId,
          kind,
          productId: product ? product.id : null,
          customerId: customer ? customer.id : null,
          orderId: order ? order.id : null,
          authorName: body.name || (customer && customer.fullName ? String(customer.fullName).slice(0, 120) : null),
          rating: body.rating,
          comment: body.comment || null,
          photoUploadIds,
          source: 'customer',
          status: 'pending',
          showText: true,
          phoneNormalized,
          deviceId,
          requestIp: ip ? String(ip).slice(0, 45) : null,
        },
        { transaction }
      );
      await recordAudit({
        workspaceId,
        actorUserId: null,
        action: 'review.submit',
        entityType: 'Review',
        entityId: row.id,
        after: { kind, rating: row.rating, status: 'pending', productId: row.productId },
        transaction,
      });
      return row;
    })
    .catch((err) => {
      // Two sends racing past the check above: the unique phone index decides.
      if (err instanceof UniqueConstraintError) throw alreadyReviewed();
      throw err;
    });

  await notifyTeam(workspaceId, review, product);
  return { received: true, status: 'pending', id: review.id };
}

/** The bell (and the channels the team chose): a new review waits for them. Never fails the send. */
async function notifyTeam(workspaceId, review, product) {
  try {
    await require('../notifications/merchantNotificationService').create(workspaceId, {
      type: 'review.new',
      title: product ? `تقييم جديد على ${product.name}` : 'تقييم جديد للمتجر',
      body: `${review.rating} من 5 — في انتظار موافقتك`,
      link: '/reviews?status=pending',
      data: { reviewId: review.id, kind: review.kind, productId: product ? product.id : null, productName: product ? product.name : null, rating: review.rating },
      dedupeKey: `review.new:${review.id}`,
    });
  } catch (err) {
    logger.warn(`[reviews] notify ${review.id}: ${err.message}`);
  }
}

// ------------------------------------------------------------------ staff --

/** Photos as staff see them: a merchant's links as typed, a shopper's through a signed, short-lived link. */
function staffPhotos(review) {
  const { signedUploadUrl } = require('../customerUploads/uploadLinks');
  return [...(Array.isArray(review.photos) ? review.photos : []), ...(review.photoUploadIds || []).map((id) => signedUploadUrl(id).url)];
}

/**
 * The review list for the dashboard: newest first, by status and kind, with
 * who wrote it and whether they bought. The customer's phone and email show
 * only to someone who may see customers (customers.view), and are hidden on a
 * locked store's locked customers (orders/orderLock) like everywhere else.
 */
async function listReviews(workspaceId, { status, kind, source, productId, limit, offset = 0 } = {}, req = null) {
  const where = { workspaceId };
  if (status) where.status = status;
  if (kind) where.kind = kind;
  if (source) where.source = source;
  if (productId) where.productId = productId;
  const { rows, count } = await db.Review.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    ...(limit ? { limit, offset } : {}),
    include: [
      { model: db.Product, as: 'product', attributes: ['id', 'name'] },
      { model: db.Customer, as: 'customer', attributes: ['id', 'fullName', 'phoneRaw', 'phoneNormalized', 'email'] },
    ],
  });
  const orders = await rating.orderStates(workspaceId, rows.map((r) => r.orderId));
  const counted = await rating.verifiedIds(
    workspaceId,
    rows.filter((r) => r.status === 'approved').map((r) => r.id)
  );
  const orderLock = require('../orders/orderLock');
  const ctx = await orderLock.contextFor(workspaceId);
  const locked = await orderLock.lockedCustomerIds(ctx, workspaceId, rows.map((r) => r.customerId));
  const seesContact = !req || !req.tenant || req.tenant.hasPermission(PERMISSIONS.CUSTOMERS_VIEW);

  const reviews = rows.map((row) => {
    const order = row.orderId ? orders.get(row.orderId) : null;
    const hidden = Boolean(row.customerId && locked.has(row.customerId));
    const hide = (value) => (hidden && value ? orderLock.MASK : value);
    const customer = row.customer
      ? {
          id: row.customer.id,
          fullName: hide(row.customer.fullName),
          phone: seesContact ? hide(row.customer.phoneRaw || row.customer.phoneNormalized) : null,
          email: seesContact ? hide(row.customer.email) : null,
        }
      : null;
    return {
      id: row.id,
      kind: row.kind,
      productId: row.productId,
      product: row.product ? { id: row.product.id, name: row.product.name } : null,
      rating: row.rating,
      comment: row.comment,
      photos: staffPhotos(row),
      status: row.status,
      showText: row.showText,
      source: row.source,
      // An external review's site, its link and the day it was written there (manualReviews.js).
      externalSource: row.externalSource,
      externalSourceLabel: row.externalSourceLabel,
      externalUrl: row.externalUrl,
      reviewedAt: row.reviewedAt,
      authorName: hide(row.authorName),
      // The phone the reviewer typed (also when no customer has it).
      reviewerPhone: seesContact ? hide(row.phoneNormalized) : null,
      customer,
      contactLocked: hidden,
      purchase: {
        // delivered | ordered | cancelled | returned | none (never ordered, or a review added by hand)
        state: order ? order.state : 'none',
        orderId: order ? order.id : null,
        orderNumber: order ? order.orderNumber : null,
      },
      // Published and from a delivered purchase: it moves the stars shoppers see.
      counted: counted.has(row.id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
  return { reviews, total: count, counts: await countsByStatus(workspaceId) };
}

/** { pending, approved, rejected } — the dashboard's tabs and its "waiting" badge. */
async function countsByStatus(workspaceId) {
  const rows = await db.Review.findAll({ where: { workspaceId }, attributes: ['status', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'n']], group: ['status'], raw: true });
  const out = { pending: 0, approved: 0, rejected: 0 };
  for (const row of rows) out[row.status] = Number(row.n);
  return out;
}

async function moderateReview(workspaceId, reviewId, { action }, req) {
  const review = await scoped(db.Review, workspaceId, 'Review').findByPkOrThrow(reviewId);
  const before = { status: review.status, showText: review.showText };
  const change = ACTIONS[action];
  await review.update(change);

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: `review.${action}`,
    entityType: 'Review',
    entityId: review.id,
    before,
    after: { status: review.status, showText: review.showText },
    req,
  });
  return review;
}

/** Deletes any review, a shopper's photos with it (storage first: a failure leaves the photo for no one, never shown). */
async function deleteReview(workspaceId, reviewId, req) {
  const review = await db.Review.findOne({ where: { id: reviewId, workspaceId } });
  if (!review) throw new NotFoundError('Review');
  const before = review.toJSON();
  const uploads = review.photoUploadIds && review.photoUploadIds.length
    ? await db.CustomerUpload.findAll({ where: { id: review.photoUploadIds, workspaceId }, attributes: ['id', 'path'] })
    : [];
  await db.sequelize.transaction(async (transaction) => {
    await review.destroy({ transaction });
    if (uploads.length) await db.CustomerUpload.destroy({ where: { id: uploads.map((u) => u.id), workspaceId }, transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: review.source === 'customer' ? 'review.delete' : 'review.delete_manual',
      entityType: 'Review',
      entityId: reviewId,
      before,
      req,
      transaction,
    });
  });
  const { getStorage } = require('../media/storage');
  for (const upload of uploads) {
    await getStorage()
      .removePrivate(upload.path)
      .catch((err) => logger.warn(`[reviews] photo ${upload.id} left in storage: ${err.message}`));
  }
  return { deleted: true, id: reviewId };
}

// ----------------------------------------------------------------- public --

/** "Mona" — the public name is the first word only; the rest stays with the merchant. */
function publicAuthor(review) {
  const name = review.authorName || (review.customer && review.customer.fullName) || '';
  const first = String(name).trim().split(/\s+/).filter(Boolean)[0];
  return first || null;
}

/** A shopper's photo as the storefront links it (reviewController.photo serves it while the review shows it). */
function publicPhotoUrl(workspaceId, uploadId) {
  return `${env.appUrl.replace(/\/$/, '')}/api/${env.apiVersion}/store/${workspaceId}/review-photos/${uploadId}`;
}

/**
 * Published reviews as a shopper sees them: first name, stars, and the text
 * and photos unless published as stars only. Reviews brought from another
 * site are never in this list: they show apart (publicExternal).
 */
async function publicList(workspaceId, where, limit = 50) {
  const rows = await db.Review.findAll({
    where: { workspaceId, status: 'approved', source: { [Op.ne]: 'external' }, ...where },
    order: [['createdAt', 'DESC']],
    limit,
    attributes: ['id', 'rating', 'comment', 'createdAt', 'authorName', 'photos', 'photoUploadIds', 'source', 'showText'],
    include: [{ model: db.Customer, as: 'customer', attributes: ['fullName'], required: false }],
  });
  const verified = await rating.verifiedIds(workspaceId, rows.map((r) => r.id));
  return rows.map((row) => ({
    id: row.id,
    rating: row.rating,
    comment: row.showText ? row.comment : null,
    createdAt: row.createdAt,
    authorName: publicAuthor(row),
    photos: row.showText
      ? [...(Array.isArray(row.photos) ? row.photos : []), ...(row.photoUploadIds || []).map((id) => publicPhotoUrl(workspaceId, id))]
      : [],
    // From a delivered purchase of it (the reviews that move the stars).
    verified: verified.has(row.id),
  }));
}

/**
 * Published reviews the merchant brought from other sites, apart from the
 * shoppers' own: each with its source (its name for "other"), a link to the
 * original and the day it was written there. Never a verified buyer, never
 * in the stars.
 */
async function publicExternal(workspaceId, where, limit = 50) {
  const rows = await db.Review.findAll({
    where: { workspaceId, status: 'approved', source: 'external', ...where },
    order: [
      ['reviewedAt', 'DESC NULLS LAST'],
      ['createdAt', 'DESC'],
    ],
    limit,
    attributes: ['id', 'rating', 'comment', 'createdAt', 'authorName', 'photos', 'showText', 'externalSource', 'externalSourceLabel', 'externalUrl', 'reviewedAt'],
  });
  return rows.map((row) => ({
    id: row.id,
    rating: row.rating,
    comment: row.showText ? row.comment : null,
    authorName: publicAuthor(row),
    photos: row.showText && Array.isArray(row.photos) ? row.photos : [],
    source: row.externalSource,
    sourceLabel: row.externalSource === 'other' ? row.externalSourceLabel || null : null,
    url: row.externalUrl || null,
    reviewedAt: row.reviewedAt || null,
    createdAt: row.createdAt,
    verified: false,
  }));
}

/** A product's stars (delivered purchases only), its latest published reviews, and those brought from other sites. */
async function publicProductReviews(workspaceId, productId) {
  return {
    rating: await rating.productRating(workspaceId, productId),
    reviews: await publicList(workspaceId, { kind: 'product', productId }),
    externalReviews: await publicExternal(workspaceId, { kind: 'product', productId }),
  };
}

/** The store's stars, its latest published store reviews, and those brought from other sites. */
async function publicStoreReviews(workspaceId) {
  return {
    rating: await rating.storeRating(workspaceId),
    reviews: await publicList(workspaceId, { kind: 'store' }),
    externalReviews: await publicExternal(workspaceId, { kind: 'store' }),
  };
}

/** A shopper's photo, only while a published review shows it (not stars only). Null otherwise. */
async function publicPhoto(workspaceId, uploadId) {
  const review = await db.Review.findOne({
    where: { workspaceId, status: 'approved', showText: true, photoUploadIds: { [Op.contains]: [uploadId] } },
    attributes: ['id'],
  });
  if (!review) return null;
  return require('../customerUploads/customerUploadService').readUpload(uploadId);
}

/** Kept for callers of the old name: the product's rating and published reviews. */
const publicRatingFor = publicProductReviews;

module.exports = {
  MAX_PHOTOS,
  ACTIONS,
  submitReview,
  listReviews,
  countsByStatus,
  moderateReview,
  deleteReview,
  publicAuthor,
  publicProductReviews,
  publicStoreReviews,
  publicExternal,
  publicPhoto,
  publicRatingFor,
};
