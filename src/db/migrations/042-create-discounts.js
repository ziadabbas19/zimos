'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('discounts', {
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
      code: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      type: {
        type: DataTypes.ENUM('percentage', 'fixed', 'free_shipping', 'buy_x_get_y'),
        allowNull: false,
      },
      value: {
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      buy_x_get_y_config: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      minimum_subtotal: {
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      product_restrictions: {
        type: DataTypes.ARRAY(DataTypes.UUID),
        defaultValue: [],
        allowNull: false,
      },
      collection_restrictions: {
        type: DataTypes.ARRAY(DataTypes.UUID),
        defaultValue: [],
        allowNull: false,
      },
      customer_restrictions: {
        type: DataTypes.ARRAY(DataTypes.UUID),
        defaultValue: [],
        allowNull: false,
      },
      funnel_restrictions: {
        type: DataTypes.ARRAY(DataTypes.UUID),
        defaultValue: [],
        allowNull: false,
      },
      starts_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      ends_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      usage_limit: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      per_customer_limit: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      usage_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      stackable: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('active', 'disabled'),
        defaultValue: "active",
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('discounts', ["workspace_id","code"], { unique: true, name: 'discounts_workspace_id_code_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('discounts');
  },
};
