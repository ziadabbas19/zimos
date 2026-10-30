'use strict';

const db = require('../../db/models');
const { applyBasisPoints } = require('../../core/utils/money');

/**
 * Computes tax for a set of order lines using the workspace's configured
 * TaxRate rows: a product-specific rate takes precedence over the
 * workspace-wide default for that country/region. Prices-include-tax mode
 * is supported by treating the rate as already baked into the line price
 * (returning 0 additional tax, since the amount was already collected) —
 * callers that need the *implied* tax portion for reporting can derive it
 * from rateBasisPoints separately.
 *
 * Tax is opt-in: unless workspace.settings.tax_enabled is true this returns
 * zero tax regardless of how many TaxRate rows exist.
 *
 * `transaction`: the caller's, when it prices inside one (order creation and
 * edits). A read outside it would wait for a second pooled connection while
 * the transaction holds the first, and a burst of checkouts starves the pool.
 */
async function calculateTax(workspaceId, { country, region, lines, shippingAmount, transaction }) {
  const workspace = await db.Workspace.findByPk(workspaceId, { transaction });
  const taxEnabled = Boolean(workspace && workspace.settings && workspace.settings.tax_enabled);
  if (!taxEnabled) return { taxAmount: 0, pricesIncludeTax: false };

  const rates = await db.TaxRate.findAll({ where: { workspaceId }, transaction });
  if (rates.length === 0) return { taxAmount: 0, pricesIncludeTax: false };

  const matchRate = (productId) => {
    const productSpecific = rates.find((r) => r.productId === productId && matchesRegion(r, country, region));
    if (productSpecific) return productSpecific;
    return rates.find((r) => !r.productId && matchesRegion(r, country, region));
  };

  let taxAmount = 0;
  let pricesIncludeTax = false;

  const lineRates = [];
  for (const line of lines) {
    const rate = matchRate(line.productId);
    if (!rate) continue;
    lineRates.push(rate);
    if (rate.pricesIncludeTax) {
      pricesIncludeTax = true;
      continue; // Tax already included in lineTotal; not added on top.
    }
    taxAmount += applyBasisPoints(line.lineTotal, rate.rateBasisPoints);
  }
  // Shipping is charged once, so it is taxed once (it was taxed once per line): at the
  // store-wide rate for the destination, or, with none, the first line's rate that covers shipping.
  if (shippingAmount && lineRates.length) {
    const shippingRate = rates.find((r) => !r.productId && matchesRegion(r, country, region)) || lineRates.find((r) => r.appliesToShipping);
    if (shippingRate && shippingRate.appliesToShipping && !shippingRate.pricesIncludeTax) taxAmount += applyBasisPoints(shippingAmount, shippingRate.rateBasisPoints);
  }

  return { taxAmount, pricesIncludeTax };
}

/**
 * The lines calculateTax should tax: each line's total less its share of the
 * order-level discount (a code or an automatic discount), so tax is charged on
 * what the shopper pays, not the price before the discount.
 * `lines` are priced lines ({ productId, lineTotalAmount, freeGift? }). The
 * discount is spread in proportion over the lines it covers: a product- or
 * collection-limited one over its covered lines only, any other over every
 * line; a free gift never takes a share. Bundle savings are already in the
 * line totals. Returns [{ productId, lineTotal }].
 */
async function taxableLines(lines, discountAmount, discount, transaction) {
  const totals = lines.map((l) => Number(l.lineTotalAmount) || 0);
  const amount = Math.max(0, Math.min(Number(discountAmount) || 0, totals.reduce((sum, t) => sum + t, 0)));
  const out = lines.map((l, i) => ({ productId: l.productId, lineTotal: totals[i] }));
  if (!amount) return out;
  const discountService = require('../discounts/discountService');
  const eligible = discount
    ? await discountService.eligibleProducts(discount, lines.filter((l) => !l.freeGift).map((l) => l.productId), transaction)
    : null;
  // The coupon's own line rules too (excluded products, offers, sale items: discounts/discountRules.js).
  const covers = (l) => (discount ? require('../discounts/discountRules').lineCovered(discount, eligible, l) : !l.freeGift);
  let indexes = lines.map((l, i) => i).filter((i) => covers(lines[i]) && totals[i] > 0);
  // A discount larger than its covered lines (or one whose lines are gone) is spread over the whole order.
  if (indexes.reduce((sum, i) => sum + totals[i], 0) < amount) indexes = lines.map((l, i) => i).filter((i) => totals[i] > 0);
  const { allocate } = require('../bundles/bundlePricing');
  const shares = allocate(amount, indexes.map((i) => totals[i]));
  indexes.forEach((i, k) => {
    out[i].lineTotal = Math.max(0, totals[i] - shares[k]);
  });
  return out;
}

function matchesRegion(rate, country, region) {
  if (rate.country && rate.country !== country) return false;
  if (rate.region && rate.region !== region) return false;
  return true;
}

module.exports = { calculateTax, taxableLines };
