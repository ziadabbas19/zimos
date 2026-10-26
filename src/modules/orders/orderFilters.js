'use strict';

/**
 * The orders list's filters beyond stage / search / dates (SPEC §4.3), as SQL
 * conditions on the orders alias `o`. Shared by the list, the tab counts, the
 * export and the bulk actions, so they can never disagree about which orders
 * a filter means. Every value is a bind parameter.
 *
 * Archived orders are left out unless `archived` says otherwise: archiving is
 * how a merchant "deletes" an order.
 */
function applyOrderFilters(conditions, bind, query = {}) {
  const { archived = 'exclude', tag, source, paymentMethod, governorate, carrier, seen, test, riskLevel, updatedSince, productId } = query;
  applyMoreFilters(conditions, bind, query);

  // the risk level risk/riskService gave the order.
  if (riskLevel) {
    conditions.push('o.risk_level = $filterRiskLevel');
    bind.filterRiskLevel = riskLevel;
  }

  if (archived === 'only') conditions.push('o.archived_at IS NOT NULL');
  else if (archived !== 'include') conditions.push('o.archived_at IS NULL');

  if (tag) {
    // Case-insensitive: "VIP" and "vip" are one tag to the person filtering.
    conditions.push('EXISTS (SELECT 1 FROM unnest(o.tags) AS t(tag) WHERE lower(t.tag) = lower($filterTag))');
    bind.filterTag = tag;
  }
  if (source) {
    conditions.push('o.source = $filterSource');
    bind.filterSource = source;
  }
  if (paymentMethod) {
    conditions.push('o.payment_method = $filterPaymentMethod');
    bind.filterPaymentMethod = paymentMethod;
  }
  if (governorate) {
    conditions.push("lower(coalesce(o.shipping_address_snapshot->>'province', '')) = lower($filterGovernorate)");
    bind.filterGovernorate = governorate;
  }
  if (carrier) {
    conditions.push(
      `EXISTS (SELECT 1 FROM shipments fs
                WHERE fs.order_id = o.id AND fs.status <> 'cancelled' AND lower(fs.carrier_code) = lower($filterCarrier))`
    );
    bind.filterCarrier = carrier;
  }
  if (seen !== undefined && seen !== null) conditions.push(seen ? 'o.is_seen' : 'NOT o.is_seen');
  if (test !== undefined && test !== null) conditions.push(test ? 'o.is_test' : 'NOT o.is_test');
  if (updatedSince) {
    conditions.push('o.updated_at >= $filterUpdatedSince');
    bind.filterUpdatedSince = updatedSince;
  }
  if (productId) {
    conditions.push(
      `EXISTS (SELECT 1 FROM order_items fi JOIN product_variants fv ON fv.id = fi.variant_id
                WHERE fi.order_id = o.id AND fv.product_id = $filterProductId)`
    );
    bind.filterProductId = productId;
  }
  // Accepted orders only (orderAccepted.js): the accepted-orders export. Set
  // by the server for that export, never read from a request (no schema has it).
  if (query.accepted === true) conditions.push(require('./orderAccepted').ACCEPTED_SQL);
}

/**
 * The rest of SPEC §4.3: data quality and IP country (risk/riskService), a
 * discount code the order used, the visit's utm_source / utm_campaign (the
 * last touch, else the first: marketing/orderAttribution.js) and the funnel.
 */
function applyMoreFilters(conditions, bind, { dataQuality, ipCountry, discountCode, utmSource, utmCampaign, funnelId, ids }) {
  // Named orders ("export selected"): a comma-separated list of ids.
  if (ids) {
    conditions.push('o.id = ANY($filterIds::uuid[])');
    bind.filterIds = String(ids).split(',');
  }
  if (dataQuality) {
    conditions.push('o.data_quality = $filterDataQuality');
    bind.filterDataQuality = dataQuality;
  }
  if (ipCountry) {
    conditions.push('upper(o.ip_country) = upper($filterIpCountry)');
    bind.filterIpCountry = ipCountry;
  }
  if (discountCode) {
    conditions.push(
      `EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(o.discounts_snapshot) = 'array' THEN o.discounts_snapshot ELSE '[]'::jsonb END) fd
                WHERE lower(fd->>'code') = lower($filterDiscountCode))`
    );
    bind.filterDiscountCode = discountCode;
  }
  const touch = (key) => `lower(coalesce(nullif(o.attribution->'last'->>'${key}', ''), o.attribution->'first'->>'${key}'))`;
  if (utmSource) {
    conditions.push(`${touch('source')} = lower($filterUtmSource)`);
    bind.filterUtmSource = utmSource;
  }
  if (utmCampaign) {
    conditions.push(`${touch('campaign')} = lower($filterUtmCampaign)`);
    bind.filterUtmCampaign = utmCampaign;
  }
  if (funnelId) {
    conditions.push('o.funnel_id = $filterFunnelId');
    bind.filterFunnelId = funnelId;
  }
}

module.exports = { applyOrderFilters };
