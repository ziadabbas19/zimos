'use strict';

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

    // Partial unique indexes (Sequelize model-level `where` clauses aren't
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
