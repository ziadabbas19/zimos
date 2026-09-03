'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('products', {
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
      name: {
        type: DataTypes.STRING(300),
        allowNull: false,
      },
      slug: {
        type: DataTypes.STRING(300),
        allowNull: false,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      product_type: {
        type: DataTypes.ENUM('physical', 'digital', 'service'),
        defaultValue: "physical",
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('draft', 'active', 'archived'),
        defaultValue: "draft",
        allowNull: false,
      },
      options: {
        type: DataTypes.JSONB,
        defaultValue: [],
        allowNull: false,
      },
      media: {
        type: DataTypes.JSONB,
        defaultValue: [],
        allowNull: false,
      },
      tags: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: [],
        allowNull: false,
      },
      seo: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('products', ["workspace_id","slug"], { unique: true, name: 'products_workspace_id_slug_idx' });
    await queryInterface.addIndex('products', ["workspace_id","status"], { unique: false, name: 'products_workspace_id_status_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('products');
  },
};
