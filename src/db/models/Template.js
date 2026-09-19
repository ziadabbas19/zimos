'use strict';

module.exports = (sequelize, DataTypes) => {
  const Template = sequelize.define(
    'Template',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING(200), allowNull: false },
      category: { type: DataTypes.STRING(100), allowNull: true },
      thumbnailUrl: { type: DataTypes.STRING(500), allowNull: true, field: 'thumbnail_url' },
      isPublished: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_published' },
      // --- gallery card fields (see migration 084) ---
      kind: { type: DataTypes.ENUM('store', 'funnel', 'landing'), allowNull: false, defaultValue: 'store' },
      priceAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'price_amount' },
      // Stored, not derived from priceAmount, so a paid template can be given
      // away without losing its list price.
      isFree: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_free' },
      // Denormalized from the active version's globalStyles.primaryColor so
      // the grid can paint a swatch without loading every version.
      primaryColor: { type: DataTypes.STRING(20), allowNull: true, field: 'primary_color' },
      tags: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
      rtl: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    { tableName: 'templates' }
  );
  Template.associate = (models) => {
    Template.hasMany(models.TemplateVersion, { foreignKey: 'templateId', as: 'versions' });
  };
  return Template;
};
