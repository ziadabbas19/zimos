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
 */
async function calculateTax(workspaceId, { country, region, lines, shippingAmount }) {
  const rates = await db.TaxRate.findAll({ where: { workspaceId } });
  if (rates.length === 0) return { taxAmount: 0, pricesIncludeTax: false };

  const matchRate = (productId) => {
    const productSpecific = rates.find((r) => r.productId === productId && matchesRegion(r, country, region));
    if (productSpecific) return productSpecific;
    return rates.find((r) => !r.productId && matchesRegion(r, country, region));
  };

  let taxAmount = 0;
  let pricesIncludeTax = false;

  for (const line of lines) {
    const rate = matchRate(line.productId);
    if (!rate) continue;
    if (rate.pricesIncludeTax) {
      pricesIncludeTax = true;
      continue; // Tax already included in lineTotal; not added on top.
    }
    taxAmount += applyBasisPoints(line.lineTotal, rate.rateBasisPoints);
    if (rate.appliesToShipping && shippingAmount) {
      taxAmount += applyBasisPoints(shippingAmount, rate.rateBasisPoints);
    }
  }

  return { taxAmount, pricesIncludeTax };
}

function matchesRegion(rate, country, region) {
  if (rate.country && rate.country !== country) return false;
  if (rate.region && rate.region !== region) return false;
  return true;
}

module.exports = { calculateTax };
