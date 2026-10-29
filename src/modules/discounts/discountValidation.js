'use strict';
const Joi = require('joi');
const { normalizePhone } = require('../../core/utils/phone');

const uuid = Joi.string().uuid();

const phoneList = Joi.array()
  .items(
    Joi.string()
      .trim()
      .max(32)
      .custom((value, helpers) => normalizePhone(value) || helpers.message(`${helpers.state.path.join('.')} is not a phone number`))
  )
  .max(500)
  .unique();

/**
 * The merchant's controls on a coupon (migration 730, discountRules.js). Left
 * out, a new coupon gets the column's default, which is the old behaviour;
 * the dashboard sends what the merchant chose.
 */
const controls = () => ({
  audience: Joi.string().valid('any', 'new', 'existing'),
  customerPhones: phoneList,
  vipTierIds: Joi.array().items(Joi.string().trim().max(64)).max(20).unique(),
  // Days 0-6 (0 = Sunday), minutes since midnight Cairo time; an end before the start runs past midnight.
  schedule: Joi.object({
    days: Joi.array().items(Joi.number().integer().min(0).max(6)).min(1).max(7).unique().required(),
    startMinute: Joi.number().integer().min(0).max(1439).required(),
    endMinute: Joi.number().integer().min(1).max(1440).required(),
  }).allow(null),
  maxDiscountAmount: Joi.number().integer().min(1).allow(null),
  minQuantity: Joi.number().integer().min(1).max(10000).allow(null),
  excludedProductIds: Joi.array().items(uuid).max(500),
  appliesToShipping: Joi.boolean(),
  appliesToDiscounted: Joi.boolean(),
  combinesWithOffers: Joi.boolean(),
  strictCustomerLimit: Joi.boolean(),
});

module.exports = {
  controls,
  create: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      code: Joi.string().max(100).uppercase().optional(),
      type: Joi.string().valid('percentage', 'fixed', 'free_shipping', 'buy_x_get_y').required(),
      value: Joi.number().integer().min(0).optional(),
      buyXGetYConfig: Joi.object().optional(),
      minimumSubtotal: Joi.number().integer().min(0).optional(),
      productRestrictions: Joi.array().items(uuid).default([]),
      collectionRestrictions: Joi.array().items(uuid).default([]),
      customerRestrictions: Joi.array().items(uuid).default([]),
      funnelRestrictions: Joi.array().items(uuid).default([]),
      startsAt: Joi.date().iso().optional(),
      endsAt: Joi.date().iso().optional(),
      usageLimit: Joi.number().integer().min(1).optional(),
      perCustomerLimit: Joi.number().integer().min(1).optional(),
      stackable: Joi.boolean().default(false),
      // Paused from the start (the form's "active" switch off).
      status: Joi.string().valid('active', 'disabled').optional(),
      ...controls(),
    }),
  },
  list: { params: Joi.object({ workspaceId: uuid.required() }) },
  get: { params: Joi.object({ workspaceId: uuid.required(), discountId: uuid.required() }) },
  report: {
    params: Joi.object({ workspaceId: uuid.required(), discountId: uuid.required() }),
    query: Joi.object({ limit: Joi.number().integer().min(1).max(1000).default(200) }),
  },
  remove: { params: Joi.object({ workspaceId: uuid.required(), discountId: uuid.required() }) },
  setStatus: {
    params: Joi.object({ workspaceId: uuid.required(), discountId: uuid.required() }),
    body: Joi.object({ status: Joi.string().valid('active', 'disabled', 'archived').required() }),
  },
  update: {
    params: Joi.object({ workspaceId: uuid.required(), discountId: uuid.required() }),
    body: Joi.object({
      code: Joi.string().max(100).uppercase().allow(null).optional(),
      type: Joi.string().valid('percentage', 'fixed', 'free_shipping', 'buy_x_get_y').optional(),
      value: Joi.number().integer().min(0).allow(null).optional(),
      buyXGetYConfig: Joi.object().allow(null).optional(),
      minimumSubtotal: Joi.number().integer().min(0).allow(null).optional(),
      productRestrictions: Joi.array().items(uuid).optional(),
      collectionRestrictions: Joi.array().items(uuid).optional(),
      customerRestrictions: Joi.array().items(uuid).optional(),
      funnelRestrictions: Joi.array().items(uuid).optional(),
      startsAt: Joi.date().iso().allow(null).optional(),
      endsAt: Joi.date().iso().allow(null).optional(),
      usageLimit: Joi.number().integer().min(1).allow(null).optional(),
      perCustomerLimit: Joi.number().integer().min(1).allow(null).optional(),
      stackable: Joi.boolean().optional(),
      status: Joi.string().valid('active', 'disabled', 'archived').optional(),
      ...controls(),
    }).min(1),
  },
};
