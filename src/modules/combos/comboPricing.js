'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { effectiveVariantPrice } = require('../catalog/productPage');
const { allocate } = require('../bundles/bundlePricing');

/*
 * What a combo costs and how an order holds it (PRODUCT_COMBOS_ENABLED).
 *
 * A combo is sold as ONE line in the cart and becomes, in the order, one
 * ordinary line per component: its own product, variant, cost, stock,
 * weight, shipping rule and tax rate. The combo's saving (the components'
 * total minus the combo's price) is spread over those lines in proportion to
 * their totals (bundlePricing.allocate), in line_discount_amount; the lines
 * share a combo_key. So stock, partial returns and the reports work per
 * product, exactly as for any other line.
 *
 *   fixed_price  one combo costs price_value (never more than its components)
 *   percent_off  price_value basis points off the components' total
 *   amount_off   price_value minor units off it (never below zero)
 *
 * Prices come from the catalogue only (effective price: a countdown that has
 * ended sells at the full price), never from the shopper.
 */

const MAX_COMPONENTS = 10;
const COMBO = Symbol.for('zimos.combo');

const comboError = (code, message, status = 422, details) => new AppError(code, message, status, details);

/** One combo's price from its components' total (per combo). */
function comboUnitTotal(mode, value, full) {
  const v = Number(value) || 0;
  if (mode === 'fixed_price') return Math.min(v, full);
  if (mode === 'percent_off') return full - Math.min(full, Math.round((full * v) / 10000));
  if (mode === 'amount_off') return Math.max(0, full - v);
  return full;
}

async function loadCombo(workspaceId, comboId, transaction) {
  return db.ProductCombo.findOne({
    where: { id: comboId, workspaceId },
    include: [
      {
        model: db.ProductComboItem,
        as: 'items',
        include: [{ model: db.Product, as: 'product', attributes: ['id', 'name', 'slug', 'status', 'customFields', 'pageSettings', 'media'] }],
      },
    ],
    order: [[{ model: db.ProductComboItem, as: 'items' }, 'position', 'ASC']],
    transaction,
  });
}

/**
 * The variants a combo bought once holds: [{ item, variant }] with the
 * shopper's picks (`selection` [{ itemId, variantId }]) for the components
 * that let them choose. 422 COMBO_UNAVAILABLE when a component is gone or
 * not for sale, COMBO_VARIANT_REQUIRED when a pick is missing or not one of
 * that product's variants.
 */
async function resolveComponents(workspaceId, combo, selection, transaction) {
  const picks = new Map((Array.isArray(selection) ? selection : []).map((s) => [s && s.itemId, s && s.variantId]));
  const out = [];
  for (const item of combo.items) {
    if (!item.productId || !item.product || item.product.status !== 'active') {
      throw comboError('COMBO_UNAVAILABLE', 'A product of this combo is no longer for sale', 422, [{ field: 'comboId', itemId: item.id }]);
    }
    const variantId = item.pickVariant ? picks.get(item.id) : item.variantId;
    if (!variantId) {
      if (!item.pickVariant) throw comboError('COMBO_UNAVAILABLE', 'A product of this combo is no longer for sale', 422, [{ field: 'comboId', itemId: item.id }]);
      throw comboError('COMBO_VARIANT_REQUIRED', 'Choose the option of every product in the combo', 422, [{ field: 'comboSelection', itemId: item.id }]);
    }
    const variant = await db.ProductVariant.findOne({ where: { id: variantId, workspaceId, productId: item.productId, status: 'active' }, transaction });
    if (!variant) {
      throw comboError(item.pickVariant ? 'COMBO_VARIANT_REQUIRED' : 'COMBO_UNAVAILABLE', 'This option is not part of the combo', 422, [{ field: 'comboSelection', itemId: item.id }]);
    }
    out.push({ item, variant });
  }
  return out;
}

/** An active combo of this store, or 404 (off: always 404, as if combos did not exist). */
async function activeCombo(workspaceId, comboId, transaction) {
  if (!env.combos.enabled) throw new NotFoundError('Combo');
  const combo = await loadCombo(workspaceId, comboId, transaction);
  if (!combo || combo.status !== 'active') throw new NotFoundError('Combo');
  return combo;
}

/**
 * Checkout: every item naming a combo becomes one item per component, each
 * carrying the combo it belongs to (`[COMBO]`), so the order prices,
 * reserves and limits them like any other line. Items without a combo pass
 * through untouched; with none, the list is returned as it came.
 */
async function expandItems(workspaceId, items, transaction) {
  if (!items.some((item) => item && item.comboId)) return items;
  const out = [];
  for (const item of items) {
    if (!item.comboId) {
      out.push(item);
      continue;
    }
    const combo = await activeCombo(workspaceId, item.comboId, transaction);
    const quantity = Number(item.quantity) || 1;
    const components = await resolveComponents(workspaceId, combo, item.comboSelection, transaction);
    const key = crypto.randomUUID();
    for (const { item: component, variant } of components) {
      out.push({
        variantId: variant.id,
        quantity: component.quantity * quantity,
        [COMBO]: { comboId: combo.id, key, name: combo.name, mode: combo.pricingMode, value: Number(combo.priceValue), count: quantity },
      });
    }
  }
  return out;
}

/** The combo an expanded checkout item belongs to, or null. */
const comboOf = (item) => (item && item[COMBO]) || null;

/**
 * createOrder, after pricing: each combo's lines get their share of its
 * saving. Lines carry comboId / comboKey / comboName for the order items.
 * Returns one discountsSnapshot entry per combo bought.
 */
function applyComboPricing(lines) {
  const groups = new Map();
  for (const line of lines) {
    if (!line.comboKey) continue;
    if (!groups.has(line.comboKey)) groups.set(line.comboKey, []);
    groups.get(line.comboKey).push(line);
  }
  const snapshots = [];
  for (const [key, group] of groups) {
    const combo = group[0].combo;
    const full = group.reduce((sum, line) => sum + Number(line.lineTotalAmount), 0);
    const perCombo = Math.floor(full / combo.count);
    const total = comboUnitTotal(combo.mode, combo.value, perCombo) * combo.count + (full - perCombo * combo.count);
    const saving = Math.max(0, full - total);
    const shares = allocate(saving, group.map((line) => Number(line.lineTotalAmount)));
    group.forEach((line, index) => {
      line.lineDiscountAmount = (Number(line.lineDiscountAmount) || 0) + shares[index];
      line.lineTotalAmount = Number(line.lineTotalAmount) - shares[index];
    });
    snapshots.push({ kind: 'combo', comboId: combo.comboId, key, name: combo.name, count: combo.count, amount: saving });
  }
  return snapshots;
}

/**
 * What one combo costs now for a selection: { full, total, saving } per
 * combo, from the components' effective prices. For the cart and the
 * storefront; the order prices it again on its own lines.
 */
function priceComponents(combo, components) {
  const full = components.reduce((sum, { item, variant }) => sum + Number(effectiveVariantPrice(variant, item.product).priceAmount) * item.quantity, 0);
  const total = comboUnitTotal(combo.pricingMode, combo.priceValue, full);
  return { full, total, saving: full - total };
}

module.exports = { MAX_COMPONENTS, COMBO, comboUnitTotal, loadCombo, resolveComponents, activeCombo, expandItems, comboOf, applyComboPricing, priceComponents };
