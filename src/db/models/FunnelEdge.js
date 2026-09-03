'use strict';

module.exports = (sequelize, DataTypes) => {
  // Funnels are a graph, not a linear array: an edge routes from one step to
  // another, optionally gated by a condition (e.g. "if order bump accepted").
  const FunnelEdge = sequelize.define(
    'FunnelEdge',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      funnelId: { type: DataTypes.UUID, allowNull: false, field: 'funnel_id' },
      fromStepKey: { type: DataTypes.STRING(100), allowNull: false, field: 'from_step_key' },
      toStepKey: { type: DataTypes.STRING(100), allowNull: false, field: 'to_step_key' },
      condition: { type: DataTypes.JSONB, allowNull: true }, // e.g. { type: 'accepted_upsell' } | { type: 'always' }
      priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'funnel_edges', indexes: [{ fields: ['funnel_id', 'from_step_key'] }] }
  );
  FunnelEdge.associate = (models) => {
    FunnelEdge.belongsTo(models.Funnel, { foreignKey: 'funnelId', as: 'funnel' });
  };
  return FunnelEdge;
};
