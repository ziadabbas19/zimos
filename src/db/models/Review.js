'use strict';

module.exports = (sequelize, DataTypes) => {
  // One row per (workspace, product, customer). A resubmission updates the
  // same row and drops it back to `pending`. See modules/reviews/reviewService.js.
  const Review = sequelize.define(
    'Review',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      productId: { type: DataTypes.UUID, allowNull: false, field: 'product_id' },
      customerId: { type: DataTypes.UUID, allowNull: false, field: 'customer_id' },
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      rating: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 5 } },
      comment: { type: DataTypes.TEXT, allowNull: true },
      status: {
        type: DataTypes.ENUM('pending', 'approved', 'rejected'),
        allowNull: false,
        defaultValue: 'pending',
      },
    },
    {
      tableName: 'reviews',
      indexes: [
        { unique: true, fields: ['workspace_id', 'product_id', 'customer_id'] },
        { fields: ['workspace_id', 'product_id', 'status'] },
        { fields: ['workspace_id', 'status'] },
      ],
    }
  );

  Review.associate = (models) => {
    Review.belongsTo(models.Product, { foreignKey: 'productId', as: 'product' });
    Review.belongsTo(models.Customer, { foreignKey: 'customerId', as: 'customer' });
    Review.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };

  return Review;
};
