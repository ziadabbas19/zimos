'use strict';

/**
 * A record of every uploaded file, so the builder can offer a media library
 * instead of asking the merchant to remember URLs. Until now an upload wrote
 * the object to storage (local disk or R2) and returned its URL; nothing in
 * the database knew it existed, which made listing and deleting impossible.
 *
 * `path` is the storage key the backend deletes by (/uploads/<ws>/<file> on
 * local disk, /<ws>/<file> in the bucket); `url` is the public address the
 * page trees embed. Both are stored because the mapping between them is the
 * storage backend's business, and a workspace's older files can predate a
 * provider switch.
 *
 * uploaded_by_user_id is ON DELETE SET NULL: the file outlives the staff
 * member who uploaded it, and a live storefront must not lose an image
 * because someone left the team.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('media_assets', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      uploaded_by_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      url: { type: DataTypes.STRING(1000), allowNull: false },
      path: { type: DataTypes.STRING(1000), allowNull: false },
      mime_type: { type: DataTypes.STRING(100), allowNull: false },
      size_bytes: { type: DataTypes.INTEGER, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });

    // The library lists one workspace's files newest-first; `id` is the
    // tie-breaker the cursor pages on, so two files uploaded in the same
    // millisecond still have a stable order.
    await queryInterface.addIndex('media_assets', [{ name: 'workspace_id' }, { name: 'created_at', order: 'DESC' }, { name: 'id' }], {
      name: 'media_assets_workspace_created_idx',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('media_assets');
  },
};
