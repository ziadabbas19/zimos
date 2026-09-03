'use strict';

module.exports = (sequelize, DataTypes) => {
  // A full immutable snapshot of a funnel's graph (funnel + steps + edges) at
  // publish time. Rollback is "make this revision the published one"; the
  // public runtime only ever reads the snapshot of `funnels.publishedRevisionId`,
  // never the draft steps/edges. `revisionNumber` is the stable per-funnel
  // sequence merchants see ("restore to revision 3"). Mirrors WebsiteRevision.
  const FunnelRevision = sequelize.define(
    'FunnelRevision',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      funnelId: { type: DataTypes.UUID, allowNull: false, field: 'funnel_id' },
      revisionNumber: { type: DataTypes.INTEGER, allowNull: false, field: 'revision_number' },
      snapshot: { type: DataTypes.JSONB, allowNull: false }, // { funnel, steps: [...], edges: [...] }
      publishedByUserId: { type: DataTypes.UUID, allowNull: false, field: 'published_by_user_id' },
      note: { type: DataTypes.STRING(300), allowNull: true },
    },
    {
      tableName: 'funnel_revisions',
      indexes: [
        { fields: ['funnel_id'] },
        { unique: true, fields: ['funnel_id', 'revision_number'] },
      ],
    }
  );
  FunnelRevision.associate = (models) => {
    FunnelRevision.belongsTo(models.Funnel, { foreignKey: 'funnelId', as: 'funnel' });
    FunnelRevision.belongsTo(models.User, { foreignKey: 'publishedByUserId', as: 'publishedBy' });
  };
  return FunnelRevision;
};
