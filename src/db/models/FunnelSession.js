'use strict';

module.exports = (sequelize, DataTypes) => {
  const FunnelSession = sequelize.define(
    'FunnelSession',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      funnelId: { type: DataTypes.UUID, allowNull: false, field: 'funnel_id' },
      visitorId: { type: DataTypes.STRING(64), allowNull: false, field: 'visitor_id' },
      currentStepKey: { type: DataTypes.STRING(100), allowNull: true, field: 'current_step_key' },
      path: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      attribution: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      status: {
        type: DataTypes.ENUM('active', 'completed', 'abandoned'),
        allowNull: false,
        defaultValue: 'active',
      },
      completedAt: { type: DataTypes.DATE, allowNull: true, field: 'completed_at' },
    },
    { tableName: 'funnel_sessions', indexes: [{ fields: ['funnel_id', 'visitor_id'] }] }
  );
  FunnelSession.associate = (models) => {
    FunnelSession.belongsTo(models.Funnel, { foreignKey: 'funnelId', as: 'funnel' });
    FunnelSession.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };
  return FunnelSession;
};
