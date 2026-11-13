'use strict';

const Joi = require('joi');
const db = require('../../db/models');

/**
 * How the store's cart opens, chosen by the merchant (Settings → The store →
 * Cart). Every store has a cart sheet: it is not a plan feature and no switch
 * of the platform's turns it on or off. Cart rewards only add their bar to it.
 *
 *   enabled        false: no sheet at all, the cart is a page of its own
 *                  (the merchant's "off for all")
 *   openOn         which taps open it:
 *     addToCart      right after a product is added (off unless switched on)
 *     cartIcon       the cart icon in the header and the phone toolbar (on)
 *     quickOrder     a product page's "Order now": the sheet with that
 *                    product, its totals and the quick order form (off)
 *   presentation   auto (a bottom sheet on a phone, a side drawer on a wider
 *                  screen), bottom_sheet, side_drawer or popup (centred)
 *   speed          fast (about 260 ms), normal, or none (no movement)
 *
 * Kept in workspaces.settings.cart_sheet, whole, and written through the
 * store settings' PATCH /workspaces/:id (website.edit), so the save is
 * audited as a change to the Workspace and the store's cached pages are
 * dropped then, here and at the edge (storefront/storefrontCache.js). A store
 * that never saved it gets the defaults. Reaches the storefront inside
 * GET /store/:id (`cartSheet`): the same for every shopper, so no request of
 * its own and nothing that keeps a page from being cached.
 */

const KEY = 'cart_sheet';
const PRESENTATIONS = Object.freeze(['auto', 'bottom_sheet', 'side_drawer', 'popup']);
const SPEEDS = Object.freeze(['fast', 'normal', 'none']);

const schema = Joi.object({
  enabled: Joi.boolean().default(true),
  openOn: Joi.object({
    addToCart: Joi.boolean().default(false),
    cartIcon: Joi.boolean().default(true),
    quickOrder: Joi.boolean().default(false),
  }).default(),
  presentation: Joi.string()
    .valid(...PRESENTATIONS)
    .default('auto'),
  speed: Joi.string()
    .valid(...SPEEDS)
    .default('fast'),
});

const DEFAULTS = Object.freeze(schema.validate({}).value);

/** The store's settings, defaults filled in; a stored value that no longer reads reads as the defaults. */
function read(settings) {
  const stored = settings && typeof settings === 'object' ? settings[KEY] : null;
  const { value, error } = schema.validate(stored || {}, { stripUnknown: true });
  return error ? { ...DEFAULTS, openOn: { ...DEFAULTS.openOn } } : value;
}

const blank = (value) => typeof value !== 'string' || value.trim() === '';

/**
 * The lines under the sheet's checkout button that the merchant wrote and
 * switched on (kept with the cart rewards settings, cartRewards/
 * cartRewardService.js). Shown whether or not the store gives rewards: they
 * belong to the cart, not to the bar.
 */
async function trustItemsOf(workspaceId) {
  const row = await db.CartRewardSettings.findByPk(workspaceId, { attributes: ['workspaceId', 'trustItems'] });
  const items = (row && Array.isArray(row.trustItems) && row.trustItems) || [];
  return items
    .filter((item) => item && item.enabled !== false && item.text && (!blank(item.text.ar) || !blank(item.text.en)))
    .map((item) => ({ text: { ar: blank(item.text.ar) ? '' : item.text.ar.trim(), en: blank(item.text.en) ? '' : item.text.en.trim() } }));
}

/** GET /store/:id → `cartSheet`. */
async function publicView(workspace) {
  const s = read(workspace && workspace.settings);
  return {
    enabled: s.enabled,
    openOn: { addToCart: s.openOn.addToCart, cartIcon: s.openOn.cartIcon, quickOrder: s.openOn.quickOrder },
    presentation: s.presentation,
    speed: s.speed,
    trustItems: workspace ? await trustItemsOf(workspace.id) : [],
  };
}

module.exports = { KEY, PRESENTATIONS, SPEEDS, schema, DEFAULTS, read, publicView, trustItemsOf };
