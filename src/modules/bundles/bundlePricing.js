'use strict';

const db = require('../../db/models');

/*
 * What a quantity bundle takes off (SPEC §10.1). One pure function prices a
 * set of units against a bundle's tiers; the order, the shipping quote, the
 * cart and the storefront's tier cards all go through it, so the price the
 * shopper is shown is the price the order charges.
 *
 * A tier's `discountValue` by `discountType`:
 *   percentage        percent × 100 (500 = 5%) off the tier's units
 *   fixed_price       what the tier's units cost together, minor units
 *   fixed_amount_off  minor units off the tier's units together
 *   buy_x_get_y       how many of the tier's `quantity` units are free
 *                     (the cheapest ones)
 *
 * Buying more than the largest tier: the units are taken tier by tier, largest
 * first — 5 units against tiers of 1, 2 and 3 is a pack of 3 and a pack of 2.
 */

const DISCOUNT_TYPES = ['percentage', 'fixed_price', 'fixed_amount_off', 'buy_x_get_y'];
const MAX_UNITS = 2000;

function tierDiscount(tier, unitPrices) {
  const sum = unitPrices.reduce((total, price) => total + price, 0);
  const value = Number(tier.discountValue) || 0;
  switch (tier.discountType) {
    case 'percentage':
      return Math.min(sum, Math.round((sum * value) / 10000));
    case 'fixed_price':
      return Math.max(0, sum - value);
    case 'fixed_amount_off':
      return Math.min(sum, value);
    case 'buy_x_get_y': {
      const free = Math.min(Math.max(0, Math.floor(value)), unitPrices.length - 1);
      return [...unitPrices]
        .sort((a, b) => a - b)
        .slice(0, free)
        .reduce((total, price) => total + price, 0);
    }
    default:
      return 0;
  }
}

/**
 * Prices `unitPrices` (one entry per unit bought, minor units) against
 * `tiers`. Returns the full amount, the discount, what is left, the tiers
 * that applied (with how many packs of each) and whether any of them ships
 * free.
 */
function priceUnits(tiers, unitPrices) {
  const units = [...unitPrices].map(Number).sort((a, b) => b - a);
  const full = units.reduce((total, price) => total + price, 0);
  const ladder = [...tiers].filter((tier) => tier.quantity >= 1).sort((a, b) => b.quantity - a.quantity);
  const applied = new Map();
  let discount = 0;
  let freeShipping = false;
  let offset = 0;
  while (offset < units.length) {
    const remaining = units.length - offset;
    const tier = ladder.find((candidate) => candidate.quantity <= remaining);
    if (!tier) break;
    discount += tierDiscount(tier, units.slice(offset, offset + tier.quantity));
    if (tier.freeShipping) freeShipping = true;
    applied.set(tier.id, { tier, packs: (applied.get(tier.id)?.packs || 0) + 1 });
    offset += tier.quantity;
  }
  discount = Math.min(discount, full);
  return {
    full,
    discount,
    total: full - discount,
    freeShipping,
    tiers: [...applied.values()].map(({ tier, packs }) => ({
      tierId: tier.id,
      title: tier.title || null,
      sku: tier.sku || null,
      quantity: tier.quantity,
      packs,
    })),
  };
}

/** Active bundles of the given products: Map productId → { bundle, tiers }. */
async function bundlesForProducts(workspaceId, productIds, transaction) {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const products = await db.Product.findAll({
    where: { id: ids, workspaceId, bundleId: { [db.Sequelize.Op.ne]: null } },
    attributes: ['id', 'bundleId'],
    transaction,
  });
  if (products.length === 0) return new Map();
  const bundles = await db.Bundle.findAll({
    where: { id: [...new Set(products.map((p) => p.bundleId))], workspaceId, isActive: true },
    include: [{ model: db.BundleTier, as: 'tiers' }],
    transaction,
  });
  const byId = new Map(bundles.map((bundle) => [bundle.id, bundle]));
  const out = new Map();
  for (const product of products) {
    const bundle = byId.get(product.bundleId);
    if (bundle && bundle.tiers.length > 0) out.set(product.id, bundle);
  }
  return out;
}

/** Splits `discount` over `amounts` in proportion, whole minor units, summing exactly. */
function allocate(discount, amounts) {
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  if (total <= 0) return amounts.map(() => 0);
  let left = discount;
  return amounts.map((amount, index) => {
    const share = index === amounts.length - 1 ? left : Math.min(left, Math.floor((discount * amount) / total));
    left -= share;
    return share;
  });
}

/**
 * Applies bundle tiers to priced order lines, in place. A line counts when it
 * is a plain variant line (no offer, not an order bump) of a product with an
 * active bundle; all such lines of one product are priced together, so one
 * red and one blue of the same product are "2 units".
 *
 * Each discounted line gets `lineDiscountAmount` and a lower
 * `lineTotalAmount`; a tier with free shipping makes its lines ship free.
 * Returns one snapshot entry per product that got a discount or free
 * shipping, for the order's `discountsSnapshot`.
 */
async function applyBundleTiers(workspaceId, lines, transaction) {
  const eligible = lines.filter((line) => line.productId && !line.offerId && !line.isOrderBump && !line.isUpsell && !line.comboKey);
  if (eligible.length === 0) return [];
  const bundles = await bundlesForProducts(
    workspaceId,
    eligible.map((line) => line.productId),
    transaction
  );
  if (bundles.size === 0) return [];

  const snapshots = [];
  for (const [productId, bundle] of bundles) {
    const group = eligible.filter((line) => line.productId === productId);
    const unitCount = group.reduce((sum, line) => sum + line.quantity, 0);
    if (unitCount > MAX_UNITS) continue;
    const units = group.flatMap((line) => Array(line.quantity).fill(Number(line.unitPriceAmount)));
    const priced = priceUnits(bundle.tiers, units);
    if (priced.discount === 0 && !priced.freeShipping) continue;

    const shares = allocate(
      priced.discount,
      group.map((line) => Number(line.lineTotalAmount))
    );
    group.forEach((line, index) => {
      line.lineDiscountAmount = (Number(line.lineDiscountAmount) || 0) + shares[index];
      line.lineTotalAmount = Number(line.lineTotalAmount) - shares[index];
      if (priced.freeShipping && line.shippingRule) line.shippingRule = { ...line.shippingRule, mode: 'free', extraAmount: null };
    });
    snapshots.push({
      kind: 'bundle',
      bundleId: bundle.id,
      name: bundle.name,
      productId,
      amount: priced.discount,
      freeShipping: priced.freeShipping,
      tiers: priced.tiers,
    });
  }
  return snapshots;
}

/** A bundle as the storefront draws it for one product: every tier priced for every active variant. */
function presentBundle(bundle, variants) {
  const tiers = [...bundle.tiers].sort((a, b) => a.position - b.position || a.quantity - b.quantity);
  return {
    id: bundle.id,
    name: bundle.name,
    displayStyle: bundle.displayStyle,
    tiers: tiers.map((tier) => ({
      id: tier.id,
      title: tier.title,
      quantity: tier.quantity,
      discountType: tier.discountType,
      label: tier.label,
      stickerText: tier.stickerText,
      freeShipping: tier.freeShipping,
      isDefault: tier.isDefault,
      // What `quantity` units of each variant cost in this tier.
      prices: Object.fromEntries(
        variants.map((variant) => {
          const priced = priceUnits(bundle.tiers, Array(tier.quantity).fill(Number(variant.priceAmount)));
          return [variant.id, { full: priced.full, total: priced.total, discount: priced.discount }];
        })
      ),
    })),
  };
}

/**
 * The cart's totals (cartService.withComputedTotals) with bundle tiers
 * applied: each covered item's `lineTotal` drops, `subtotal` follows, and
 * `bundleDiscount` says by how much.
 */
async function applyToCartTotals(workspaceId, cart, totals) {
  const rows = cart.items || [];
  const lines = totals.items.map((item, index) => ({
    productId: rows[index] && rows[index].variant ? rows[index].variant.productId : null,
    offerId: item.offerId,
    // A combo's line is priced by the combo (modules/combos), never by a quantity bundle.
    comboKey: item.comboId || null,
    isOrderBump: item.isOrderBump,
    quantity: item.quantity,
    unitPriceAmount: Number(item.currentUnitPrice),
    lineTotalAmount: item.lineTotal,
  }));
  const snapshots = await applyBundleTiers(workspaceId, lines);
  if (snapshots.length === 0) return { ...totals, bundleDiscount: 0, bundles: [] };
  const items = totals.items.map((item, index) => ({
    ...item,
    lineDiscount: lines[index].lineDiscountAmount || 0,
    lineTotal: lines[index].lineTotalAmount,
  }));
  return {
    ...totals,
    items,
    subtotal: items.reduce((sum, item) => sum + item.lineTotal, 0),
    bundleDiscount: snapshots.reduce((sum, snapshot) => sum + snapshot.amount, 0),
    bundles: snapshots,
  };
}

module.exports = {
  applyToCartTotals,
  DISCOUNT_TYPES,
  MAX_UNITS,
  tierDiscount,
  priceUnits,
  allocate,
  bundlesForProducts,
  applyBundleTiers,
  presentBundle,
};
