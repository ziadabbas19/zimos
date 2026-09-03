'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('carts', {
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
      website_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'websites', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      funnel_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'funnels', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      customer_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'customers', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      guest_token: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      currency: {
        type: DataTypes.STRING(3),
        defaultValue: "EGP",
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('active', 'converted', 'abandoned', 'merged'),
        defaultValue: "active",
        allowNull: false,
      },
      attribution: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('carts', ["workspace_id","guest_token"], { unique: false, name: 'carts_workspace_id_guest_token_idx' });
    await queryInterface.addIndex('carts', ["workspace_id","customer_id"], { unique: false, name: 'carts_workspace_id_customer_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('carts');
  },
};
