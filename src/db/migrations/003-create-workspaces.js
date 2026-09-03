'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('workspaces', {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      slug: {
        type: DataTypes.STRING(200),
        allowNull: false,
        unique: true,
      },
      owner_user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
      status: {
        type: DataTypes.ENUM('active', 'suspended', 'closed'),
        defaultValue: "active",
        allowNull: false,
      },
      default_currency: {
        type: DataTypes.STRING(3),
        defaultValue: "EGP",
        allowNull: false,
      },
      default_locale: {
        type: DataTypes.STRING(10),
        defaultValue: "ar-EG",
        allowNull: false,
      },
      timezone: {
        type: DataTypes.STRING(64),
        defaultValue: "Africa/Cairo",
        allowNull: false,
      },
      settings: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('workspaces', ["slug"], { unique: true, name: 'workspaces_slug_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('workspaces');
  },
};
