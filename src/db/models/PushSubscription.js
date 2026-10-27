'use strict';

module.exports = (sequelize, DataTypes) => {
  // One browser subscribed to device notifications (modules/notifications/push,
  // migration 724). Bound to the sign-in session it was made under: a refresh
  // moves it to the session that replaces it, and it goes when that session
  // ends. `endpoint` is unique through its hash: one browser belongs to one
  // account at a time.
  const PushSubscription = sequelize.define(
    'PushSubscription',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
      sessionId: { type: DataTypes.UUID, allowNull: false, field: 'session_id' },
      app: { type: DataTypes.STRING(16), allowNull: false },
      endpoint: { type: DataTypes.TEXT, allowNull: false },
      endpointHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true, field: 'endpoint_hash' },
      p256dh: { type: DataTypes.STRING(200), allowNull: false },
      auth: { type: DataTypes.STRING(100), allowNull: false },
      pushService: { type: DataTypes.STRING(16), allowNull: false, field: 'push_service' },
      deviceLabel: { type: DataTypes.STRING(120), allowNull: true, field: 'device_label' },
      locale: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'ar' },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      failureCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'failure_count' },
      lastError: { type: DataTypes.STRING(200), allowNull: true, field: 'last_error' },
      lastSuccessAt: { type: DataTypes.DATE, allowNull: true, field: 'last_success_at' },
      lastFailureAt: { type: DataTypes.DATE, allowNull: true, field: 'last_failure_at' },
      lastSeenAt: { type: DataTypes.DATE, allowNull: false, field: 'last_seen_at' },
    },
    {
      tableName: 'push_subscriptions',
      indexes: [{ unique: true, fields: ['endpoint_hash'] }, { fields: ['user_id', 'app'] }, { fields: ['session_id'] }],
    }
  );
  PushSubscription.associate = (models) => {
    PushSubscription.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
    PushSubscription.belongsTo(models.Session, { foreignKey: 'sessionId', as: 'session' });
  };
  return PushSubscription;
};
