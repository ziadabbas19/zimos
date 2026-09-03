'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('cart_items', {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        allowNull: false,
      },
      cart_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'carts', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      offer_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'offers', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      variant_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'product_variants', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
      quantity: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
        allowNull: false,
      },
      unit_price_snapshot: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      is_order_bump: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('cart_items', ["cart_id"], { unique: false, name: 'cart_items_cart_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('cart_items');
  },
};
