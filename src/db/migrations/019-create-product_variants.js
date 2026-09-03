'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('product_variants', {
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
      product_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'products', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      sku: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      barcode: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      option_values: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      price_amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      compare_at_amount: {
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      cost_amount: {
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      currency: {
        type: DataTypes.STRING(3),
        defaultValue: "EGP",
        allowNull: false,
      },
      stock_on_hand: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      reserved_stock: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      allow_overselling: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      weight_grams: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      dimensions: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('active', 'archived'),
        defaultValue: "active",
        allowNull: false,
      },
      version: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('product_variants', ["workspace_id"], { unique: false, name: 'product_variants_workspace_id_idx' });
    await queryInterface.addIndex('product_variants', ["product_id"], { unique: false, name: 'product_variants_product_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('product_variants');
  },
};
