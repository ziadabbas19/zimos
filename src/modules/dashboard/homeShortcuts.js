'use strict';

const { PERMISSIONS: P } = require('../../core/security/permissions');
const { storeFeatureOn } = require('../../core/middleware/storeFeatures');
const { aiEnabled } = require('../ai/aiGate');

/**
 * The Home page's shortcuts row: what a member may put on it, and what each
 * one needs. The id is what is stored (memberships.home_shortcuts), so it never
 * changes; the words, icon and path live in the dashboard's own catalogue
 * (pages/home/shortcutCatalog.ts), which a test there keeps in step with this
 * list.
 *
 *   requires  the role must hold one of these: what the dashboard's side menu
 *             asks of the same page (lib/navigation). None: any member. The
 *             two actions ask what the row always asked (the page they sit
 *             under), so a member who never arranged the row sees it unchanged.
 *   plan      the store's plan must hold this key while the gate refuses it;
 *             gate names the planFeaturesFor switch that decides that.
 *   on        the feature behind the page is switched on for this deploy.
 *
 * No database in this file: every answer is worked out from what the caller
 * read already, which is how the dashboard bootstrap can carry it for free.
 */
const anyStoreFeature = (...names) => () => names.some(storeFeatureOn);

const HOME_SHORTCUT_CATALOG = Object.freeze(
  [
    { id: 'new_order', requires: [P.ORDERS_VIEW] },
    { id: 'orders', requires: [P.ORDERS_VIEW] },
    { id: 'confirmation_queue', requires: [P.ORDERS_CONFIRM, P.ORDERS_MANAGE] },
    { id: 'lost_orders', requires: [P.ORDERS_VIEW] },
    { id: 'returns', requires: [P.ORDERS_VIEW] },
    { id: 'fraud', requires: [] },

    { id: 'add_product', requires: [P.PRODUCTS_VIEW] },
    { id: 'products', requires: [P.PRODUCTS_VIEW] },
    { id: 'reviews', requires: [P.PRODUCTS_MANAGE], plan: 'reviews', gate: 'growthEnforced' },
    { id: 'questions', requires: [P.PRODUCTS_VIEW], on: anyStoreFeature('product_questions') },
    { id: 'size_charts', requires: [P.PRODUCTS_VIEW], on: anyStoreFeature('size_charts') },
    { id: 'digital_products', requires: [P.PRODUCTS_VIEW] },
    { id: 'courses', requires: [P.PRODUCTS_VIEW] },
    { id: 'media', requires: [P.PRODUCTS_MANAGE] },

    { id: 'customers', requires: [P.CUSTOMERS_VIEW] },
    { id: 'loyalty', requires: [P.CUSTOMERS_VIEW], on: anyStoreFeature('loyalty', 'vip_tiers', 'customer_referrals', 'store_credit') },
    { id: 'inbox', requires: [P.ORDERS_CONFIRM] },

    { id: 'marketing', requires: [P.WORKSPACE_MANAGE] },
    { id: 'offers', requires: [P.PRODUCTS_VIEW] },
    { id: 'discounts', requires: [P.DISCOUNTS_MANAGE] },
    { id: 'gift_cards', requires: [P.DISCOUNTS_MANAGE], on: anyStoreFeature('gift_cards') },
    { id: 'automations', requires: [P.AUTOMATIONS_MANAGE] },
    { id: 'ai_studio', requires: [P.PRODUCTS_MANAGE, P.WEBSITE_EDIT, P.FUNNELS_MANAGE, P.ORDERS_CONFIRM], on: aiEnabled },

    { id: 'website', requires: [P.WEBSITE_EDIT] },
    { id: 'blog', requires: [P.WEBSITE_EDIT], on: anyStoreFeature('blog') },
    { id: 'funnels', requires: [P.FUNNELS_MANAGE] },
    { id: 'shoppable_images', requires: [P.PRODUCTS_VIEW] },
    { id: 'store_settings', requires: [P.WEBSITE_EDIT] },

    { id: 'analytics', requires: [P.ANALYTICS_VIEW] },
    { id: 'realtime', requires: [P.ANALYTICS_VIEW], plan: 'advanced_analytics' },
    { id: 'web_analytics', requires: [P.ANALYTICS_VIEW], plan: 'advanced_analytics' },
    { id: 'visitors', requires: [P.ANALYTICS_VIEW], plan: 'advanced_analytics' },
    { id: 'attribution', requires: [P.ANALYTICS_VIEW] },
    { id: 'profit', requires: [P.FINANCIAL_REPORTS_VIEW] },
    { id: 'ad_spend', requires: [P.FINANCIAL_REPORTS_VIEW] },

    { id: 'payments', requires: [P.WORKSPACE_MANAGE] },
    { id: 'settlements', requires: [P.FINANCIAL_REPORTS_VIEW] },
    { id: 'shipping', requires: [P.SHIPPING_MANAGE, P.TAX_MANAGE] },

    { id: 'subscription', requires: [P.BILLING_MANAGE] },
    { id: 'settings', requires: [] },
    { id: 'activity', requires: [P.AUDIT_LOG_VIEW] },
    { id: 'services', requires: [] },
    { id: 'support', requires: [P.WORKSPACE_MANAGE] },
    { id: 'suggestions', requires: [] },
  ].map((entry) => Object.freeze(entry))
);

const HOME_SHORTCUT_IDS = Object.freeze(HOME_SHORTCUT_CATALOG.map((entry) => entry.id));
const MAX_HOME_SHORTCUTS = 12;

/** The row of a member who never arranged it: the row Home always had, in its order. */
const DEFAULT_HOME_SHORTCUTS = Object.freeze([
  'new_order',
  'add_product',
  'confirmation_queue',
  'orders',
  'lost_orders',
  'discounts',
  'website',
  'store_settings',
]);

function roleMay(entry, tenant) {
  return entry.requires.length === 0 || entry.requires.some((permission) => tenant.hasPermission(permission));
}

function planLocks(entry, planFeatures) {
  if (!entry.plan || planFeatures[entry.gate || 'enforced'] !== true) return false;
  return !planFeatures.features.includes(entry.plan);
}

/**
 * The ids this member may have on the row in this store, in catalogue order:
 * their role, the store's plan (planFeaturesFor's answer) and this deploy's
 * switches all allow the page.
 */
function allowedIds(tenant, planFeatures) {
  return HOME_SHORTCUT_CATALOG.filter((entry) => (!entry.on || entry.on()) && roleMay(entry, tenant) && !planLocks(entry, planFeatures)).map(
    (entry) => entry.id
  );
}

/**
 * The body of GET /home-shortcuts, and the bootstrap's part. What is stored
 * stays as it is when a role or a plan changes; only what is shown narrows, so
 * a page comes back to the row when the member may open it again.
 */
function forMember(tenant, planFeatures) {
  const available = allowedIds(tenant, planFeatures);
  const allowed = new Set(available);
  const stored = tenant.membership.homeShortcuts;
  const customized = Array.isArray(stored);
  return {
    customized,
    shortcuts: [...new Set(customized ? stored : DEFAULT_HOME_SHORTCUTS)].filter((id) => allowed.has(id)),
    defaults: DEFAULT_HOME_SHORTCUTS.filter((id) => allowed.has(id)),
    available,
    max: MAX_HOME_SHORTCUTS,
  };
}

module.exports = {
  HOME_SHORTCUT_CATALOG,
  HOME_SHORTCUT_IDS,
  DEFAULT_HOME_SHORTCUTS,
  MAX_HOME_SHORTCUTS,
  allowedIds,
  forMember,
};
