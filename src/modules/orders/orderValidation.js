'use strict';
const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');
const uuid = Joi.string().uuid();

const contact = Joi.object({
  fullName: Joi.string().max(200).required(),
  phone: Joi.string().max(32).required(),
  alternatePhone: Joi.string().max(32).allow(null, '').optional(),
  email: joiEmail().allow(null, '').optional(),
});

const address = Joi.object({
  country: Joi.string().length(2).required(),
  province: Joi.string().max(100).allow(null, '').optional(),
  city: Joi.string().max(100).required(),
  addressLine: Joi.string().max(500).required(),
  postalCode: Joi.string().max(20).allow(null, '').optional(),
  notes: Joi.string().max(500).allow(null, '').optional(),
});

module.exports = {
  create: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      items: Joi.array()
        .items(
          Joi.object({
            variantId: uuid.required(),
            offerId: uuid.optional(),
            quantity: Joi.number().integer().min(1).required(),
          })
        )
        .min(1)
        .required(),
      contact: contact.required(),
      shippingAddress: address.optional(),
      paymentMethod: Joi.string().valid('cod', 'card', 'wallet', 'bank_transfer').required(),
      discountCode: Joi.string().max(100).optional(),
      funnelId: uuid.optional(),
      websiteId: uuid.optional(),
      notes: Joi.string().max(2000).allow('').optional(),
    }),
  },
  get: { params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }) },
  cancel: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: Joi.object({ reason: Joi.string().min(1).max(500).required() }),
  },
  update: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: Joi.object({
      shippingAddress: address.optional(),
      notes: Joi.string().max(2000).allow('', null).optional(),
    }).min(1),
  },
  listShipments: { params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }) },
  createShipment: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: Joi.object({
      carrierCode: Joi.string().min(1).max(100).required(),
      waybillNumber: Joi.string().max(100).allow(null, '').optional(),
      trackingUrl: Joi.string().uri().max(500).allow(null, '').optional(),
    }),
  },
  updateShipment: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required(), shipmentId: uuid.required() }),
    body: Joi.object({
      status: Joi.string()
        .valid('created', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned', 'cancelled')
        .optional(),
      waybillNumber: Joi.string().max(100).allow(null, '').optional(),
      trackingUrl: Joi.string().uri().max(500).allow(null, '').optional(),
    }).min(1),
  },
  list: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({
      limit: Joi.number().integer().min(1).max(200).default(50),
      cursor: uuid.optional(),
      confirmationState: Joi.string().valid('pending', 'confirmed', 'rejected', 'unreachable', 'postponed').optional(),
      financialState: Joi.string().valid('pending', 'partially_paid', 'paid', 'failed', 'refunded', 'partially_refunded').optional(),
      fulfillmentState: Joi.string().valid('unfulfilled', 'partially_fulfilled', 'fulfilled', 'returned').optional(),
    }),
  },
};
