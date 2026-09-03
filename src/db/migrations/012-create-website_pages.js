'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('website_pages', {
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
        allowNull: false,
        references: { model: 'websites', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      path: {
        type: DataTypes.STRING(300),
        allowNull: false,
      },
      title: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      page_type: {
        type: DataTypes.ENUM('home', 'product', 'collection', 'static', 'blog_post', 'cart', 'custom'),
        defaultValue: "custom",
        allowNull: false,
      },
      draft_data: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      published_data: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      seo: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('website_pages', ["website_id","path"], { unique: true, name: 'website_pages_website_id_path_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('website_pages');
  },
};
