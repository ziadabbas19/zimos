'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('billing_invoices', {
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
      subscription_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'subscriptions', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      currency: {
        type: DataTypes.STRING(3),
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('pending', 'paid', 'failed'),
        defaultValue: "pending",
        allowNull: false,
      },
      period_start: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      period_end: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      paid_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      failure_reason: {
        type: DataTypes.STRING(300),
        allowNull: true,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('billing_invoices', ["workspace_id"], { unique: false, name: 'billing_invoices_workspace_id_idx' });
    await queryInterface.addIndex('billing_invoices', ["subscription_id"], { unique: false, name: 'billing_invoices_subscription_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('billing_invoices');
  },
};
