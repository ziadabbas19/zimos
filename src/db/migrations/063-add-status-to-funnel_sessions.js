'use strict';

/**
 * Give funnel sessions an explicit terminal state so "completed" is
 * distinguishable from "abandoned mid-funnel", plus a completed_at timestamp.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('funnel_sessions', 'status', {
      type: DataTypes.ENUM('active', 'completed', 'abandoned'),
      allowNull: false,
      defaultValue: 'active',
    });
    await queryInterface.addColumn('funnel_sessions', 'completed_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('funnel_sessions', 'completed_at');
    await queryInterface.removeColumn('funnel_sessions', 'status');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_funnel_sessions_status";');
  },
};
