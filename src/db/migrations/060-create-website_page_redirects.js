'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('website_page_redirects', {
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
      // The page a `from_path` request should be redirected to. Nullable +
      // SET NULL so deleting the target page never leaves an orphaned FK; the
      // redirect still resolves by `to_path` string.
      page_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'website_pages', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      from_path: {
        type: DataTypes.STRING(300),
        allowNull: false,
      },
      to_path: {
        type: DataTypes.STRING(300),
        allowNull: false,
      },
      status_code: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 301,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });

    await queryInterface.addIndex('website_page_redirects', ['website_id', 'from_path'], {
      unique: true,
      name: 'website_page_redirects_website_id_from_path_uidx',
    });
    await queryInterface.addIndex('website_page_redirects', ['workspace_id'], {
      unique: false,
      name: 'website_page_redirects_workspace_id_idx',
    });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('website_page_redirects');
  },
};
