'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('shipments', {
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
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      carrier_code: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      waybill_number: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('created', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned', 'cancelled'),
        defaultValue: "created",
        allowNull: false,
      },
      tracking_url: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      carrier_response: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      shipped_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      delivered_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('shipments', ["workspace_id"], { unique: false, name: 'shipments_workspace_id_idx' });
    await queryInterface.addIndex('shipments', ["order_id"], { unique: false, name: 'shipments_order_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('shipments');
  },
};
