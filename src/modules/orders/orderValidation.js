'use strict';
const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');
const { refusesHidden } = require('../../core/utils/refusesHidden');
const { STAGES } = require('./orderStage');
const { ORDER_SORT_KEYS, DEFAULT_ORDER_SORT } = require('./orderSort');
const { CHANNELS: CONFIRMATION_CHANNELS } = require('../cod/confirmationValidation');
const uuid = Joi.string().uuid();

// carrierAddress.cityId / districtId: required together, unless the address
// is sent as `path` or `names` instead.
const carrierIdUnlessPathOrNames = () =>
  Joi.string()
    .max(100)
    .when('path', {
      is: Joi.exist(),
      then: Joi.forbidden(),
      otherwise: Joi.when('names', { is: Joi.exist(), then: Joi.forbidden(), otherwise: Joi.required() }),
    });

// The search box and date range, shared by the list and the tab counts so the
// two can never disagree about what they are counting. `q` is trimmed before
// the length check — two spaces are not a two-character search.
const search = {
  q: Joi.string().trim().min(2).max(100).optional(),
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
  // SPEC §4.3 filters (orderFilters.js). Archived orders are left out unless asked for.
  archived: Joi.string().valid('exclude', 'only', 'include').optional(),
  tag: Joi.string().trim().min(1).max(40).optional(),
  source: Joi.string().valid('store', 'funnel', 'manual', 'api', 'import', 'upsell').optional(),
  paymentMethod: Joi.string().valid(...require('../payments/methodNames').ORDER_METHODS).optional(),
  governorate: Joi.string().trim().min(1).max(100).optional(),
  carrier: Joi.string().trim().min(1).max(100).optional(),
  seen: Joi.boolean().optional(),
  test: Joi.boolean().optional(),
  // For integrations that sync (public API): changed since, and containing a product.
  updatedSince: Joi.date().iso().optional(),
  productId: Joi.string().uuid().optional(),
  riskLevel: Joi.string().valid('low', 'moderate', 'high').optional(),
  dataQuality: Joi.string().valid('good', 'low').optional(),
  ipCountry: Joi.string().trim().pattern(/^[A-Za-z]{2}$/).optional(),
  discountCode: Joi.string().trim().min(1).max(100).optional(),
  utmSource: Joi.string().trim().min(1).max(100).optional(),
  utmCampaign: Joi.string().trim().min(1).max(200).optional(),
  funnelId: Joi.string().uuid().optional(),
  // Up to 100 order ids, comma-separated ("export selected").
  ids: Joi.string()
    .pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){0,99}$/i)
    .optional(),
};

const tagList = Joi.array().items(Joi.string().trim().min(1).max(40)).max(20);

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
  lockedSummary: { params: Joi.object({ workspaceId: uuid.required() }) },
  settleLocked: { params: Joi.object({ workspaceId: uuid.required() }), body: Joi.object({}).default({}) },
  create: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: refusesHidden(Joi.object({
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
      paymentMethod: Joi.string().valid(...require('../payments/methodNames').ORDER_METHODS).required(),
      discountCode: Joi.string().max(100).optional(),
      funnelId: uuid.optional(),
      websiteId: uuid.optional(),
      notes: Joi.string().max(2000).allow('').optional(),
      // Staff may set the shipping themselves (minor units); omitted, it is calculated.
      shippingAmount: Joi.number().integer().min(0).max(100000000).optional(),
    })),
  },
  // POST /manual/preview — the same body, priced and not saved; the customer may still be blank.
  manualPreview: {
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
      contact: Joi.object({ fullName: Joi.string().max(200).allow(''), phone: Joi.string().max(32).allow('') })
        .unknown(true)
        .optional(),
      shippingAddress: Joi.object({
        country: Joi.string().length(2).required(),
        province: Joi.string().max(100).allow(null, '').optional(),
        city: Joi.string().max(100).allow('').optional(),
        addressLine: Joi.string().max(500).allow('').optional(),
      })
        .unknown(true)
        .optional(),
      paymentMethod: Joi.string().valid(...require('../payments/methodNames').ORDER_METHODS).default('cod'),
      discountCode: Joi.string().max(100).optional(),
      shippingAmount: Joi.number().integer().min(0).max(100000000).optional(),
    }),
  },
  manualCustomer: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({ phone: Joi.string().trim().min(6).max(32).required() }),
  },
  manualOptions: { params: Joi.object({ workspaceId: uuid.required() }) },
  get: { params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }) },
  cancel: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: Joi.object({
      reason: Joi.string().min(1).max(500).required(),
      // The merchant cancelled the order's courier booking in the courier's
      // own dashboard (couriers without a cancel API only).
      acknowledgeManualCancel: Joi.boolean().optional(),
      // Tell the customer (their email, the store's automations); unset: as the store's settings say.
      notifyCustomer: Joi.boolean().optional(),
      // Give this much back once cancelled (refunds.manage; orderCancelRefund.js).
      refundAmount: Joi.number().integer().min(1).optional(),
    }),
  },
  // PATCH /:orderId/status — see orderStageChange.js for what each move does.
  changeStatus: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: Joi.object({
      status: Joi.string().valid(...STAGES).required(),
      reason: Joi.string().trim().max(500).allow('', null).optional(),
      // → needs_follow_up: which of the two it is. Defaults to unreachable.
      followUp: Joi.string().valid('unreachable', 'postponed').optional(),
      // → cancelled, on an order booked with a courier that has no cancel API.
      acknowledgeManualCancel: Joi.boolean().optional(),
      // A shipping stage on an order with no shipment yet: the manual
      // shipment that is created to carry it.
      carrierCode: Joi.string().trim().min(1).max(100).optional(),
      // One of the store's own couriers (modules/couriers): wins over carrierCode.
      courierId: uuid.optional(),
      waybillNumber: Joi.string().trim().max(100).allow('', null).optional(),
      trackingUrl: Joi.string().uri().max(500).allow('', null).optional(),
    }),
  },
  // PATCH /:orderId/meta — tags (replace, or add/remove), test, seen, archive.
  updateMeta: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: Joi.object({
      tags: tagList.optional(),
      addTags: tagList.optional(),
      removeTags: tagList.optional(),
      isTest: Joi.boolean().optional(),
      isSeen: Joi.boolean().optional(),
      archived: Joi.boolean().optional(),
    }).min(1),
  },
  listTags: { params: Joi.object({ workspaceId: uuid.required() }) },
  // POST /import-tracking — the CSV file's text (trackingImport.js).
  importTracking: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({ csv: Joi.string().min(1).max(1500000).required() }),
  },
  // POST /documents/waybills and /documents/manifest — PDFs (orderDocuments.js).
  waybillsPdf: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      orderIds: Joi.array().items(uuid).min(1).max(200).required(),
      format: Joi.string().valid('a4x4', '10x15').default('a4x4'),
    }),
  },
  manifestPdf: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      orderIds: Joi.array().items(uuid).min(1).max(200).optional(),
      date: Joi.date().iso().optional(),
      carrier: Joi.string().trim().max(100).optional(),
      // One of the store's own couriers (modules/couriers).
      courierId: uuid.optional(),
    }),
  },
  // POST /:orderId/items/preview and PUT /:orderId/items — the whole new list of lines.
  editItems: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: Joi.object({
      items: Joi.array()
        .items(
          Joi.object({
            variantId: uuid.required(),
            offerId: uuid.allow(null).optional(),
            quantity: Joi.number().integer().min(1).max(10000).required(),
          })
        )
        .min(1)
        .max(100)
        .required(),
    }),
  },
  refundQuote: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: Joi.object({
      lines: Joi.array()
        .items(Joi.object({ orderItemId: uuid.required(), quantity: Joi.number().integer().min(1).required() }))
        .min(1)
        .required(),
    }),
  },
  fulfill: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: Joi.object({
      carrierCode: Joi.string().trim().min(1).max(100).optional(),
      trackingNumber: Joi.string().trim().max(100).allow('', null).optional(),
      trackingUrl: Joi.string().uri().max(500).allow('', null).optional(),
    }),
  },
  // POST /bulk — orderBulkService.js. The orders are named, or are whatever
  // the list shows for `filter` (its own query, without paging).
  bulk: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      action: Joi.string()
        .valid('set_status', 'add_tag', 'remove_tag', 'archive', 'unarchive', 'mark_seen', 'mark_unseen', 'ship')
        .required(),
      orderIds: Joi.array().items(uuid).min(1).max(500).optional(),
      filter: Joi.object({
        sort: Joi.string()
          .valid(...ORDER_SORT_KEYS)
          .optional(),
        stage: Joi.string().valid(...STAGES).optional(),
        ...search,
      })
        .unknown(true)
        .optional(),
      payload: Joi.object({
        status: Joi.string().valid(...STAGES).optional(),
        reason: Joi.string().trim().max(500).allow('', null).optional(),
        followUp: Joi.string().valid('unreachable', 'postponed').optional(),
        tags: tagList.optional(),
        carrierCode: Joi.string().trim().min(1).max(100).optional(),
        // set_status to a shipping stage: the store's courier who takes the orders.
        courierId: uuid.optional(),
        notes: Joi.string().max(500).allow('', null).optional(),
      }).default({}),
    }).xor('orderIds', 'filter'),
  },
  // GET /:orderId/neighbors — the list's own filters, search and sort.
  neighbors: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    query: Joi.object({
      sort: Joi.string()
        .valid(...ORDER_SORT_KEYS)
        .default(DEFAULT_ORDER_SORT),
      stage: Joi.string().valid(...STAGES).optional(),
      ...search,
    }),
  },
  addNote: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: Joi.object({
      body: Joi.string().trim().min(1).max(2000).required(),
      visibility: Joi.string().valid('internal', 'public').default('internal'),
    }),
  },
  deleteNote: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required(), noteId: uuid.required() }),
  },
  confirm: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: Joi.object({
      notes: Joi.string().max(1000).allow('').optional(),
      // How the customer was reached — see cod/confirmationValidation.js.
      channel: Joi.string().valid(...CONFIRMATION_CHANNELS).optional(),
    }),
  },
  update: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: refusesHidden(Joi.object({
      shippingAddress: address.optional(),
      notes: Joi.string().max(2000).allow('', null).optional(),
      // The customer's details as written on the order (a typo in the name or number).
      contact: contact.optional(),
    }).min(1)),
  },
  listShipments: { params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }) },
  createShipment: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: refusesHidden(Joi.object({
      carrierCode: Joi.string().min(1).max(100).required(),
      waybillNumber: Joi.string().max(100).allow(null, '').optional(),
      trackingUrl: Joi.string().uri().max(500).allow(null, '').optional(),
      // Connected couriers only (see modules/shipping/carriers). The carrier's
      // own ids for the drop-off address, sent when the order's free-text
      // address couldn't be matched (422 CARRIER_ADDRESS_UNMATCHED). Either
      // cityId + districtId (city/district carriers) or `path`, one id per
      // address level, top first (any carrier). Or `names`: the carrier's own
      // names typed by the merchant, one per level, only while the carrier
      // refuses this account its address list (422
      // CARRIER_ADDRESS_NAMES_REQUIRED).
      carrierAddress: Joi.object({
        names: Joi.array().items(Joi.string().trim().max(100).allow('')).min(1).max(6).optional(),
        path: Joi.array()
          .items(Joi.string().max(100))
          .min(1)
          .max(6)
          .when('names', { is: Joi.exist(), then: Joi.forbidden(), otherwise: Joi.optional() }),
        cityId: carrierIdUnlessPathOrNames(),
        districtId: carrierIdUnlessPathOrNames(),
      }).optional(),
      notes: Joi.string().max(500).allow(null, '').optional(),
      // Connected couriers only: book as this weight tier instead of the one
      // stored on the order at checkout.
      tierId: uuid.optional(),
    })),
  },
  updateShipment: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required(), shipmentId: uuid.required() }),
    body: Joi.object({
      status: Joi.string()
        .valid('created', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned', 'cancelled')
        .optional(),
      waybillNumber: Joi.string().max(100).allow(null, '').optional(),
      trackingUrl: Joi.string().uri().max(500).allow(null, '').optional(),
      // With status 'cancelled' on a booking whose courier has no cancel API.
      acknowledgeManualCancel: Joi.boolean().optional(),
    })
      .min(1)
      .or('status', 'waybillNumber', 'trackingUrl'),
  },
  list: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({
      limit: Joi.number().integer().min(1).max(200).default(50),
      cursor: uuid.optional(),
      // A whitelisted key (orderSort.js); a cursor only pages the sort it came from.
      sort: Joi.string()
        .valid(...ORDER_SORT_KEYS)
        .default(DEFAULT_ORDER_SORT),
      confirmationState: Joi.string().valid('pending', 'confirmed', 'rejected', 'unreachable', 'postponed').optional(),
      financialState: Joi.string().valid('pending', 'partially_paid', 'paid', 'failed', 'refunded', 'partially_refunded').optional(),
      fulfillmentState: Joi.string().valid('unfulfilled', 'partially_fulfilled', 'fulfilled', 'returned').optional(),
      stage: Joi.string().valid(...STAGES).optional(),
      ...search,
    }),
  },
  pipeline: {
    params: Joi.object({ workspaceId: uuid.required() }),
    // No `stage`: the counts are the answer for every stage at once.
    query: Joi.object(search),
  },
};
