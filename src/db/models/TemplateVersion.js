'use strict';

module.exports = (sequelize, DataTypes) => {
  // A template version is the immutable "starting point" copied into a new
  // Website + WebsitePage rows when a merchant picks the template. Once
  // copied, the merchant's website has no live reference back to this row —
  // editing the template never touches merchant sites already created from it.
  const TemplateVersion = sequelize.define(
    'TemplateVersion',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      templateId: { type: DataTypes.UUID, allowNull: false, field: 'template_id' },
      version: { type: DataTypes.INTEGER, allowNull: false },
      globalStyles: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'global_styles' },
      pages: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // [{ path, title, builderData }]
      sections: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // reusable section library
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    },
    { tableName: 'template_versions', indexes: [{ unique: true, fields: ['template_id', 'version'] }] }
  );
  TemplateVersion.associate = (models) => {
    TemplateVersion.belongsTo(models.Template, { foreignKey: 'templateId', as: 'template' });
  };
  return TemplateVersion;
};
