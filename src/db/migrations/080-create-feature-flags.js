'use strict';

/**
 * Platform-wide feature flags, owned by platform admins (not by a workspace).
 *
 * A flag is on for a workspace when `enabled` is true AND either the workspace
 * is named in `target_workspace_ids` or it falls inside the `rollout`
 * percentage. `rollout` is 0-100; 100 means everyone.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('feature_flags', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      key: { type: DataTypes.STRING(120), allowNull: false, unique: true },
      description: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      rollout: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      // Workspace ids are kept as a plain JSONB array rather than a join table:
      // the list is short, only ever read whole, and a deleted workspace here
      // is harmless (it simply stops matching).
      target_workspace_ids: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });

    await queryInterface.addIndex('feature_flags', ['key'], {
      unique: true,
      name: 'feature_flags_key_uidx',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('feature_flags');
  },
};
