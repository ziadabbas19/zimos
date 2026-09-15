'use strict';

module.exports = (sequelize, DataTypes) => {
  const Announcement = sequelize.define(
    'Announcement',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      title: { type: DataTypes.STRING(200), allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: false },
      severity: { type: DataTypes.ENUM('info', 'warning'), allowNull: false, defaultValue: 'info' },
      audience: { type: DataTypes.ENUM('all', 'plan', 'workspace'), allowNull: false, defaultValue: 'all' },
      planId: { type: DataTypes.UUID, allowNull: true, field: 'plan_id' },
      workspaceId: { type: DataTypes.UUID, allowNull: true, field: 'workspace_id' },
      startsAt: { type: DataTypes.DATE, allowNull: false, field: 'starts_at' },
      endsAt: { type: DataTypes.DATE, allowNull: true, field: 'ends_at' },
      dismissible: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdByUserId: { type: DataTypes.UUID, allowNull: true, field: 'created_by_user_id' },
    },
    { tableName: 'announcements' }
  );
  Announcement.associate = (models) => {
    Announcement.belongsTo(models.Plan, { foreignKey: 'planId', as: 'plan' });
    Announcement.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Announcement.belongsTo(models.User, { foreignKey: 'createdByUserId', as: 'createdBy' });
  };
  return Announcement;
};
