'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('order_items', {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        allowNull: false,
      },
      order_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'orders', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      product_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      variant_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      offer_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      product_name_snapshot: {
        type: DataTypes.STRING(300),
        allowNull: false,
      },
      variant_options_snapshot: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      sku_snapshot: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      offer_name_snapshot: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      unit_price_amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      unit_cost_amount: {
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      line_discount_amount: {
        type: DataTypes.BIGINT,
        defaultValue: 0,
        allowNull: false,
      },
      line_total_amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      is_order_bump: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      is_upsell: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('order_items', ["order_id"], { unique: false, name: 'order_items_order_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('order_items');
  },
};
