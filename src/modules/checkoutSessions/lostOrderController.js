'use strict';
const { forViewer } = require('../../core/utils/phoneMask');
const asyncHandler = require('express-async-handler');
const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');
const { refusesHidden } = require('../../core/utils/refusesHidden');
const service = require('./lostOrderService');

const uuid = Joi.string().uuid();

const filters = {
  tab: Joi.string().valid(...service.TABS).optional(),
  // The older parameter of this list, still honoured.
  view: Joi.string().valid('abandoned', 'converted', 'all').optional(),
  lostReason: Joi.string().valid(...service.LOST_REASONS).optional(),
  reviewStatus: Joi.string().valid(...service.REVIEW_STATUSES).optional(),
  recoveryStatus: Joi.string().valid(...service.RECOVERY_STATUSES).optional(),
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
  productId: uuid.optional(),
  source: Joi.string().valid('store', 'funnel').optional(),
};

const address = Joi.object({
  country: Joi.string().length(2).required(),
  province: Joi.string().max(100).allow(null, '').optional(),
  city: Joi.string().max(100).required(),
  addressLine: Joi.string().max(500).required(),
  postalCode: Joi.string().max(20).allow(null, '').optional(),
  notes: Joi.string().max(500).allow(null, '').optional(),
});

const schemas = {
  list: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({ ...filters, limit: Joi.number().integer().min(1).max(100).default(30), before: uuid.optional() }),
  },
  stats: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({ from: Joi.date().iso().optional(), to: Joi.date().iso().optional() }),
  },
  update: {
    params: Joi.object({ workspaceId: uuid.required(), sessionId: uuid.required() }),
    body: Joi.object({
      recoveryStatus: Joi.string().valid(...service.RECOVERY_STATUSES).optional(),
      reviewStatus: Joi.string().valid(...service.REVIEW_STATUSES).optional(),
    }).or('recoveryStatus', 'reviewStatus'),
  },
  one: { params: Joi.object({ workspaceId: uuid.required(), sessionId: uuid.required() }) },
  convert: {
    params: Joi.object({ workspaceId: uuid.required(), sessionId: uuid.required() }),
    body: refusesHidden(Joi.object({
      contact: Joi.object({
        fullName: Joi.string().max(200).optional(),
        phone: Joi.string().max(32).optional(),
        alternatePhone: Joi.string().max(32).allow(null, '').optional(),
        email: joiEmail().allow(null, '').optional(),
      }).optional(),
      shippingAddress: address.optional(),
      paymentMethod: Joi.string().valid(...require('../payments/methodNames').ORDER_METHODS).optional(),
      notes: Joi.string().max(2000).allow('').optional(),
      // The shopper's coupon is kept unless this replaces it (null drops it).
      discountCode: Joi.string().trim().max(100).allow(null).optional(),
      items: Joi.array()
        .items(Joi.object({ variantId: uuid.required(), offerId: uuid.optional(), quantity: Joi.number().integer().min(1).max(100).required() }))
        .min(1)
        .max(20)
        .optional(),
    })).default({}),
  },
  exportCsv: { params: Joi.object({ workspaceId: uuid.required() }), body: Joi.object(filters).default({}) },
};

// Phones are masked for roles without customers.reveal_sensitive (lostOrderPhones.js).
const list = asyncHandler(async (req, res) => res.json(forViewer(req, await service.list(req.tenant.workspaceId, req.query))));
const stats = asyncHandler(async (req, res) => res.json(await service.stats(req.tenant.workspaceId, req.query)));
const update = asyncHandler(async (req, res) =>
  res.json({ session: await service.update(req.tenant.workspaceId, req.params.sessionId, req.body, req) })
);
const convert = asyncHandler(async (req, res) =>
  res.status(201).json(await service.convert(req.tenant.workspaceId, req.params.sessionId, req.body || {}, req))
);
const remove = asyncHandler(async (req, res) => res.json(await service.remove(req.tenant.workspaceId, req.params.sessionId, req)));
const exportCsv = asyncHandler(async (req, res) => {
  // JSON rather than a file download: the dashboard builds the file from `csv`.
  const maskPhones = !req.tenant.hasPermission('customers.reveal_sensitive');
  const { csv, count } = await service.exportCsv(req.tenant.workspaceId, req.body || {}, { maskPhones });
  res.json({ csv, count, filename: `lost-orders-${new Date().toISOString().slice(0, 10)}.csv` });
});
// Public: GET /store/:workspaceId/recover/:token
const recover = asyncHandler(async (req, res) => res.json(await service.recover(req.tenant.workspaceId, req.params.token)));

module.exports = { schemas, list, stats, update, convert, remove, exportCsv, recover };
