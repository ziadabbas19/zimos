'use strict';

module.exports = (sequelize, DataTypes) => {
  const NotificationLog = sequelize.define(
    'NotificationLog',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: true, field: 'workspace_id' },
      channel: { type: DataTypes.ENUM('email', 'sms', 'whatsapp'), allowNull: false },
      provider: { type: DataTypes.STRING(50), allowNull: false },
      recipient: { type: DataTypes.STRING(255), allowNull: false },
      template: { type: DataTypes.STRING(100), allowNull: false },
      status: { type: DataTypes.ENUM('sent', 'failed'), allowNull: false },
      error: { type: DataTypes.STRING(500), allowNull: true },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    },
    { tableName: 'notification_logs', updatedAt: false }
  );
  return NotificationLog;
};
