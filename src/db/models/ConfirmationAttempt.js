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
      // Where the outcome was recorded: a queue call, the order page (Confirm /
      // Cancel order), or a correction of an earlier outcome.
      source: {
        type: DataTypes.ENUM('queue', 'order_page', 'correction'),
        allowNull: false,
        defaultValue: 'queue',
      },
      // On a correction, the outcome it replaced.
      previousOutcome: {
        type: DataTypes.ENUM('confirmed', 'rejected', 'unreachable', 'postponed'),
        allowNull: true,
        field: 'previous_outcome',
      },
    },
    { tableName: 'confirmation_attempts', updatedAt: false, indexes: [{ fields: ['task_id', 'created_at'] }] }
  );
  ConfirmationAttempt.associate = (models) => {
    ConfirmationAttempt.belongsTo(models.ConfirmationTask, { foreignKey: 'taskId', as: 'task' });
    ConfirmationAttempt.belongsTo(models.User, { foreignKey: 'agentUserId', as: 'agent' });
  };
  return ConfirmationAttempt;
};
