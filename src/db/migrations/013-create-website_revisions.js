'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('website_revisions', {
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
      snapshot: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      published_by_user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
      note: {
        type: DataTypes.STRING(300),
        allowNull: true,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('website_revisions', ["website_id"], { unique: false, name: 'website_revisions_website_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('website_revisions');
  },
};
