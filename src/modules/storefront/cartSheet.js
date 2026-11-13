'use strict';

const Joi = require('joi');
const db = require('../../db/models');

/**
 * How the store's cart opens, chosen by the merchant (Store settings → Cart
 * behavior). Every store has a cart sheet: it is not a plan feature and no
 * switch of the platform's turns it on or off. Cart rewards only add their
 * bar to it.
 *
 *   enabled        false: no sheet at all, the cart is a page of its own
 *                  (the merchant's "off for all")
 *   openOn         which taps open it:
 *     addToCart      right after a product is added (on unless switched off)
 *     cartIcon       the cart icon in the header and the phone toolbar (on)
 *     quickOrder     a product page's "Order now": the sheet with that
 *                    product, its totals and the quick order form (off)
 *   presentation   auto (a bottom sheet on a phone, a side drawer on a wider
 *                  screen), bottom_sheet, side_drawer or popup (centred)
 *   speed          fast (about 260 ms), normal, or none (no movement)
 *   trustItems     the short lines under the checkout button ("Cash on
 *                  delivery"), each { text: { ar, en }, enabled }, at most 4
 *
 * Kept in workspaces.settings.cart_sheet, whole, and written through the
 * store settings' PATCH /workspaces/:id (website.edit), so the save is
 * audited as a change to the Workspace and the store's cached pages are
 * dropped then, here and at the edge (storefront/storefrontCache.js). A store
 * that never saved it gets the defaults. Reaches the storefront inside
 * GET /store/:id (`cartSheet`): the same for every shopper, so no request of
 * its own and nothing that keeps a page from being cached.
 *
 * The trust lines used to be written on the cart rewards page and kept with
 * those settings (cart_reward_settings.trust_items, migration 747). Until a
 * store saves its cart behavior with `trustItems`, the lines are read from
 * there, as they were written (nothing is copied or deleted); from that save
 * on, cart_sheet.trustItems is the store's, an empty list included.
 */

const KEY = 'cart_sheet';
const PRESENTATIONS = Object.freeze(['auto', 'bottom_sheet', 'side_drawer', 'popup']);
const SPEEDS = Object.freeze(['fast', 'normal', 'none']);
const MAX_TRUST_ITEMS = 4;
const TRUST_TEXT_MAX = 80;

const blank = (value) => typeof value !== 'string' || value.trim() === '';
const text = Joi.string().trim().max(TRUST_TEXT_MAX).allow('', null);

const trustItem = Joi.object({
  text: Joi.object({ ar: text, en: text }).required(),
  enabled: Joi.boolean().default(true),
}).custom((item, helpers) => (blank(item.text.ar) && blank(item.text.en) ? helpers.error('any.invalid') : item), 'some text in one language');

const schema = Joi.object({
  enabled: Joi.boolean().default(true),
  openOn: Joi.object({
    addToCart: Joi.boolean().default(true),
    cartIcon: Joi.boolean().default(true),
    quickOrder: Joi.boolean().default(false),
  }).default(),
  presentation: Joi.string()
    .valid(...PRESENTATIONS)
    .default('auto'),
  speed: Joi.string()
    .valid(...SPEEDS)
    .default('fast'),
  // Left out: never saved here (the old place is read, see the top of this file).
  trustItems: Joi.array().items(trustItem).max(MAX_TRUST_ITEMS).optional(),
});

const DEFAULTS = Object.freeze(schema.validate({}).value);

/** The store's settings, defaults filled in; a stored value that no longer reads reads as the defaults. */
function read(settings) {
  const stored = settings && typeof settings === 'object' ? settings[KEY] : null;
  const { value, error } = schema.validate(stored || {}, { stripUnknown: true });
  return error ? { ...DEFAULTS, openOn: { ...DEFAULTS.openOn } } : value;
}

const cleanItem = (item) => ({
  text: { ar: blank(item && item.text && item.text.ar) ? '' : item.text.ar.trim(), en: blank(item && item.text && item.text.en) ? '' : item.text.en.trim() },
  enabled: !item || item.enabled !== false,
});
const hasText = (item) => item && item.text && (!blank(item.text.ar) || !blank(item.text.en));

/**
 * The store's trust lines, every one (switched on or off), and where they
 * were read from: `cart_sheet` once the store saved them there, else
 * `cart_rewards` (the lines written on the rewards page before the move).
 */
async function trustItemsOf(workspace) {
  const s = read(workspace && workspace.settings);
  if (Array.isArray(s.trustItems)) return { items: s.trustItems.filter(hasText).map(cleanItem), from: 'cart_sheet' };
  if (!workspace) return { items: [], from: 'cart_sheet' };
  const row = await db.CartRewardSettings.findByPk(workspace.id, { attributes: ['workspaceId', 'trustItems'] });
  const items = (row && Array.isArray(row.trustItems) && row.trustItems) || [];
  return { items: items.filter(hasText).map(cleanItem), from: 'cart_rewards' };
}

/** The lines the cart shows: those switched on, in the shopper-facing shape. */
async function shownTrustItems(workspace) {
  const { items } = await trustItemsOf(workspace);
  return items.filter((item) => item.enabled).map((item) => ({ text: item.text }));
}

/** GET /store/:id → `cartSheet`. */
async function publicView(workspace) {
  const s = read(workspace && workspace.settings);
  return {
    enabled: s.enabled,
    openOn: { addToCart: s.openOn.addToCart, cartIcon: s.openOn.cartIcon, quickOrder: s.openOn.quickOrder },
    presentation: s.presentation,
    speed: s.speed,
    trustItems: await shownTrustItems(workspace),
  };
}

/**
 * GET /workspaces/:id/cart-sheet: the settings as the dashboard edits them,
 * the trust lines with their switches, read from wherever they are now
 * (`trustItemsFrom`). Saving them through the store settings writes them here.
 */
async function staffView(workspace) {
  const s = read(workspace && workspace.settings);
  const trust = await trustItemsOf(workspace);
  return {
    enabled: s.enabled,
    openOn: { ...s.openOn },
    presentation: s.presentation,
    speed: s.speed,
    trustItems: trust.items,
    trustItemsFrom: trust.from,
  };
}

module.exports = { KEY, PRESENTATIONS, SPEEDS, MAX_TRUST_ITEMS, TRUST_TEXT_MAX, schema, DEFAULTS, read, publicView, staffView, trustItemsOf, shownTrustItems };
