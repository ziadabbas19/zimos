'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('websites', {
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
      source_template_version_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'template_versions', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      subdomain: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true,
      },
      status: {
        type: DataTypes.ENUM('draft', 'published', 'suspended'),
        defaultValue: "draft",
        allowNull: false,
      },
      global_styles: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      seo: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      published_revision_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('websites', ["workspace_id"], { unique: false, name: 'websites_workspace_id_idx' });
    await queryInterface.addIndex('websites', ["subdomain"], { unique: true, name: 'websites_subdomain_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('websites');
  },
};
