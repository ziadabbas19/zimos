'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('invoice_counters', {
      workspace_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      last_number: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      prefix: {
        type: DataTypes.STRING(20),
        defaultValue: "INV",
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('invoice_counters');
  },
};
