'use strict';

module.exports = (sequelize, DataTypes) => {
  const ConfirmationAttempt = sequelize.define(
    'ConfirmationAttempt',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      taskId: { type: DataTypes.UUID, allowNull: false, field: 'task_id' },
      agentUserId: { type: DataTypes.UUID, allowNull: false, field: 'agent_user_id' },
      outcome: {
        type: DataTypes.ENUM('confirmed', 'rejected', 'unreachable', 'postponed'),
        allowNull: false,
      },
      notes: { type: DataTypes.STRING(1000), allowNull: true },
    },
    { tableName: 'confirmation_attempts', updatedAt: false, indexes: [{ fields: ['task_id'] }] }
  );
  ConfirmationAttempt.associate = (models) => {
    ConfirmationAttempt.belongsTo(models.ConfirmationTask, { foreignKey: 'taskId', as: 'task' });
  };
  return ConfirmationAttempt;
};
