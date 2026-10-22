'use strict';

const Joi = require('joi');
const { workspaceRef } = require('../../core/utils/workspaceSlug');

const uuid = Joi.string().uuid();
// Commerce events the storefront tracker emits; any other name is a custom
// event (Umami event_type 2). Names that start with a spreadsheet formula
// trigger are rejected so analytics exports can't carry CSV injection.
const EVENT_NAMES = ['page_view', 'view_content', 'add_to_cart', 'begin_checkout', 'add_payment_info', 'purchase', 'lead'];
const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;
const safeString = (max) => Joi.string().max(max).pattern(FORMULA_TRIGGER_RE, { invert: true });
// `metadata` / `data` are opaque; the service drops them when they serialise past 2KB.
const metadata = Joi.object().unknown(true);

const event = Joi.object({
  name: safeString(100).required(),
  path: Joi.string().max(500).optional(),
  url: Joi.string().max(2000).optional(), // full href or a path
  title: Joi.string().max(500).optional(),
  referrer: Joi.string().max(500).allow('').optional(), // a path when same-origin
  tag: safeString(50).optional(),
  currency: Joi.string().length(3).uppercase().optional(),
  data: metadata.optional(),
  websiteId: uuid.optional(),
  funnelId: uuid.optional(),
  orderId: uuid.optional(),
  revenueAmount: Joi.number().integer().min(0).optional(),
  dedupeId: Joi.string().max(100).optional(),
  // The id the browser pixel sent with this same event, so the server-side
  // copy (marketing/browserEventRelay.js) dedupes against it.
  eventId: Joi.string().max(64).pattern(/^[A-Za-z0-9_.:-]+$/).optional(),
  occurredAt: Joi.date().iso().optional(),
  metadata: metadata.optional(),
});

const attribution = Joi.object({
  source: Joi.string().max(100).optional(),
  medium: Joi.string().max(100).optional(),
  campaign: Joi.string().max(150).optional(),
  referrer: Joi.string().max(500).optional(),
  landingPage: Joi.string().max(500).optional(),
  clickIds: Joi.object({
    gclid: Joi.string().max(200).optional(),
    fbclid: Joi.string().max(200).optional(),
    ttclid: Joi.string().max(200).optional(),
  }).optional(),
});

const touchField = Joi.string().max(500).allow('');
const touch = Joi.object({
  source: touchField,
  medium: touchField,
  campaign: touchField,
  content: touchField,
  term: touchField,
  adId: touchField,
  fbclid: touchField,
  ttclid: touchField,
  gclid: touchField,
  scCid: touchField,
  ref: touchField,
  referrer: touchField,
  landingPage: touchField,
  at: touchField,
});

module.exports = {
  EVENT_NAMES,
  ingest: {
    params: Joi.object({ workspaceId: workspaceRef().required() }),
    body: Joi.object({
      visitorId: Joi.string().min(8).max(64).required(),
      sessionId: Joi.string().min(8).max(64).required(),
      screen: Joi.string().max(11).pattern(/^\d{1,5}x\d{1,5}$/).optional(),
      language: Joi.string().max(35).optional(),
      hostname: Joi.string().max(100).optional(),
      // navigator.webdriver: the browser is driven by automation. Read only by
      // the events guard (traffic/), which keeps such a session out of the numbers.
      automation: Joi.boolean().optional(),
      attribution: attribution.optional(),
      // The 30-day first/last touch cookie (SPEC §13.4), copied onto an order
      // by marketing/orderAttribution.js when its purchase event arrives.
      touches: Joi.object({ first: touch, last: touch }).optional(),
      // Browser ids the ad platforms match server events on (their own
      // cookies / click ids) and the products viewed this visit, for
      // product-scoped pixels. Used only by marketing/browserEventRelay.js.
      pixel: Joi.object({
        fbp: Joi.string().max(200),
        fbc: Joi.string().max(500),
        ttp: Joi.string().max(200),
        ttclid: Joi.string().max(500),
        scCid: Joi.string().max(500),
        productIds: Joi.array().items(uuid).max(50),
      }).optional(),
      events: Joi.array().items(event).min(1).max(20).required(),
    }),
  },
};
