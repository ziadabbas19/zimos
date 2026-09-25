'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { describeTiers, tierSetErrors } = require('./shippingWeight');
const { loadTiers, computeRateAmount } = require('./shippingPricing');

/**
 * Weight tiers, the zone × tier price grid and the store's shipping pricing
 * mode. The mode and the default item weight live in workspaces.settings
 * (`shipping_pricing_mode`, `default_item_weight_grams`) next to the other
 * shipping knobs; see shippingPricing.calculateShippingAmount for how they
 * are used.
 */

const PRICING_MODES = ['rates', 'weight_tiers'];

function pricingSettings(settings) {
  const s = settings || {};
  return {
    pricingMode: s.shipping_pricing_mode === 'weight_tiers' ? 'weight_tiers' : 'rates',
    defaultItemWeightGrams: s.default_item_weight_grams ?? null,
  };
}

/**
 * Active variants of live physical products with no weight set: what the
 * default item weight is standing in for right now.
 */
async function countVariantsWithoutWeight(workspaceId) {
  const [row] = await db.sequelize.query(
    `SELECT COUNT(*)::int AS count
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
      WHERE v.workspace_id = $workspaceId
        AND v.status = 'active'
        AND v.weight_grams IS NULL
        AND p.status <> 'archived'
        AND p.product_type = 'physical'`,
    { bind: { workspaceId }, type: QueryTypes.SELECT }
  );
  return row.count;
}

async function listPrices(workspaceId, transaction) {
  const rows = await db.ShippingZoneTierPrice.findAll({ where: { workspaceId }, transaction });
  return rows.map((r) => ({ zoneId: r.zoneId, tierId: r.tierId, amount: Number(r.amount) }));
}

/** GET /shipping/weight-tiers — everything the /shipping tier screens need. */
async function getWeightTierSettings(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId);
  if (!workspace) throw new NotFoundError('Workspace');
  return {
    ...pricingSettings(workspace.settings),
    tiers: await loadTiers(workspaceId),
    prices: await listPrices(workspaceId),
    variantsWithoutWeight: await countVariantsWithoutWeight(workspaceId),
  };
}

// Serialises writes to one workspace's tiers, prices and mode.
async function lockWorkspace(workspaceId, transaction) {
  const workspace = await db.Workspace.findOne({
    where: { id: workspaceId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!workspace) throw new NotFoundError('Workspace');
  return workspace;
}

/**
 * PUT /shipping/weight-tiers — replaces the whole set. A submitted `id` keeps
 * that tier (and its zone prices and courier mappings); an entry without one
 * is a new tier; an existing tier left out is deleted with its prices.
 */
async function replaceTiers(workspaceId, tiers, req) {
  const errors = tierSetErrors(tiers);
  if (errors.length) throw new ValidationError(errors, 'Invalid weight tiers');

  return db.sequelize.transaction(async (transaction) => {
    await lockWorkspace(workspaceId, transaction);
    const existing = await db.ShippingWeightTier.findAll({ where: { workspaceId }, transaction });
    const byId = new Map(existing.map((t) => [t.id, t]));

    const unknown = tiers
      .map((t, i) => (t.id && !byId.has(t.id) ? { field: `tiers.${i}.id`, message: 'Not one of this store\'s tiers' } : null))
      .filter(Boolean);
    if (unknown.length) throw new ValidationError(unknown, 'Invalid weight tiers');

    const before = describeTiers(existing);
    const keptIds = new Set(tiers.map((t) => t.id).filter(Boolean));
    const removedIds = existing.filter((t) => !keptIds.has(t.id)).map((t) => t.id);
    if (removedIds.length) {
      await db.ShippingZoneTierPrice.destroy({ where: { workspaceId, tierId: removedIds }, transaction });
      await db.ShippingWeightTier.destroy({ where: { workspaceId, id: removedIds }, transaction });
    }

    for (const [position, tier] of tiers.entries()) {
      if (tier.id) {
        await byId.get(tier.id).update({ position, upToGrams: tier.upToGrams }, { transaction });
      } else {
        await db.ShippingWeightTier.create({ workspaceId, position, upToGrams: tier.upToGrams }, { transaction });
      }
    }

    const after = await loadTiers(workspaceId, transaction);
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'shipping_weight_tiers.replace',
      entityType: 'Workspace',
      entityId: workspaceId,
      before: { tiers: before },
      after: { tiers: after },
      req,
      transaction,
    });
    return { tiers: after };
  });
}

async function findZone(workspaceId, zoneId, transaction) {
  const zone = await db.ShippingZone.findOne({ where: { id: zoneId, workspaceId }, transaction });
  if (!zone) throw new NotFoundError('ShippingZone');
  return zone;
}

/** GET /shipping/zones/:zoneId/tier-prices */
async function getZoneTierPrices(workspaceId, zoneId) {
  await findZone(workspaceId, zoneId);
  const rows = await db.ShippingZoneTierPrice.findAll({ where: { workspaceId, zoneId } });
  return { zoneId, prices: rows.map((r) => ({ tierId: r.tierId, amount: Number(r.amount) })) };
}

/**
 * PUT /shipping/zones/:zoneId/tier-prices — replaces the zone's prices. A
 * tier left out has no price in this zone (checkout falls back to the
 * default shipping rate for it).
 */
async function replaceZoneTierPrices(workspaceId, zoneId, prices, req) {
  return db.sequelize.transaction(async (transaction) => {
    await lockWorkspace(workspaceId, transaction);
    await findZone(workspaceId, zoneId, transaction);
    const tierIds = new Set((await db.ShippingWeightTier.findAll({ where: { workspaceId }, transaction })).map((t) => t.id));

    const errors = [];
    const seen = new Set();
    prices.forEach((p, i) => {
      if (!tierIds.has(p.tierId)) errors.push({ field: `prices.${i}.tierId`, message: 'Not one of this store\'s tiers' });
      else if (seen.has(p.tierId)) errors.push({ field: `prices.${i}.tierId`, message: 'This tier is priced twice' });
      seen.add(p.tierId);
    });
    if (errors.length) throw new ValidationError(errors, 'Invalid tier prices');

    const beforeRows = await db.ShippingZoneTierPrice.findAll({ where: { workspaceId, zoneId }, transaction });
    await db.ShippingZoneTierPrice.destroy({ where: { workspaceId, zoneId }, transaction });
    for (const p of prices) {
      await db.ShippingZoneTierPrice.create({ workspaceId, zoneId, tierId: p.tierId, amount: p.amount }, { transaction });
    }

    const after = prices.map((p) => ({ tierId: p.tierId, amount: p.amount }));
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'shipping_zone_tier_prices.replace',
      entityType: 'ShippingZone',
      entityId: zoneId,
      before: { prices: beforeRows.map((r) => ({ tierId: r.tierId, amount: Number(r.amount) })) },
      after: { prices: after },
      req,
      transaction,
    });
    return { zoneId, prices: after };
  });
}

/**
 * What each empty zone × tier cell would cost under the store's current
 * rates, for the switch to tier pricing. A tier is priced at its heaviest
 * weight (its upper bound) so the tier never charges less than the rates did
 * for any weight inside it; an open-ended last tier only has a lower bound,
 * so it is priced just above that. Rates see a zero subtotal and one item.
 * A zone with no active rate proposes the default shipping rate, when set.
 * Cells that already have a price are never proposed.
 */
async function proposeTierPrices(workspaceId, settings, transaction) {
  const tiers = await loadTiers(workspaceId, transaction);
  const zones = await db.ShippingZone.findAll({
    where: { workspaceId },
    include: [{ model: db.ShippingRate, as: 'rates', where: { isActive: true }, required: false }],
    order: [['createdAt', 'ASC']],
    transaction,
  });
  const existing = new Set((await listPrices(workspaceId, transaction)).map((p) => `${p.zoneId}:${p.tierId}`));
  const defaultRate = settings.default_shipping_rate_amount;

  const proposals = [];
  for (const zone of zones) {
    for (const tier of tiers) {
      if (existing.has(`${zone.id}:${tier.id}`)) continue;
      const grams = tier.upToGrams !== null ? tier.upToGrams : tier.fromGrams + 1;
      if (zone.rates.length > 0) {
        const amount = Math.min(
          ...zone.rates.map((rate) => computeRateAmount(rate, { subtotal: 0, totalWeightGrams: grams, totalQuantity: 1 }))
        );
        proposals.push({ zoneId: zone.id, tierId: tier.id, amount: Number(amount) || 0, basis: 'rates' });
      } else if (defaultRate !== undefined && defaultRate !== null) {
        proposals.push({ zoneId: zone.id, tierId: tier.id, amount: Number(defaultRate), basis: 'default_rate' });
      }
    }
  }
  return proposals;
}

/**
 * POST /shipping/pricing-mode.
 *
 * Switching to 'weight_tiers' needs at least one tier and a default item
 * weight (in the body or already saved). With `prefill` (default on) every
 * empty zone × tier cell is filled from the current rates first, so the
 * switch does not quietly send every order to the default rate. `dryRun`
 * only returns those proposals — nothing is written and the default weight
 * is not required yet — so the dashboard wizard can show and edit them.
 * Switching back to 'rates' is always allowed and leaves tiers and prices
 * in place.
 */
async function setPricingMode(workspaceId, body, req) {
  const { mode, defaultItemWeightGrams, prefill = true, dryRun = false } = body;

  return db.sequelize.transaction(async (transaction) => {
    const workspace = await lockWorkspace(workspaceId, transaction);
    const settings = { ...(workspace.settings || {}) };
    const current = pricingSettings(settings);

    if (mode === 'weight_tiers') {
      const tierCount = await db.ShippingWeightTier.count({ where: { workspaceId }, transaction });
      if (tierCount === 0) {
        throw new AppError('SHIPPING_TIERS_REQUIRED', 'Add at least one weight tier before switching to tier pricing', 422);
      }
      if (dryRun) {
        return { ...current, dryRun: true, proposals: await proposeTierPrices(workspaceId, settings, transaction) };
      }
      const defaultWeight = defaultItemWeightGrams ?? settings.default_item_weight_grams ?? null;
      if (defaultWeight === null) {
        throw new AppError(
          'DEFAULT_ITEM_WEIGHT_REQUIRED',
          'Set a default item weight before switching to tier pricing; it is used for products without a weight',
          422,
          [{ field: 'defaultItemWeightGrams', message: 'Required to switch to weight tiers' }]
        );
      }
      settings.default_item_weight_grams = defaultWeight;
    } else if (dryRun) {
      return { ...current, dryRun: true, proposals: [] };
    } else if (defaultItemWeightGrams !== undefined && defaultItemWeightGrams !== null) {
      settings.default_item_weight_grams = defaultItemWeightGrams;
    }

    const prefilled = mode === 'weight_tiers' && prefill ? await proposeTierPrices(workspaceId, settings, transaction) : [];
    for (const p of prefilled) {
      await db.ShippingZoneTierPrice.create(
        { workspaceId, zoneId: p.zoneId, tierId: p.tierId, amount: p.amount },
        { transaction }
      );
    }

    settings.shipping_pricing_mode = mode;
    await workspace.update({ settings }, { transaction });

    const next = pricingSettings(settings);
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'shipping.pricing_mode',
      entityType: 'Workspace',
      entityId: workspaceId,
      before: current,
      after: { ...next, prefilledCells: prefilled.length },
      req,
      transaction,
    });
    return { ...next, dryRun: false, prefilled };
  });
}

module.exports = {
  PRICING_MODES,
  pricingSettings,
  countVariantsWithoutWeight,
  getWeightTierSettings,
  replaceTiers,
  getZoneTierPrices,
  replaceZoneTierPrices,
  proposeTierPrices,
  setPricingMode,
};
