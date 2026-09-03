'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('offers', {
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
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      pricing_mode: {
        type: DataTypes.ENUM('fixed', 'computed'),
        defaultValue: "fixed",
        allowNull: false,
      },
      price_amount: {
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      currency: {
        type: DataTypes.STRING(3),
        defaultValue: "EGP",
        allowNull: false,
      },
      badge: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      is_default: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      shipping_override: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('active', 'archived'),
        defaultValue: "active",
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('offers', ["workspace_id"], { unique: false, name: 'offers_workspace_id_idx' });
    await queryInterface.addIndex('offers', ["product_id"], { unique: false, name: 'offers_product_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('offers');
  },
};
