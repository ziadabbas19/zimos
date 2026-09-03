'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('orders', {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        allowNull: false,
      },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      website_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'websites', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      funnel_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'funnels', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      customer_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'customers', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
      order_number: {
        type: DataTypes.STRING(40),
        allowNull: false,
      },
      confirmation_state: {
        type: DataTypes.ENUM('pending', 'confirmed', 'rejected', 'unreachable', 'postponed'),
        defaultValue: "pending",
        allowNull: false,
      },
      financial_state: {
        type: DataTypes.ENUM('pending', 'partially_paid', 'paid', 'failed', 'refunded', 'partially_refunded'),
        defaultValue: "pending",
        allowNull: false,
      },
      fulfillment_state: {
        type: DataTypes.ENUM('unfulfilled', 'partially_fulfilled', 'fulfilled', 'returned'),
        defaultValue: "unfulfilled",
        allowNull: false,
      },
      payment_method: {
        type: DataTypes.ENUM('cod', 'card', 'wallet', 'bank_transfer'),
        allowNull: false,
      },
      currency: {
        type: DataTypes.STRING(3),
        allowNull: false,
      },
      subtotal_amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      discount_amount: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        allowNull: false,
      },
      shipping_amount: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        allowNull: false,
      },
      tax_amount: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        allowNull: false,
      },
      total_amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      amount_paid: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        allowNull: false,
      },
      amount_refunded: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        allowNull: false,
      },
      contact_snapshot: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      shipping_address_snapshot: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      discounts_snapshot: {
        type: DataTypes.JSONB,
        defaultValue: [],
        allowNull: false,
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      risk_flags: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: [],
        allowNull: false,
      },
      idempotency_key: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      linked_from_order_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('orders', ["workspace_id","order_number"], { unique: true, name: 'orders_workspace_id_order_number_idx' });
    await queryInterface.addIndex('orders', ["workspace_id","idempotency_key"], { unique: true, name: 'orders_workspace_id_idempotency_key_idx' });
    await queryInterface.addIndex('orders', ["workspace_id","customer_id"], { unique: false, name: 'orders_workspace_id_customer_id_idx' });
    await queryInterface.addIndex('orders', ["workspace_id","confirmation_state"], { unique: false, name: 'orders_workspace_id_confirmation_state_idx' });
    await queryInterface.addIndex('orders', ["workspace_id","financial_state"], { unique: false, name: 'orders_workspace_id_financial_state_idx' });
    await queryInterface.addIndex('orders', ["workspace_id","fulfillment_state"], { unique: false, name: 'orders_workspace_id_fulfillment_state_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('orders');
  },
};
