'use strict';

module.exports = (sequelize, DataTypes) => {
  // A full immutable snapshot of every page's builderData at the moment of
  // publish, so rollback is just "make this revision the published one"
  // without touching historical commerce data. `revisionNumber` is the
  // stable per-website sequence merchants see ("restore to revision 3").
  const WebsiteRevision = sequelize.define(
    'WebsiteRevision',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      websiteId: { type: DataTypes.UUID, allowNull: false, field: 'website_id' },
      revisionNumber: { type: DataTypes.INTEGER, allowNull: false, field: 'revision_number' },
      snapshot: { type: DataTypes.JSONB, allowNull: false }, // { pages: [...], globalStyles, seo }
      publishedByUserId: { type: DataTypes.UUID, allowNull: false, field: 'published_by_user_id' },
      note: { type: DataTypes.STRING(300), allowNull: true },
    },
    {
      tableName: 'website_revisions',
      indexes: [
        { fields: ['website_id'] },
        { unique: true, fields: ['website_id', 'revision_number'] },
      ],
    }
  );
  WebsiteRevision.associate = (models) => {
    WebsiteRevision.belongsTo(models.Website, { foreignKey: 'websiteId', as: 'website' });
    WebsiteRevision.belongsTo(models.User, { foreignKey: 'publishedByUserId', as: 'publishedBy' });
  };
  return WebsiteRevision;
};
