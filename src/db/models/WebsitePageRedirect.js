'use strict';

module.exports = (sequelize, DataTypes) => {
  // A permanent (301) redirect from an old published page path to its current
  // one. Created automatically whenever a *published* page's path changes so
  // the old URL keeps working instead of 404ing. Purely additive — never
  // deleted by a path change, only repointed, so redirect chains collapse to
  // a single hop.
  const WebsitePageRedirect = sequelize.define(
    'WebsitePageRedirect',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      websiteId: { type: DataTypes.UUID, allowNull: false, field: 'website_id' },
      pageId: { type: DataTypes.UUID, allowNull: true, field: 'page_id' },
      fromPath: { type: DataTypes.STRING(300), allowNull: false, field: 'from_path' },
      toPath: { type: DataTypes.STRING(300), allowNull: false, field: 'to_path' },
      statusCode: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 301, field: 'status_code' },
    },
    {
      tableName: 'website_page_redirects',
      indexes: [
        { unique: true, fields: ['website_id', 'from_path'] },
        { fields: ['workspace_id'] },
      ],
    }
  );
  WebsitePageRedirect.associate = (models) => {
    WebsitePageRedirect.belongsTo(models.Website, { foreignKey: 'websiteId', as: 'website' });
    WebsitePageRedirect.belongsTo(models.WebsitePage, { foreignKey: 'pageId', as: 'page' });
  };
  return WebsitePageRedirect;
};
