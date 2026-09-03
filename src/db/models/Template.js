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
    },
    { tableName: 'templates' }
  );
  Template.associate = (models) => {
    Template.hasMany(models.TemplateVersion, { foreignKey: 'templateId', as: 'versions' });
  };
  return Template;
};
