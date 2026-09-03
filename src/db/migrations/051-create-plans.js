'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('plans', {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        allowNull: false,
      },
      key: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: true,
      },
      name: {
        type: DataTypes.STRING(150),
        allowNull: false,
      },
      monthly_price_amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      yearly_price_amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      currency: {
        type: DataTypes.STRING(3),
        defaultValue: "USD",
        allowNull: false,
      },
      trial_days: {
        type: DataTypes.INTEGER,
        defaultValue: 14,
        allowNull: false,
      },
      soft_order_quota: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      features: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('plans');
  },
};
