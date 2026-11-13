'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const { ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const growth = require('../billing/growthFeatures');
const rules = require('./cartRewardRules');
const appearance = require('./barAppearance');

/*
 * A store's cart rewards settings (cart_reward_settings, migration 747) and
 * whether they are in force.
 *
 * In force (activeSettings) only while all of these hold:
 *   - CART_REWARDS_ENABLED is on (env.cartRewards.enabled);
 *   - the store holds the plan's `cart_rewards`, while the growth gate is on
 *     (billing/growthFeatures.js: GROWTH_REQUIRE_PLAN_FEATURE with
 *     PLAN_FEATURE_ENFORCEMENT); off, every plan has it;
 *   - the merchant switched the section on and listed at least one tier.
 * Otherwise the quote carries no rewards and the checkout gives none: orders
 * are priced exactly as before. A store without a row has the section off.
 */

const flagOn = () => env.cartRewards.enabled === true;

const blank = (value) => typeof value !== 'string' || value.trim() === '';

function cleanLabel(label) {
  if (!label) return null;
  const ar = blank(label.ar) ? null : label.ar.trim();
  const en = blank(label.en) ? null : label.en.trim();
  return ar || en ? { ar, en } : null;
}

function cleanTier(tier) {
  const out = { thresholdAmount: Number(tier.thresholdAmount), type: tier.type, label: cleanLabel(tier.label) };
  if (tier.type !== 'free_shipping') out.value = Number(tier.value);
  // The merchant's icon for it (barAppearance.ICONS); null = by its kind.
  out.icon = appearance.ICONS.includes(tier.icon) ? tier.icon : null;
  return out;
}

async function storeOf(workspaceId, transaction) {
  return db.Workspace.findByPk(workspaceId, { attributes: ['id', 'defaultCurrency', 'settings'], transaction });
}

async function storeCurrency(workspaceId, transaction) {
  const workspace = await storeOf(workspaceId, transaction);
  return (workspace && workspace.defaultCurrency) || 'EGP';
}

/**
 * The settings as the dashboard edits them; each tier also says its automatic
 * label and the icon it shows. `cartSpeed` is the store's cart speed
 * (storefront/cartSheet.js), which the bar's fill glides at: read only here,
 * for the dashboard's preview.
 */
function serialize(row, currency, cartSpeed = 'fast') {
  const tiers = rules.sortTiers((row && row.tiers) || []);
  return {
    enabled: Boolean(row && row.enabled),
    allowCouponStacking: Boolean(row && row.allowCouponStacking),
    currency,
    tiers: tiers.map((tier) => ({ ...cleanTier(tier), autoLabel: rules.autoLabel(tier, currency), shownIcon: appearance.iconOf(tier) })),
    trustItems: ((row && row.trustItems) || []).map((item) => ({
      text: { ar: (item.text && item.text.ar) || '', en: (item.text && item.text.en) || '' },
      enabled: item.enabled !== false,
    })),
    appearance: appearance.read(row && row.barAppearance),
    cartSpeed,
  };
}

const cartSpeedOf = (workspace) => require('../storefront/cartSheet').read(workspace && workspace.settings).speed;

async function getSettings(workspaceId) {
  const [row, workspace] = await Promise.all([db.CartRewardSettings.findByPk(workspaceId), storeOf(workspaceId)]);
  return serialize(row, (workspace && workspace.defaultCurrency) || 'EGP', cartSpeedOf(workspace));
}

/**
 * Saves the whole section. Thresholds must rise within each kind of reward
 * (422 VALIDATION_ERROR naming the tier); a trust line needs some text.
 * Stored lowest threshold first.
 */
async function saveSettings(workspaceId, data, req) {
  const errors = [...rules.tierErrors(data.tiers)];
  (data.trustItems || []).forEach((item, index) => {
    if (blank(item.text.ar) && blank(item.text.en)) errors.push({ field: `trustItems.${index}.text`, message: 'Write the line in at least one language' });
  });
  if (data.enabled && data.tiers.length === 0) errors.push({ field: 'tiers', message: 'Add at least one reward before switching the bar on' });
  // The bar's look: its colours are checked for contrast only while it is the
  // one in use (custom); kept while the store inherits its theme's.
  const look = data.appearance === undefined ? undefined : appearance.normalize(data.appearance);
  if (look && look.mode === 'custom') {
    // A side left to the theme stands for the store's accent (its light look).
    const store = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'themeSettings'] });
    errors.push(...appearance.contrastProblems(look.custom, { fill: appearance.accentOf(store && store.themeSettings) }));
  }
  if (errors.length) throw new ValidationError(errors, 'Invalid body');

  const tiers = rules.sortTiers(data.tiers.map(cleanTier));
  const trustItems =
    data.trustItems === undefined
      ? undefined
      : data.trustItems.map((item) => ({
          text: { ar: blank(item.text.ar) ? '' : item.text.ar.trim(), en: blank(item.text.en) ? '' : item.text.en.trim() },
          enabled: item.enabled !== false,
        }));

  return db.sequelize.transaction(async (transaction) => {
    const workspace = await storeOf(workspaceId, transaction);
    const currency = (workspace && workspace.defaultCurrency) || 'EGP';
    const row = await db.CartRewardSettings.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    const before = row ? serialize(row, currency, cartSpeedOf(workspace)) : null;
    const values = { enabled: data.enabled, allowCouponStacking: data.allowCouponStacking, tiers };
    // Sent (an older dashboard): kept here as before. Left out: what is here stays.
    if (trustItems !== undefined) values.trustItems = trustItems;
    if (look !== undefined) values.barAppearance = look;
    const saved = row ? await row.update(values, { transaction }) : await db.CartRewardSettings.create({ workspaceId, ...values }, { transaction });
    const after = serialize(saved, currency, cartSpeedOf(workspace));
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'cart_rewards.update',
      entityType: 'CartRewardSettings',
      entityId: workspaceId,
      before,
      after,
      req,
      transaction,
    });
    return after;
  });
}

/**
 * The settings the shopper's cart and checkout are priced with, or null when
 * cart rewards are not in force for this store (see the top of this file).
 * { allowCouponStacking, tiers (lowest first), trustItems, currency }.
 */
async function activeSettings(workspaceId, { transaction } = {}) {
  if (!flagOn()) return null;
  const row = await db.CartRewardSettings.findByPk(workspaceId, { transaction });
  if (!row || !row.enabled || !Array.isArray(row.tiers) || row.tiers.length === 0) return null;
  if (await growth.locked(workspaceId, 'cart_rewards', { transaction })) return null;
  return {
    allowCouponStacking: Boolean(row.allowCouponStacking),
    tiers: rules.sortTiers(row.tiers.map(cleanTier)),
    trustItems: row.trustItems || [],
    appearance: row.barAppearance || null,
    currency: await storeCurrency(workspaceId, transaction),
  };
}

/**
 * What the storefront shows before it has a quote (GET /store/:id/cart-rewards):
 * the tiers with their names and icons, the bar's look, the trust lines
 * switched on, and whether a code adds to the reward. null when not in force.
 * (The trust lines also reach every store's cart sheet, rewards or not,
 * inside GET /store/:id: storefront/cartSheet.js.)
 */
async function publicConfig(workspaceId) {
  const settings = await activeSettings(workspaceId);
  if (!settings) return null;
  return {
    currency: settings.currency,
    allowCouponStacking: settings.allowCouponStacking,
    tiers: settings.tiers.map((tier) => ({
      thresholdAmount: tier.thresholdAmount,
      type: tier.type,
      value: tier.type === 'free_shipping' ? null : tier.value,
      label: rules.labelOf(tier, settings.currency),
      icon: appearance.iconOf(tier),
    })),
    // How the bar looks (barAppearance.js): { mode: 'inherit' } or the custom look.
    appearance: appearance.publicView(settings.appearance),
    // The cart sheet's own lines (storefront/cartSheet.js), the same ones GET /store/:id gives.
    trustItems: await require('../storefront/cartSheet').shownTrustItems(await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] })),
  };
}

module.exports = { flagOn, getSettings, saveSettings, activeSettings, publicConfig, serialize };
