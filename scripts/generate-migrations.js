'use strict';

/**
 * Generates one createTable migration per model, in explicit dependency
 * order, plus a handful of follow-up migrations for constraints that would
 * otherwise create circular table dependencies (self-references and
 * forward references are added as separate ALTER TABLE migrations once both
 * sides exist). This keeps every column's type in lockstep with the actual
 * Sequelize model definition instead of hand-duplicating the schema.
 *
 * Run with: node scripts/generate-migrations.js
 */

const fs = require('fs');
const path = require('path');
const db = require('../src/db/models');
const { serialize } = require('./_dataTypeSerializer');

const MIGRATIONS_DIR = path.resolve(__dirname, '../src/db/migrations');

// Explicit dependency order: a model may only reference (via FK) models that
// appear earlier in this list. Circular / forward references are declared in
// EXTRA_CONSTRAINTS below and applied as follow-up migrations.
const ORDER = [
  'User', 'Workspace', 'Role', 'Membership', 'Session', 'AuditLog', 'ApiKey',
  'Template', 'TemplateVersion', 'Website', 'WebsitePage', 'WebsiteRevision', 'Domain',
  'Funnel', 'FunnelStep', 'FunnelEdge',
  'Product', 'ProductVariant', 'Offer', 'OfferVariant', 'Collection', 'ProductCollection',
  'InventoryMovement',
  'Customer', 'CustomerAddress',
  'Cart', 'CartItem', 'CheckoutSession',
  'Order', 'OrderItem', 'FunnelSession',
  'IdempotencyKey',
  'ConfirmationTask', 'ConfirmationAttempt',
  'ShippingZone', 'ShippingRate', 'Shipment',
  'Payment', 'Refund', 'ReturnRequest',
  'Discount', 'DiscountRedemption', 'TaxRate',
  'InvoiceCounter', 'Invoice', 'CreditNote',
  'AnalyticsEvent', 'Experiment', 'ExperimentAssignment',
  'Plan', 'Subscription', 'BillingInvoice',
  'WebhookEndpoint', 'WebhookDelivery',
  'NotificationLog', 'AutomationRule',
];

// field -> { table, column?, onDelete } for FKs enforced at createTable time.
// Only backward references (target table already created earlier in ORDER)
// belong here.
const FK = {
  Workspace: { owner_user_id: { table: 'users', onDelete: 'RESTRICT' } },
  Role: { workspace_id: { table: 'workspaces', onDelete: 'CASCADE' } },
  Membership: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    user_id: { table: 'users', onDelete: 'CASCADE' },
    role_id: { table: 'roles', onDelete: 'RESTRICT' },
  },
  Session: { user_id: { table: 'users', onDelete: 'CASCADE' } },
  AuditLog: {
    workspace_id: { table: 'workspaces', onDelete: 'SET NULL', allowNull: true },
    actor_user_id: { table: 'users', onDelete: 'SET NULL', allowNull: true },
  },
  ApiKey: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    created_by_user_id: { table: 'users', onDelete: 'RESTRICT' },
  },
  TemplateVersion: { template_id: { table: 'templates', onDelete: 'CASCADE' } },
  Website: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    source_template_version_id: { table: 'template_versions', onDelete: 'SET NULL', allowNull: true },
  },
  WebsitePage: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    website_id: { table: 'websites', onDelete: 'CASCADE' },
  },
  WebsiteRevision: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    website_id: { table: 'websites', onDelete: 'CASCADE' },
    published_by_user_id: { table: 'users', onDelete: 'RESTRICT' },
  },
  Domain: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    website_id: { table: 'websites', onDelete: 'CASCADE' },
  },
  Funnel: { workspace_id: { table: 'workspaces', onDelete: 'CASCADE' } },
  FunnelStep: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    funnel_id: { table: 'funnels', onDelete: 'CASCADE' },
  },
  FunnelEdge: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    funnel_id: { table: 'funnels', onDelete: 'CASCADE' },
  },
  Product: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    website_id: { table: 'websites', onDelete: 'SET NULL', allowNull: true },
  },
  ProductVariant: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    product_id: { table: 'products', onDelete: 'CASCADE' },
  },
  Offer: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    product_id: { table: 'products', onDelete: 'CASCADE' },
  },
  OfferVariant: {
    offer_id: { table: 'offers', onDelete: 'CASCADE' },
    variant_id: { table: 'product_variants', onDelete: 'RESTRICT' },
  },
  Collection: { workspace_id: { table: 'workspaces', onDelete: 'CASCADE' } },
  ProductCollection: {
    product_id: { table: 'products', onDelete: 'CASCADE' },
    collection_id: { table: 'collections', onDelete: 'CASCADE' },
  },
  InventoryMovement: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    variant_id: { table: 'product_variants', onDelete: 'CASCADE' },
    actor_user_id: { table: 'users', onDelete: 'SET NULL', allowNull: true },
  },
  Customer: { workspace_id: { table: 'workspaces', onDelete: 'CASCADE' } },
  CustomerAddress: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    customer_id: { table: 'customers', onDelete: 'CASCADE' },
  },
  Cart: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    website_id: { table: 'websites', onDelete: 'SET NULL', allowNull: true },
    funnel_id: { table: 'funnels', onDelete: 'SET NULL', allowNull: true },
    customer_id: { table: 'customers', onDelete: 'SET NULL', allowNull: true },
  },
  CartItem: {
    cart_id: { table: 'carts', onDelete: 'CASCADE' },
    variant_id: { table: 'product_variants', onDelete: 'RESTRICT' },
    offer_id: { table: 'offers', onDelete: 'SET NULL', allowNull: true },
  },
  CheckoutSession: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    cart_id: { table: 'carts', onDelete: 'CASCADE' },
  },
  Order: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    website_id: { table: 'websites', onDelete: 'SET NULL', allowNull: true },
    funnel_id: { table: 'funnels', onDelete: 'SET NULL', allowNull: true },
    customer_id: { table: 'customers', onDelete: 'RESTRICT' },
  },
  OrderItem: { order_id: { table: 'orders', onDelete: 'CASCADE' } },
  FunnelSession: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    funnel_id: { table: 'funnels', onDelete: 'CASCADE' },
    order_id: { table: 'orders', onDelete: 'SET NULL', allowNull: true },
  },
  IdempotencyKey: { workspace_id: { table: 'workspaces', onDelete: 'CASCADE' } },
  ConfirmationTask: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    order_id: { table: 'orders', onDelete: 'CASCADE' },
    locked_by_user_id: { table: 'users', onDelete: 'SET NULL', allowNull: true },
  },
  ConfirmationAttempt: {
    task_id: { table: 'confirmation_tasks', onDelete: 'CASCADE' },
    agent_user_id: { table: 'users', onDelete: 'RESTRICT' },
  },
  ShippingZone: { workspace_id: { table: 'workspaces', onDelete: 'CASCADE' } },
  ShippingRate: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    zone_id: { table: 'shipping_zones', onDelete: 'CASCADE' },
  },
  Shipment: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    order_id: { table: 'orders', onDelete: 'CASCADE' },
  },
  Payment: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    order_id: { table: 'orders', onDelete: 'CASCADE' },
  },
  Refund: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    order_id: { table: 'orders', onDelete: 'CASCADE' },
    payment_id: { table: 'payments', onDelete: 'SET NULL', allowNull: true },
    processed_by_user_id: { table: 'users', onDelete: 'SET NULL', allowNull: true },
  },
  ReturnRequest: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    order_id: { table: 'orders', onDelete: 'CASCADE' },
  },
  Discount: { workspace_id: { table: 'workspaces', onDelete: 'CASCADE' } },
  DiscountRedemption: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    discount_id: { table: 'discounts', onDelete: 'CASCADE' },
    order_id: { table: 'orders', onDelete: 'CASCADE' },
    customer_id: { table: 'customers', onDelete: 'SET NULL', allowNull: true },
  },
  TaxRate: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    product_id: { table: 'products', onDelete: 'CASCADE', allowNull: true },
  },
  InvoiceCounter: { workspace_id: { table: 'workspaces', onDelete: 'CASCADE' } },
  Invoice: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    order_id: { table: 'orders', onDelete: 'RESTRICT' },
  },
  CreditNote: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    invoice_id: { table: 'invoices', onDelete: 'RESTRICT' },
    refund_id: { table: 'refunds', onDelete: 'SET NULL', allowNull: true },
  },
  AnalyticsEvent: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    website_id: { table: 'websites', onDelete: 'SET NULL', allowNull: true },
    funnel_id: { table: 'funnels', onDelete: 'SET NULL', allowNull: true },
    order_id: { table: 'orders', onDelete: 'SET NULL', allowNull: true },
  },
  Experiment: { workspace_id: { table: 'workspaces', onDelete: 'CASCADE' } },
  ExperimentAssignment: {
    experiment_id: { table: 'experiments', onDelete: 'CASCADE' },
    order_id: { table: 'orders', onDelete: 'SET NULL', allowNull: true },
  },
  Subscription: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    plan_id: { table: 'plans', onDelete: 'RESTRICT' },
  },
  BillingInvoice: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    subscription_id: { table: 'subscriptions', onDelete: 'CASCADE' },
  },
  WebhookEndpoint: { workspace_id: { table: 'workspaces', onDelete: 'CASCADE' } },
  WebhookDelivery: {
    workspace_id: { table: 'workspaces', onDelete: 'CASCADE' },
    endpoint_id: { table: 'webhook_endpoints', onDelete: 'CASCADE' },
  },
  NotificationLog: { workspace_id: { table: 'workspaces', onDelete: 'CASCADE', allowNull: true } },
  AutomationRule: { workspace_id: { table: 'workspaces', onDelete: 'CASCADE' } },
};

function pad(n) {
  return String(n).padStart(3, '0');
}

function toSnake(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function buildColumns(model, fkMap) {
  const lines = [];
  for (const [attrName, attr] of Object.entries(model.rawAttributes)) {
    if (attrName === 'createdAt' || attrName === 'updatedAt') continue;
    const column = attr.field || toSnake(attrName);
    const parts = [`type: ${serialize(attr.type)}`];

    const fk = fkMap[column];
    if (attr.primaryKey) {
      parts.push('primaryKey: true');
    }
    if (attr.defaultValue !== undefined) {
      if (attr.defaultValue && attr.defaultValue.constructor && attr.defaultValue.constructor.name === 'UUIDV4Wrapper') {
        parts.push('defaultValue: DataTypes.UUIDV4');
      } else if (attr.type.key === 'UUID' && String(attr.defaultValue).includes('UUIDV4')) {
        parts.push('defaultValue: DataTypes.UUIDV4');
      } else if (typeof attr.defaultValue === 'object' && attr.defaultValue !== null && !Array.isArray(attr.defaultValue) && Object.keys(attr.defaultValue).length === 0) {
        parts.push('defaultValue: {}');
      } else if (Array.isArray(attr.defaultValue)) {
        parts.push(`defaultValue: ${JSON.stringify(attr.defaultValue)}`);
      } else if (typeof attr.defaultValue === 'string' || typeof attr.defaultValue === 'number' || typeof attr.defaultValue === 'boolean') {
        parts.push(`defaultValue: ${JSON.stringify(attr.defaultValue)}`);
      } else if (attr.defaultValue && attr.defaultValue.constructor && attr.defaultValue.constructor.name.includes('NOW')) {
        parts.push('defaultValue: Sequelize.NOW');
      }
    }
    const allowNull = attr.primaryKey ? false : fk && fk.allowNull !== undefined ? fk.allowNull : attr.allowNull;
    parts.push(`allowNull: ${allowNull === false ? 'false' : 'true'}`);

    if (attr.unique === true) parts.push('unique: true');

    if (fk) {
      parts.push(`references: { model: '${fk.table}', key: '${fk.column || 'id'}' }`);
      parts.push(`onDelete: '${fk.onDelete}'`);
      parts.push(`onUpdate: 'CASCADE'`);
    }

    lines.push(`      ${attrName === 'id' ? 'id' : column}: {\n        ${parts.join(',\n        ')},\n      }`);
  }
  return lines.join(',\n');
}

function generate() {
  if (!fs.existsSync(MIGRATIONS_DIR)) fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });

  let n = 1;

  // 0: enable citext extension (required by User.email)
  fs.writeFileSync(
    path.join(MIGRATIONS_DIR, `${pad(n++)}-enable-extensions.js`),
    `'use strict';\n\nmodule.exports = {\n  up: async (queryInterface) => {\n    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS citext;');\n  },\n  down: async (queryInterface) => {\n    await queryInterface.sequelize.query('DROP EXTENSION IF EXISTS citext;');\n  },\n};\n`
  );

  for (const modelName of ORDER) {
    const model = db[modelName];
    if (!model) throw new Error(`Model not found for ORDER entry: ${modelName}`);
    const tableName = model.getTableName();
    const fkMap = FK[modelName] || {};
    const columns = buildColumns(model, fkMap);

    const indexLines = (model.options.indexes || [])
      .map((idx) => {
        const opts = { fields: idx.fields, unique: !!idx.unique };
        if (idx.where) {
          // `where` clauses referencing Sequelize.Op can't be trivially
          // serialized; those specific partial-unique indexes are added by
          // hand in the down-stream migration file after generation.
          return null;
        }
        return `    await queryInterface.addIndex('${tableName}', ${JSON.stringify(opts.fields)}, { unique: ${opts.unique}, name: '${tableName}_${idx.fields.join('_')}_idx' });`;
      })
      .filter(Boolean)
      .join('\n');

    const fileBody = `'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('${tableName}', {
${columns},
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }${model.options.timestamps === false ? '' : model.options.updatedAt === false ? '' : ',\n      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal(\'NOW()\') }'}
    });
${indexLines ? '\n' + indexLines : ''}
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('${tableName}');
  },
};
`;

    fs.writeFileSync(path.join(MIGRATIONS_DIR, `${pad(n++)}-create-${toSnake(tableName)}.js`), fileBody);
  }

  // Follow-up migrations for constraints that would otherwise be circular.
  const followUps = `'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addConstraint('orders', {
      fields: ['linked_from_order_id'],
      type: 'foreign key',
      name: 'orders_linked_from_order_id_fkey',
      references: { table: 'orders', field: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
    await queryInterface.addConstraint('websites', {
      fields: ['published_revision_id'],
      type: 'foreign key',
      name: 'websites_published_revision_id_fkey',
      references: { table: 'website_revisions', field: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
    await queryInterface.addConstraint('funnels', {
      fields: ['published_revision_id'],
      type: 'foreign key',
      name: 'funnels_published_revision_id_fkey',
      references: { table: 'website_revisions', field: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
    await queryInterface.addConstraint('refunds', {
      fields: ['credit_note_id'],
      type: 'foreign key',
      name: 'refunds_credit_note_id_fkey',
      references: { table: 'credit_notes', field: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
    await queryInterface.addConstraint('checkout_sessions', {
      fields: ['converted_order_id'],
      type: 'foreign key',
      name: 'checkout_sessions_converted_order_id_fkey',
      references: { table: 'orders', field: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });

    // Partial unique indexes (Sequelize model-level \`where\` clauses aren't
    // auto-generated above because they reference Sequelize.Op at runtime).
    await queryInterface.sequelize.query(
      'CREATE UNIQUE INDEX product_variants_workspace_sku_uidx ON product_variants (workspace_id, sku) WHERE sku IS NOT NULL;'
    );
    await queryInterface.sequelize.query(
      'CREATE UNIQUE INDEX analytics_events_workspace_dedupe_uidx ON analytics_events (workspace_id, dedupe_id) WHERE dedupe_id IS NOT NULL;'
    );
  },
  down: async (queryInterface) => {
    await queryInterface.removeConstraint('orders', 'orders_linked_from_order_id_fkey');
    await queryInterface.removeConstraint('websites', 'websites_published_revision_id_fkey');
    await queryInterface.removeConstraint('funnels', 'funnels_published_revision_id_fkey');
    await queryInterface.removeConstraint('refunds', 'refunds_credit_note_id_fkey');
    await queryInterface.removeConstraint('checkout_sessions', 'checkout_sessions_converted_order_id_fkey');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS product_variants_workspace_sku_uidx;');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS analytics_events_workspace_dedupe_uidx;');
  },
};
`;
  fs.writeFileSync(path.join(MIGRATIONS_DIR, `${pad(n++)}-deferred-constraints.js`), followUps);

  console.log(`Generated ${n - 1} migration files in ${MIGRATIONS_DIR}`);
}

generate();
