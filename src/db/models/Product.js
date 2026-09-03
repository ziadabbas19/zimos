'use strict';

module.exports = (sequelize, DataTypes) => {
  const Product = sequelize.define(
    'Product',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      websiteId: { type: DataTypes.UUID, allowNull: true, field: 'website_id' },
      name: { type: DataTypes.STRING(300), allowNull: false },
      slug: { type: DataTypes.STRING(300), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      productType: {
        type: DataTypes.ENUM('physical', 'digital', 'service'),
        allowNull: false,
        defaultValue: 'physical',
        field: 'product_type',
      },
      status: {
        type: DataTypes.ENUM('draft', 'active', 'archived'),
        allowNull: false,
        defaultValue: 'draft',
      },
      options: {
        // e.g. [{ name: 'Color', values: ['Red','Blue'] }, { name: 'Size', values: ['S','M'] }]
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
      },
      media: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      tags: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
      seo: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    },
    {
      tableName: 'products',
      indexes: [
        { unique: true, fields: ['workspace_id', 'slug'] },
        { fields: ['workspace_id', 'status'] },
      ],
    }
  );

  Product.associate = (models) => {
    Product.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Product.hasMany(models.ProductVariant, { foreignKey: 'productId', as: 'variants' });
    Product.hasMany(models.Offer, { foreignKey: 'productId', as: 'offers' });
    Product.belongsToMany(models.Collection, {
      through: models.ProductCollection,
      foreignKey: 'productId',
      otherKey: 'collectionId',
      as: 'collections',
    });
  };

  return Product;
};
