'use strict';

module.exports = (sequelize, DataTypes) => {
  // `lockedByUserId` + `lockedAt` implement pessimistic task locking so two
  // confirmation agents can never work the same order simultaneously — see
  // modules/cod/confirmationService.js#claimTask, which claims via a
  // conditional UPDATE ... WHERE locked_by_user_id IS NULL inside a
  // transaction (0 rows updated = someone else got there first).
  const ConfirmationTask = sequelize.define(
    'ConfirmationTask',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      status: {
        type: DataTypes.ENUM('queued', 'in_progress', 'done'),
        allowNull: false,
        defaultValue: 'queued',
      },
      lockedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'locked_by_user_id' },
      lockedAt: { type: DataTypes.DATE, allowNull: true, field: 'locked_at' },
      attemptCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'attempt_count' },
      nextRetryAt: { type: DataTypes.DATE, allowNull: true, field: 'next_retry_at' },
      outcome: {
        type: DataTypes.ENUM('confirmed', 'rejected', 'unreachable', 'postponed'),
        allowNull: true,
      },
      rejectionReason: { type: DataTypes.STRING(300), allowNull: true, field: 'rejection_reason' },
    },
    { tableName: 'confirmation_tasks', indexes: [{ fields: ['workspace_id', 'status'] }, { fields: ['order_id'] }] }
  );
  ConfirmationTask.associate = (models) => {
    ConfirmationTask.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
    ConfirmationTask.hasMany(models.ConfirmationAttempt, { foreignKey: 'taskId', as: 'attempts' });
  };
  return ConfirmationTask;
};
