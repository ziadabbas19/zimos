'use strict';

const Joi = require('joi');

/**
 * How the cart rewards bar looks (Offers → Cart rewards → Bar appearance),
 * kept in cart_reward_settings.bar_appearance (migration 750):
 *
 *   { mode: 'inherit' | 'custom', custom: { ... } | null }
 *
 * inherit (the default, and a store that never chose): the bar takes
 * everything from the store's theme and looks as it always has. The custom
 * values stay saved while it is chosen, unused, so a merchant who goes back
 * to "Customize" finds them again.
 * custom: the values below. A colour is a #rrggbb, or null for the theme's.
 *
 * Each reward's icon is content, not styling: it is kept on the tier
 * (tiers[].icon, null = by its kind) and shown in either mode.
 *
 * The shared component that draws it is packages/ui/src/cart-rewards in the
 * frontend; the names and defaults here are its own.
 */

const ICONS = Object.freeze(['gift', 'truck', 'percent', 'tag', 'star', 'heart', 'crown', 'bolt', 'check']);
const MODES = Object.freeze(['inherit', 'custom']);
const SHAPES = Object.freeze(['thin', 'thick', 'segmented']);
const CORNERS = Object.freeze(['rounded', 'square']);
const MARKERS = Object.freeze(['circle', 'rounded_square', 'none']);
const MARKER_SIZES = Object.freeze(['sm', 'md', 'lg']);
const ALIGNS = Object.freeze(['start', 'center']);

/** The icon a reward shows when the merchant picked none. */
function defaultIcon(type) {
  if (type === 'free_shipping') return 'truck';
  if (type === 'percent') return 'percent';
  if (type === 'fixed') return 'tag';
  return 'gift';
}

const iconOf = (tier) => (tier && ICONS.includes(tier.icon) ? tier.icon : defaultIcon(tier && tier.type));

// Strict: six hex digits after a #, nothing else.
const hex = Joi.string()
  .pattern(/^#[0-9a-fA-F]{6}$/)
  .lowercase();

/** The look of today's bar: what "Customize" starts from. */
const customSchema = Joi.object({
  shape: Joi.string()
    .valid(...SHAPES)
    .default('thick'),
  corners: Joi.string()
    .valid(...CORNERS)
    .default('rounded'),
  // null: the theme's (the fill is the theme's success colour, the track its line colour).
  fillColor: hex.allow(null).default(null),
  trackColor: hex.allow(null).default(null),
  marker: Joi.string()
    .valid(...MARKERS)
    .default('circle'),
  markerSize: Joi.string()
    .valid(...MARKER_SIZES)
    .default('md'),
  // The amount under each marker.
  showAmounts: Joi.boolean().default(true),
  // A marker pops the moment its reward is reached.
  reachedPop: Joi.boolean().default(true),
  // The line above the bar ("add X more for …").
  showMessage: Joi.boolean().default(true),
  messageAlign: Joi.string()
    .valid(...ALIGNS)
    .default('start'),
});

const schema = Joi.object({
  mode: Joi.string()
    .valid(...MODES)
    .default('inherit'),
  custom: customSchema.allow(null).default(null),
});

const CUSTOM_DEFAULTS = Object.freeze(customSchema.validate({}).value);

/** What is stored, read back: the defaults for nothing stored or a value that no longer reads. */
function read(stored) {
  if (!stored || typeof stored !== 'object') return { mode: 'inherit', custom: null };
  const { value, error } = schema.validate(stored, { stripUnknown: true });
  return error ? { mode: 'inherit', custom: null } : value;
}

/** As saved: a custom mode with nothing filled in starts from today's look. */
function normalize(appearance) {
  const value = read(appearance);
  if (value.mode === 'custom' && !value.custom) return { mode: 'custom', custom: { ...CUSTOM_DEFAULTS } };
  return value;
}

/** What the store draws: the mode alone while it inherits, the full look while customised. */
function publicView(stored) {
  const value = read(stored);
  if (value.mode !== 'custom') return { mode: 'inherit' };
  return { mode: 'custom', ...(value.custom || CUSTOM_DEFAULTS) };
}

// --- contrast (WCAG 2.x) ------------------------------------------------------

/*
 * The theme's colours a "match the store theme" side stands for, in the
 * storefront's light look (apps/storefront/src/app/globals.css): the fill is
 * --color-success, the track --color-line. Keep in step with the frontend's
 * cart-rewards/appearance.ts.
 */
const THEME = Object.freeze({ fill: '#357150', track: '#dcdace' });
const MIN_RATIO = 3;

function channel(value) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(color) {
  const n = parseInt(color.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** The contrast ratio of two #rrggbb colours, 1 to 21. */
function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on `background`: the icon on a reached marker. */
function iconColorOn(background) {
  return contrastRatio(background, '#000000') >= contrastRatio(background, '#ffffff') ? '#000000' : '#ffffff';
}

const round2 = (n) => Math.floor(n * 100) / 100;

/**
 * The pairs of a custom look below 3:1 (WCAG non-text contrast), each as a
 * 422 detail naming both sides and the ratio. Only a pair with a colour of
 * the merchant's is checked: the theme's own pairs are the theme's.
 *   - the fill against the track;
 *   - a reached marker's icon against the fill it sits on (the icon is black
 *     or white, whichever reads better, so this holds by construction).
 */
function contrastProblems(custom) {
  const out = [];
  if (!custom) return out;
  const fill = custom.fillColor || THEME.fill;
  const track = custom.trackColor || THEME.track;
  if (custom.fillColor || custom.trackColor) {
    const ratio = contrastRatio(fill, track);
    if (ratio < MIN_RATIO) {
      out.push({
        field: custom.fillColor ? 'appearance.custom.fillColor' : 'appearance.custom.trackColor',
        message: `The fill (${custom.fillColor || 'theme'}) and the track (${custom.trackColor || 'theme'}) need a contrast of at least 3:1; they have ${round2(ratio)}:1`,
        pair: ['fill', 'track'],
        ratio: round2(ratio),
      });
    }
  }
  if (custom.fillColor && custom.marker !== 'none') {
    const ratio = contrastRatio(iconColorOn(custom.fillColor), custom.fillColor);
    if (ratio < MIN_RATIO) {
      out.push({
        field: 'appearance.custom.fillColor',
        message: `A reached marker's icon and its background (${custom.fillColor}) need a contrast of at least 3:1; they have ${round2(ratio)}:1`,
        pair: ['icon', 'fill'],
        ratio: round2(ratio),
      });
    }
  }
  return out;
}

module.exports = {
  ICONS,
  MODES,
  SHAPES,
  CORNERS,
  MARKERS,
  MARKER_SIZES,
  ALIGNS,
  THEME,
  MIN_RATIO,
  CUSTOM_DEFAULTS,
  schema,
  customSchema,
  defaultIcon,
  iconOf,
  read,
  normalize,
  publicView,
  contrastRatio,
  iconColorOn,
  contrastProblems,
};
