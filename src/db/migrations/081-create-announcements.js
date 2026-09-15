'use strict';

/**
 * Platform announcements shown as a banner in the merchant dashboard.
 *
 * `audience` picks who sees it: 'all', everyone on one plan ('plan' +
 * plan_id), or a single workspace ('workspace' + workspace_id). An
 * announcement is live between `starts_at` and `ends_at` (null = no end).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('announcements', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      title: { type: DataTypes.STRING(200), allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: false },
      severity: { type: DataTypes.ENUM('info', 'warning'), allowNull: false, defaultValue: 'info' },
      audience: { type: DataTypes.ENUM('all', 'plan', 'workspace'), allowNull: false, defaultValue: 'all' },
      // Both null unless `audience` narrows to one of them. A deleted plan or
      // workspace nulls the target, which the read path treats as 'no match'
      // rather than showing the banner to everyone.
      plan_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'plans', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      starts_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      ends_at: { type: DataTypes.DATE, allowNull: true },
      dismissible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_by_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });

    await queryInterface.addIndex('announcements', ['starts_at'], { name: 'announcements_starts_at_idx' });
    await queryInterface.addIndex('announcements', ['audience', 'plan_id', 'workspace_id'], {
      name: 'announcements_audience_targets_idx',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('announcements');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_announcements_severity";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_announcements_audience";');
  },
};
