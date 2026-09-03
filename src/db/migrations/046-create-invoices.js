'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('invoices', {
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
      order_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'orders', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
      invoice_number: {
        type: DataTypes.STRING(40),
        allowNull: false,
      },
      currency: {
        type: DataTypes.STRING(3),
        allowNull: false,
      },
      total_amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      line_items: {
        type: DataTypes.JSONB,
        defaultValue: [],
        allowNull: false,
      },
      issued_at: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('invoices', ["workspace_id","invoice_number"], { unique: true, name: 'invoices_workspace_id_invoice_number_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('invoices');
  },
};
