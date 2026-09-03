'use strict';

module.exports = (sequelize, DataTypes) => {
  const ProductCollection = sequelize.define(
    'ProductCollection',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      productId: { type: DataTypes.UUID, allowNull: false, field: 'product_id' },
      collectionId: { type: DataTypes.UUID, allowNull: false, field: 'collection_id' },
    },
    {
      tableName: 'product_collections',
      indexes: [{ unique: true, fields: ['product_id', 'collection_id'] }],
    }
  );
  return ProductCollection;
};
