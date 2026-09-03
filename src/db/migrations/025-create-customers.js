'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('customers', {
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
      phone_normalized: {
        type: DataTypes.STRING(32),
        allowNull: false,
      },
      phone_raw: {
        type: DataTypes.STRING(32),
        allowNull: true,
      },
      alternate_phone: {
        type: DataTypes.STRING(32),
        allowNull: true,
      },
      email: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      full_name: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      marketing_consent: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      is_blacklisted: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      blacklist_reason: {
        type: DataTypes.STRING(300),
        allowNull: true,
      },
      segments: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: [],
        allowNull: false,
      },
      reliability_score: {
        type: DataTypes.INTEGER,
        defaultValue: 100,
        allowNull: false,
      },
      total_orders: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      total_rejected_orders: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('customers', ["workspace_id","phone_normalized"], { unique: true, name: 'customers_workspace_id_phone_normalized_idx' });
    await queryInterface.addIndex('customers', ["workspace_id","is_blacklisted"], { unique: false, name: 'customers_workspace_id_is_blacklisted_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('customers');
  },
};
