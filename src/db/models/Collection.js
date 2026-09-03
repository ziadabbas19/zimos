'use strict';

module.exports = (sequelize, DataTypes) => {
  const Collection = sequelize.define(
    'Collection',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(200), allowNull: false },
      slug: { type: DataTypes.STRING(200), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      rules: { type: DataTypes.JSONB, allowNull: true }, // smart-collection rules, null = manual collection
      seo: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    },
    {
      tableName: 'collections',
      indexes: [{ unique: true, fields: ['workspace_id', 'slug'] }],
    }
  );

  Collection.associate = (models) => {
    Collection.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Collection.belongsToMany(models.Product, {
      through: models.ProductCollection,
      foreignKey: 'collectionId',
      otherKey: 'productId',
      as: 'products',
    });
  };

  return Collection;
};
