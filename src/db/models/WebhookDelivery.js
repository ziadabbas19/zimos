'use strict';

module.exports = (sequelize, DataTypes) => {
  // `eventId` is a stable id derived from (event type, entity id, entity
  // version) so retried/replayed deliveries carry the same id — the
  // receiving side's idempotency handling (and our own retry logic) keys off
  // this rather than a fresh UUID per attempt, so a duplicate delivery of
  // the same underlying event is recognizable as a duplicate.
  const WebhookDelivery = sequelize.define(
    'WebhookDelivery',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      endpointId: { type: DataTypes.UUID, allowNull: false, field: 'endpoint_id' },
      eventId: { type: DataTypes.STRING(150), allowNull: false, field: 'event_id' },
      eventType: { type: DataTypes.STRING(100), allowNull: false, field: 'event_type' },
      payload: { type: DataTypes.JSONB, allowNull: false },
      status: { type: DataTypes.ENUM('pending', 'delivered', 'failed', 'exhausted'), allowNull: false, defaultValue: 'pending' },
      attemptCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'attempt_count' },
      nextAttemptAt: { type: DataTypes.DATE, allowNull: true, field: 'next_attempt_at' },
      lastResponseStatus: { type: DataTypes.INTEGER, allowNull: true, field: 'last_response_status' },
      lastError: { type: DataTypes.STRING(500), allowNull: true, field: 'last_error' },
    },
    {
      tableName: 'webhook_deliveries',
      indexes: [{ fields: ['endpoint_id'] }, { unique: true, fields: ['endpoint_id', 'event_id'] }],
    }
  );
  WebhookDelivery.associate = (models) => {
    WebhookDelivery.belongsTo(models.WebhookEndpoint, { foreignKey: 'endpointId', as: 'endpoint' });
  };
  return WebhookDelivery;
};
