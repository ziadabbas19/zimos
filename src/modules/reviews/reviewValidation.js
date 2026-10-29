'use strict';

const Joi = require('joi');
const { workspaceRef } = require('../../core/utils/workspaceSlug');
const { cleanText } = require('../platformSettings/rules');

const uuid = Joi.string().uuid();

/** Text a shopper typed, as the store will show it: no tags, no control or hidden characters. */
const shopperText = (max, multiline) =>
  Joi.string()
    .allow('', null)
    .max(max * 4)
    .custom((value, helpers) => {
      const cleaned = cleanText(value, { multiline });
      if (cleaned.length > max) return helpers.message(`${helpers.state.path.join('.')} must be at most ${max} characters`);
      return cleaned || null;
    });

// What a shopper sends with a review. `phone` is required unless `orderToken`
// (an order's signed link, from the store's own message) names the order;
// reviewService refuses an invalid one with INVALID_PHONE.
const submitBody = Joi.object({
  rating: Joi.number().integer().min(1).max(5).required(),
  phone: Joi.string().trim().max(32).allow('', null),
  name: shopperText(80, false),
  comment: shopperText(2000, true),
  photoUploadIds: Joi.array().items(uuid).max(4).unique().default([]),
  orderToken: Joi.string().trim().max(200).allow('', null),
  // The storefront's device id, for "one review per device".
  deviceId: Joi.string().trim().min(8).max(128).allow('', null),
});

module.exports = {
  // Shopper-facing, mounted under the public /store/:workspaceId routes, so
  // the workspace may be named by UUID or by store slug. The staff routes
  // below stay UUID-only.
  submit: {
    params: Joi.object({ workspaceId: workspaceRef().required(), productId: uuid.required() }),
    body: submitBody,
  },
  submitStore: {
    params: Joi.object({ workspaceId: workspaceRef().required() }),
    body: submitBody,
  },
  storeList: { params: Joi.object({ workspaceId: workspaceRef().required() }) },
  photo: { params: Joi.object({ workspaceId: workspaceRef().required(), uploadId: uuid.required() }) },
  list: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({
      status: Joi.string().valid('pending', 'approved', 'rejected').optional(),
      kind: Joi.string().valid('product', 'store').optional(),
      productId: uuid.optional(),
      // Without a limit every review comes back, as before.
      limit: Joi.number().integer().min(1).max(200).optional(),
      offset: Joi.number().integer().min(0).max(100000).default(0),
    }),
  },
  summary: { params: Joi.object({ workspaceId: uuid.required() }) },
  moderate: {
    params: Joi.object({ workspaceId: uuid.required(), reviewId: uuid.required() }),
    // approve = publish with the text; approve_stars = the stars alone; hide (or reject, the older name).
    body: Joi.object({ action: Joi.string().valid('approve', 'approve_stars', 'hide', 'reject').required() }),
  },
  remove: { params: Joi.object({ workspaceId: uuid.required(), reviewId: uuid.required() }) },
};
