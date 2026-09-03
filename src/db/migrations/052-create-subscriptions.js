'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('subscriptions', {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        allowNull: false,
      },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        unique: true,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      plan_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'plans', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
      billing_cycle: {
        type: DataTypes.ENUM('monthly', 'yearly'),
        defaultValue: "monthly",
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('trialing', 'active', 'past_due', 'suspended', 'cancelled'),
        defaultValue: "trialing",
        allowNull: false,
      },
      trial_ends_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      current_period_start: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      current_period_end: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      grace_until: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      cancel_at_period_end: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('subscriptions', ["workspace_id"], { unique: true, name: 'subscriptions_workspace_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('subscriptions');
  },
};
