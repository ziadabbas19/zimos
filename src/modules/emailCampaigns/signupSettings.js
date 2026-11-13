'use strict';

const Joi = require('joi');
const db = require('../../db/models');
const env = require('../../config/env');
const { recordAudit } = require('../audit/auditService');

/**
 * Where a store's shoppers may sign up for its marketing emails, chosen by
 * the merchant (Marketing → Email campaigns → Signup placement):
 *
 *   checkout     the "Email me offers" box of the checkout page — on unless
 *                the merchant turns it off (it was always there before)
 *   quickOrder   the same box in a product page's quick order form
 *   cart         the same box in the cart sheet and on the cart page; the
 *                choice travels to the checkout with the cart
 *   footer       an email field and a button wherever the footer is drawn
 *   popup        a small signup window, after some seconds or when the
 *                shopper is about to leave (a computer only)
 *
 * A box place can start ticked (`preTicked`), the merchant's call per place;
 * what is recorded is what the box shows when the order is placed. The footer
 * and the popup are a signup of their own and have no such switch.
 *
 * Kept in workspaces.settings.email_signup, whole, like the newsletter and
 * social proof settings (offers/engagement.js). Written through PUT, audited
 * as a change to the Workspace: the storefront's cache and the edge copies of
 * the store's pages are dropped then (storefront/storefrontCache.js), as for
 * any published change. Reaches the storefront inside GET /store/:id
 * (`emailSignup`), so no request of its own.
 */

const KEY = 'email_signup';
const BOX_PLACES = ['checkout', 'quickOrder', 'cart'];
// The source each place records with the consent it gives (customers.marketing_consent_source).
const SOURCE_OF = { checkout: 'checkout', quickOrder: 'quick_order', cart: 'cart', footer: 'footer', popup: 'popup' };
const PLACE_OF = Object.fromEntries(Object.entries(SOURCE_OF).map(([place, source]) => [source, place]));
const SOURCES = Object.values(SOURCE_OF);

const line = (max) => Joi.string().trim().max(max).allow('', null).empty('').default(null);
const box = (on) =>
  Joi.object({
    enabled: Joi.boolean().default(on),
    preTicked: Joi.boolean().default(false),
  }).default();
const copy = Joi.object({
  // The box's words, or the footer and popup heading. null: the storefront's own default.
  label: line(160),
  // A short line under it about privacy (unsubscribe any time…). null: the default.
  privacy: line(240),
  // "Get 10% off your next order": shown only; no coupon is made.
  incentive: line(120),
}).default();

const schema = Joi.object({
  checkout: box(true),
  quickOrder: box(false),
  cart: box(false),
  footer: Joi.object({ enabled: Joi.boolean().default(false) }).default(),
  popup: Joi.object({
    enabled: Joi.boolean().default(false),
    // delay: after `delaySeconds`; exit_intent: when the pointer leaves the page
    // towards the browser's bar (a computer only — a phone falls back to the delay).
    trigger: Joi.string().valid('delay', 'exit_intent').default('delay'),
    delaySeconds: Joi.number().integer().min(3).max(120).default(15),
  }).default(),
  text: Joi.object({ ar: copy, en: copy }).default(),
});

const DEFAULTS = schema.validate({}).value;

/** The store's settings, defaults filled in; a broken stored value reads as the defaults. */
function read(settings) {
  const stored = settings && typeof settings === 'object' ? settings[KEY] : null;
  const { value, error } = schema.validate(stored || {}, { stripUnknown: true });
  return error ? DEFAULTS : value;
}

async function get(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  return read(workspace && workspace.settings);
}

async function save(workspaceId, body, req) {
  const data = read({ [KEY]: body });
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    const before = read(workspace.settings);
    workspace.settings = { ...(workspace.settings || {}), [KEY]: data };
    workspace.changed('settings', true);
    await workspace.save({ transaction });
    // entityType Workspace: the store's cached pages are dropped, here and at the edge.
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_signup.update', entityType: 'Workspace', entityId: workspaceId, before, after: data, req, transaction });
    return data;
  });
}

/**
 * Whether the store may take a signup from this place now: the feature is on,
 * the plan has it (GROWTH_REQUIRE_PLAN_FEATURE) and the merchant switched the
 * place on.
 */
async function placeOpen(workspace, place) {
  if (!env.emailCampaigns.enabled || !workspace) return false;
  const settings = read(workspace.settings);
  if (!settings[place] || !settings[place].enabled) return false;
  return !(await require('../billing/growthFeatures').locked(workspace.id, 'email_campaigns'));
}

/**
 * GET /store/:id → `emailSignup`: each place switched on, the rest null. null
 * altogether while the feature is off or the plan lacks it. The same for
 * every shopper, so the store's pages stay cacheable.
 */
async function publicView(workspace) {
  if (!env.emailCampaigns.enabled || !workspace) return null;
  if (await require('../billing/growthFeatures').locked(workspace.id, 'email_campaigns')) return null;
  const s = read(workspace.settings);
  const boxOf = (place) => (s[place].enabled ? { preTicked: s[place].preTicked } : null);
  return {
    checkout: boxOf('checkout'),
    quickOrder: boxOf('quickOrder'),
    cart: boxOf('cart'),
    footer: s.footer.enabled ? {} : null,
    popup: s.popup.enabled ? { trigger: s.popup.trigger, delaySeconds: s.popup.delaySeconds } : null,
    text: s.text,
  };
}

module.exports = { KEY, BOX_PLACES, SOURCES, SOURCE_OF, PLACE_OF, schema, DEFAULTS, read, get, save, placeOpen, publicView };
