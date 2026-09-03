'use strict';

module.exports = (sequelize, DataTypes) => {
  const Website = sequelize.define(
    'Website',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      sourceTemplateVersionId: { type: DataTypes.UUID, allowNull: true, field: 'source_template_version_id' },
      name: { type: DataTypes.STRING(200), allowNull: false },
      subdomain: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      status: { type: DataTypes.ENUM('draft', 'published', 'suspended'), allowNull: false, defaultValue: 'draft' },
      globalStyles: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'global_styles' },
      seo: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      publishedRevisionId: { type: DataTypes.UUID, allowNull: true, field: 'published_revision_id' },
    },
    { tableName: 'websites', indexes: [{ fields: ['workspace_id'] }, { unique: true, fields: ['subdomain'] }] }
  );
  Website.associate = (models) => {
    Website.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Website.hasMany(models.WebsitePage, { foreignKey: 'websiteId', as: 'pages' });
    Website.hasMany(models.WebsiteRevision, { foreignKey: 'websiteId', as: 'revisions' });
    Website.hasMany(models.WebsitePageRedirect, { foreignKey: 'websiteId', as: 'redirects' });
    Website.hasMany(models.Domain, { foreignKey: 'websiteId', as: 'domains' });
  };
  return Website;
};
