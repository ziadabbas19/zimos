'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('experiment_assignments', {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        allowNull: false,
      },
      experiment_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'experiments', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      visitor_id: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      variant_key: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
      order_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'orders', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('experiment_assignments', ["experiment_id","visitor_id"], { unique: true, name: 'experiment_assignments_experiment_id_visitor_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('experiment_assignments');
  },
};
