'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('notification_logs', {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        allowNull: false,
      },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      channel: {
        type: DataTypes.ENUM('email', 'sms', 'whatsapp'),
        allowNull: false,
      },
      provider: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
      recipient: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      template: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('sent', 'failed'),
        allowNull: false,
      },
      error: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('notification_logs');
  },
};
