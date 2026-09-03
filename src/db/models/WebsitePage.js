'use strict';

module.exports = (sequelize, DataTypes) => {
  // `builderData` is the canonical structured representation of the page
  // (a tree of sections/rows/columns/elements with responsive per-breakpoint
  // overrides) — never raw HTML. `draftData` holds unpublished edits;
  // `publishedData` is what a rollback restores and what the storefront
  // renders. See docs/PAGE_BUILDER_SCHEMA.md for the node shape.
  const WebsitePage = sequelize.define(
    'WebsitePage',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      websiteId: { type: DataTypes.UUID, allowNull: false, field: 'website_id' },
      path: { type: DataTypes.STRING(300), allowNull: false },
      title: { type: DataTypes.STRING(200), allowNull: false },
      pageType: { type: DataTypes.ENUM('home', 'product', 'collection', 'static', 'blog_post', 'cart', 'custom'), allowNull: false, defaultValue: 'custom', field: 'page_type' },
      draftData: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'draft_data' },
      publishedData: { type: DataTypes.JSONB, allowNull: true, field: 'published_data' },
      seo: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    },
    { tableName: 'website_pages', indexes: [{ unique: true, fields: ['website_id', 'path'] }] }
  );
  WebsitePage.associate = (models) => {
    WebsitePage.belongsTo(models.Website, { foreignKey: 'websiteId', as: 'website' });
    WebsitePage.hasMany(models.WebsitePageRedirect, { foreignKey: 'pageId', as: 'redirects' });
  };
  return WebsitePage;
};
