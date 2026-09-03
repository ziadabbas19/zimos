'use strict';

/**
 * Canonical list of permission strings. Every permission check in the
 * system (core/middleware/rbac.js#requirePermission) checks membership in a
 * Role's `permissions` array against exactly one of these strings — nothing
 * is inferred, nothing is wildcarded implicitly except the explicit '*' held
 * by the Owner role.
 */
const PERMISSIONS = Object.freeze({
  WORKSPACE_MANAGE: 'workspace.manage',
  USERS_MANAGE: 'users.manage',
  ROLES_MANAGE: 'roles.manage',

  WEBSITE_EDIT: 'website.edit',
  WEBSITE_PUBLISH: 'website.publish',
  TEMPLATE_MANAGE: 'template.manage',
  DOMAIN_MANAGE: 'domain.manage',

  PRODUCTS_MANAGE: 'products.manage',
  PRODUCTS_VIEW: 'products.view',
  INVENTORY_MANAGE: 'inventory.manage',
  INVENTORY_VIEW: 'inventory.view',

  FUNNELS_MANAGE: 'funnels.manage',
  FUNNELS_PUBLISH: 'funnels.publish',

  ORDERS_VIEW: 'orders.view',
  ORDERS_MANAGE: 'orders.manage',
  ORDERS_CONFIRM: 'orders.confirm',

  CUSTOMERS_VIEW: 'customers.view',
  CUSTOMERS_MANAGE: 'customers.manage',
  CUSTOMERS_REVEAL_SENSITIVE: 'customers.reveal_sensitive',

  SHIPPING_MANAGE: 'shipping.manage',
  TAX_MANAGE: 'tax.manage',
  REFUNDS_MANAGE: 'refunds.manage',
  DISCOUNTS_MANAGE: 'discounts.manage',

  ANALYTICS_VIEW: 'analytics.view',
  FINANCIAL_REPORTS_VIEW: 'financial_reports.view',

  API_KEYS_MANAGE: 'api_keys.manage',
  WEBHOOKS_MANAGE: 'webhooks.manage',
  AUTOMATIONS_MANAGE: 'automations.manage',

  BILLING_MANAGE: 'billing.manage',
  AUDIT_LOG_VIEW: 'audit_log.view',
});

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

// System roles seeded into every new workspace. `permissions: ['*']` means
// "every permission, including ones added in the future" and is reserved
// for Owner — see rbac.js, which special-cases '*' rather than expanding it
// into a static list.
const SYSTEM_ROLES = Object.freeze({
  owner: { key: 'owner', name: 'Owner', permissions: ['*'] },
  workspace_manager: {
    key: 'workspace_manager',
    name: 'Workspace Manager',
    permissions: [
      PERMISSIONS.WORKSPACE_MANAGE,
      PERMISSIONS.USERS_MANAGE,
      PERMISSIONS.ROLES_MANAGE,
      PERMISSIONS.WEBSITE_EDIT,
      PERMISSIONS.WEBSITE_PUBLISH,
      PERMISSIONS.TEMPLATE_MANAGE,
      PERMISSIONS.DOMAIN_MANAGE,
      PERMISSIONS.PRODUCTS_MANAGE,
      PERMISSIONS.PRODUCTS_VIEW,
      PERMISSIONS.INVENTORY_MANAGE,
      PERMISSIONS.INVENTORY_VIEW,
      PERMISSIONS.FUNNELS_MANAGE,
      PERMISSIONS.FUNNELS_PUBLISH,
      PERMISSIONS.ORDERS_VIEW,
      PERMISSIONS.ORDERS_MANAGE,
      PERMISSIONS.CUSTOMERS_VIEW,
      PERMISSIONS.CUSTOMERS_MANAGE,
      PERMISSIONS.SHIPPING_MANAGE,
      PERMISSIONS.TAX_MANAGE,
      PERMISSIONS.REFUNDS_MANAGE,
      PERMISSIONS.DISCOUNTS_MANAGE,
      PERMISSIONS.ANALYTICS_VIEW,
      PERMISSIONS.FINANCIAL_REPORTS_VIEW,
      PERMISSIONS.API_KEYS_MANAGE,
      PERMISSIONS.WEBHOOKS_MANAGE,
      PERMISSIONS.AUTOMATIONS_MANAGE,
      PERMISSIONS.AUDIT_LOG_VIEW,
    ],
  },
  editor: {
    key: 'editor',
    name: 'Editor',
    permissions: [
      PERMISSIONS.WEBSITE_EDIT,
      PERMISSIONS.TEMPLATE_MANAGE,
      PERMISSIONS.PRODUCTS_MANAGE,
      PERMISSIONS.PRODUCTS_VIEW,
      PERMISSIONS.FUNNELS_MANAGE,
      PERMISSIONS.INVENTORY_VIEW,
    ],
  },
  order_operator: {
    key: 'order_operator',
    name: 'Order Operator',
    permissions: [
      PERMISSIONS.ORDERS_VIEW,
      PERMISSIONS.ORDERS_MANAGE,
      PERMISSIONS.INVENTORY_VIEW,
      PERMISSIONS.CUSTOMERS_VIEW,
      PERMISSIONS.SHIPPING_MANAGE,
      PERMISSIONS.PRODUCTS_VIEW,
    ],
  },
  confirmation_agent: {
    key: 'confirmation_agent',
    name: 'Confirmation Agent',
    permissions: [PERMISSIONS.ORDERS_VIEW, PERMISSIONS.ORDERS_CONFIRM, PERMISSIONS.CUSTOMERS_VIEW],
  },
  accountant: {
    key: 'accountant',
    name: 'Accountant',
    permissions: [
      PERMISSIONS.ORDERS_VIEW,
      PERMISSIONS.REFUNDS_MANAGE,
      PERMISSIONS.TAX_MANAGE,
      PERMISSIONS.FINANCIAL_REPORTS_VIEW,
      PERMISSIONS.ANALYTICS_VIEW,
      PERMISSIONS.BILLING_MANAGE,
    ],
  },
});

module.exports = { PERMISSIONS, ALL_PERMISSIONS, SYSTEM_ROLES };
