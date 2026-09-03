'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('shipping_rates', {
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
      zone_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'shipping_zones', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      name: {
        type: DataTypes.STRING(150),
        allowNull: false,
      },
      rate_type: {
        type: DataTypes.ENUM('flat', 'weight_based', 'quantity_based', 'order_value_based', 'free'),
        allowNull: false,
      },
      config: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      carrier_code: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('shipping_rates', ["zone_id"], { unique: false, name: 'shipping_rates_zone_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('shipping_rates');
  },
};
