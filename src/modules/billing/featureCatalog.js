'use strict';

/**
 * The feature keys a plan can list in plans.features — the one place they are
 * defined. The platform console reads this list from GET /admin/plans (keys,
 * names, whether each is available), the api-client keeps PlanFeatureKey in
 * step, and an override can be refused for a key nobody defined. Every one of
 * them is an on/off feature: none carries a numeric limit today, so an
 * override's `value` must stay empty.
 *
 * `available` says whether the feature behind the key exists in the product
 * today. One that doesn't:
 *  - is left out of every plan served to merchants and visitors (the pricing
 *    page, sign-up, the Subscription section), whatever plans.features holds;
 *  - can't be added to a plan from the console (422 PLAN_FEATURE_NOT_AVAILABLE),
 *    though a plan that already lists it keeps it until someone removes it.
 * Nothing stored is changed: making a key available again shows it again.
 *
 * Adding a key: here, and in PlanFeatureKey (packages/api-client).
 */
const FEATURE_CATALOG = Object.freeze(
  [
    // The API exists (modules/domains); there is no dashboard screen yet, and
    // the Next storefront doesn't serve custom hosts (REPORT-plan-features).
    { key: 'custom_domain', available: true, label: { en: 'Custom domain', ar: 'نطاق خاص' } },
    { key: 'funnels', available: true, label: { en: 'Sales funnels', ar: 'مسارات البيع' } },
    // The confirmation queue's WhatsApp button and message (sent by the
    // merchant's own WhatsApp; nothing is sent automatically).
    { key: 'whatsapp_confirmation', available: true, label: { en: 'WhatsApp order confirmation', ar: 'تأكيد الطلبات عبر واتساب' } },
    // The abandoned-checkout list and its follow-up status (no message is sent).
    { key: 'abandoned_cart', available: true, label: { en: 'Abandoned cart recovery', ar: 'استرجاع السلات المتروكة' } },
    // Stock is one number per variant; there are no warehouses.
    { key: 'multi_warehouse', available: false, label: { en: 'Multiple warehouses', ar: 'مستودعات متعددة' } },
    // The public API (modules/publicApi) and its keys (modules/apiKeys).
    // Minting a new key needs it while the gate is on; a key already minted
    // keeps working on any plan (apiKeys/apiKeyRoutes).
    { key: 'api_access', available: true, label: { en: 'API access', ar: 'الوصول عبر API' } },
    { key: 'staff_accounts', available: true, label: { en: 'Staff accounts', ar: 'حسابات الفريق' } },
    { key: 'advanced_analytics', available: true, label: { en: 'Advanced analytics', ar: 'تحليلات متقدمة' } },
    // On top of advanced_analytics: the Visitors section's visits and each
    // visit in order, outcomes per governorate, and campaigns with spend and
    // cost per order (analytics/traffic/visitorRoutes.js).
    { key: 'visitor_insights', available: true, label: { en: 'Visitor insights', ar: 'تحليلات الزوار المفصّلة' } },
    // The store's "Hide ZIMOS branding" setting takes effect only while the
    // store has this (storefront/platformBranding.js).
    { key: 'remove_branding', available: true, label: { en: 'Remove platform branding', ar: 'إزالة شعار المنصة' } },
    // A ticket the store opens starts at high priority (support/supportService).
    { key: 'priority_support', available: true, label: { en: 'Priority support', ar: 'دعم ذو أولوية' } },
  ].map((f) => Object.freeze({ ...f, type: 'boolean', label: Object.freeze(f.label) }))
);

const FEATURE_KEYS = Object.freeze(FEATURE_CATALOG.map((f) => f.key));
const byKey = new Map(FEATURE_CATALOG.map((f) => [f.key, f]));

const featureDefinition = (key) => byKey.get(key) || null;

/** True for a catalogue key whose feature exists today. */
const isAvailableFeature = (key) => Boolean(featureDefinition(key) && featureDefinition(key).available);

/**
 * plans.features has been stored two ways — a { key: true } map (the first
 * seed) and a plain array (the console's plan editor). The enabled keys.
 */
function planFeatureKeys(features) {
  if (Array.isArray(features)) return features.filter((k) => typeof k === 'string');
  if (features && typeof features === 'object') return Object.keys(features).filter((k) => features[k]);
  return [];
}

/** A plan's keys as merchants and visitors see them: catalogue keys whose feature exists. */
function availableFeatureKeys(features) {
  return planFeatureKeys(features).filter(isAvailableFeature);
}

/** The whole catalogue for the console: key, names, available. */
function catalogForAdmin() {
  return FEATURE_CATALOG.map(({ key, type, available, label }) => ({ key, type, available, label: { ...label } }));
}

module.exports = {
  FEATURE_CATALOG,
  FEATURE_KEYS,
  featureDefinition,
  isAvailableFeature,
  planFeatureKeys,
  availableFeatureKeys,
  catalogForAdmin,
};
