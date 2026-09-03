'use strict';

module.exports = (sequelize, DataTypes) => {
  const Funnel = sequelize.define(
    'Funnel',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(200), allowNull: false },
      subdomain: { type: DataTypes.STRING(100), allowNull: true, unique: true },
      status: { type: DataTypes.ENUM('draft', 'published', 'paused'), allowNull: false, defaultValue: 'draft' },
      publishedRevisionId: { type: DataTypes.UUID, allowNull: true, field: 'published_revision_id' },
    },
    { tableName: 'funnels', indexes: [{ fields: ['workspace_id'] }] }
  );
  Funnel.associate = (models) => {
    Funnel.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Funnel.hasMany(models.FunnelStep, { foreignKey: 'funnelId', as: 'steps' });
    Funnel.hasMany(models.FunnelEdge, { foreignKey: 'funnelId', as: 'edges' });
    Funnel.hasMany(models.FunnelRevision, { foreignKey: 'funnelId', as: 'revisions' });
  };
  return Funnel;
};
