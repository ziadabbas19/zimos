'use strict';

const Joi = require('joi');
const { fontPairSchema } = require('../fonts/fontValidation');

/*
 * What a product carries beyond its basics (SPEC §7.1–7.4): how its options
 * are drawn, the settings of its storefront page, its structured content, and
 * the one price rule that depends on them — a countdown offer that really
 * ends.
 *
 * `page_settings` keeps the spec's snake_case keys. Only what the merchant
 * changed is stored; resolvePageSettings fills in the rest, so the defaults
 * (which are what the product page did before these settings existed) can
 * change in one place.
 */

const OPTION_DISPLAY_TYPES = ['buttons', 'dropdown', 'color', 'image'];

const httpUrl = Joi.string()
  .uri({ scheme: ['http', 'https'] })
  .max(1000);

// e.g. { name: 'Color', values: ['Red'], displayType: 'color', swatches: { Red: '#ff0000' } }
const optionSchema = Joi.object({
  name: Joi.string().max(100).required(),
  values: Joi.array().items(Joi.string().max(100)).max(100),
  displayType: Joi.string().valid(...OPTION_DISPLAY_TYPES),
  // value → hex colour, for displayType 'color'.
  swatches: Joi.object()
    .pattern(Joi.string().max(100), Joi.string().pattern(/^#[0-9a-fA-F]{6}$/))
    .max(100),
  // value → picture, for displayType 'image'.
  images: Joi.object().pattern(Joi.string().max(100), httpUrl).max(100),
});

const PAGE_SETTINGS_DEFAULTS = Object.freeze({
  // The first in-stock variant starts chosen; off: the shopper picks every option first.
  auto_select_variant: true,
  skip_cart: false,
  buy_now_text: null,
  sticky_buy_button: true,
  inline_checkout: true,
  checkout_before_description: true,
  reviews_enabled: true,
  hide_header: false,
  hide_quantity_selector: false,
  hidden: false,
  hide_related_products: false,
  landing_page_id: null,
  countdown: null,
  // This product's own font on its page, over the store's product font ({ ar, en } ids, fonts/fontValidation.js).
  font: null,
});

const pageSettingsSchema = Joi.object({
  auto_select_variant: Joi.boolean(),
  skip_cart: Joi.boolean(),
  buy_now_text: Joi.string().trim().max(40).allow(null, ''),
  sticky_buy_button: Joi.boolean(),
  inline_checkout: Joi.boolean(),
  checkout_before_description: Joi.boolean(),
  reviews_enabled: Joi.boolean(),
  hide_header: Joi.boolean(),
  hide_quantity_selector: Joi.boolean(),
  hidden: Joi.boolean(),
  hide_related_products: Joi.boolean(),
  landing_page_id: Joi.string().uuid().allow(null),
  // A real deadline: once it passes the server sells at the compare-at price.
  countdown: Joi.object({ ends_at: Joi.date().iso().required() }).allow(null),
  font: fontPairSchema,
});

const externalRefsSchema = Joi.array()
  .items(
    Joi.object({
      platform: Joi.string().trim().min(1).max(40).required(),
      code: Joi.string().trim().min(1).max(120).required(),
    })
  )
  .max(10);

const cmsText = (max) => Joi.string().trim().max(max).allow('');
const cmsImage = httpUrl.allow(null, '');

// Testimonials are what real customers said, typed in by the merchant.
const cmsSchema = Joi.object({
  features: Joi.array()
    .items(Joi.object({ title: cmsText(120).required(), description: cmsText(600), image: cmsImage }))
    .max(12),
  testimonials: Joi.array()
    .items(
      Joi.object({
        name: cmsText(80).required(),
        text: cmsText(800).required(),
        image: cmsImage,
        rating: Joi.number().integer().min(1).max(5).allow(null),
      })
    )
    .max(12),
  faqs: Joi.array()
    .items(Joi.object({ question: cmsText(200).required(), answer: cmsText(1500).required() }))
    .max(20),
});

/** The fields this file adds to the product create/update body. */
const productPageFields = {
  priority: Joi.number().integer().min(-100000).max(100000),
  specialOfferText: Joi.string().trim().max(200).allow(null, ''),
  externalRefs: externalRefsSchema,
  pageSettings: pageSettingsSchema,
  cms: cmsSchema,
};

function resolvePageSettings(stored) {
  const raw = stored && typeof stored === 'object' ? stored : {};
  const out = { ...PAGE_SETTINGS_DEFAULTS };
  for (const key of Object.keys(PAGE_SETTINGS_DEFAULTS)) {
    if (raw[key] !== undefined && raw[key] !== '') out[key] = raw[key];
  }
  if (out.countdown && !out.countdown.ends_at) out.countdown = null;
  return out;
}

function resolveCms(stored) {
  const raw = stored && typeof stored === 'object' ? stored : {};
  const list = (value) => (Array.isArray(value) ? value : []);
  return { features: list(raw.features), testimonials: list(raw.testimonials), faqs: list(raw.faqs) };
}

/** True once the product's countdown offer is over. */
function countdownEnded(product, now = new Date()) {
  const countdown = product && product.pageSettings && product.pageSettings.countdown;
  if (!countdown || !countdown.ends_at) return false;
  const end = new Date(countdown.ends_at).getTime();
  return Number.isFinite(end) && end <= now.getTime();
}

/**
 * What one unit of a variant sells for right now. While a countdown runs (or
 * with none) that is its price; once the countdown has ended the offer is
 * over and it is the compare-at price, when there is a higher one. The
 * storefront shows this and the order is charged this — one function, so the
 * two cannot disagree.
 */
function effectiveVariantPrice(variant, product, now = new Date()) {
  const price = Number(variant.priceAmount);
  const compareAt =
    variant.compareAtAmount === null || variant.compareAtAmount === undefined ? null : Number(variant.compareAtAmount);
  if (compareAt !== null && compareAt > price && countdownEnded(product, now)) {
    return { priceAmount: variant.compareAtAmount, compareAtAmount: null, offerEnded: true };
  }
  return { priceAmount: variant.priceAmount, compareAtAmount: variant.compareAtAmount, offerEnded: false };
}

/** SQL for "not hidden from listings", on a products alias. */
const notHiddenSql = (alias = 'p') => `COALESCE((${alias}.page_settings ->> 'hidden')::boolean, false) = false`;

module.exports = {
  OPTION_DISPLAY_TYPES,
  PAGE_SETTINGS_DEFAULTS,
  optionSchema,
  pageSettingsSchema,
  cmsSchema,
  productPageFields,
  resolvePageSettings,
  resolveCms,
  countdownEnded,
  effectiveVariantPrice,
  notHiddenSql,
};
