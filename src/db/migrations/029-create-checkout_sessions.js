'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('checkout_sessions', {
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
      cart_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'carts', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      visitor_id: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      contact_fields: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      attribution: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('in_progress', 'converted', 'abandoned'),
        defaultValue: "in_progress",
        allowNull: false,
      },
      converted_order_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      last_activity_at: {
        type: DataTypes.DATE,
        defaultValue: {},
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('checkout_sessions', ["workspace_id","status"], { unique: false, name: 'checkout_sessions_workspace_id_status_idx' });
    await queryInterface.addIndex('checkout_sessions', ["cart_id"], { unique: false, name: 'checkout_sessions_cart_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('checkout_sessions');
  },
};
