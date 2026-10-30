'use strict';

module.exports = (sequelize, DataTypes) => {
  // A product or store review. A shopper's review waits (`pending`) until the
  // merchant publishes it; one per phone and per device for the same product,
  // or for the store. See modules/reviews/reviewService.js.
  const Review = sequelize.define(
    'Review',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      // 'product' or 'store' (migration 729); a store review has no product.
      kind: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'product', validate: { isIn: [['product', 'store']] } },
      productId: { type: DataTypes.UUID, allowNull: true, field: 'product_id' },
      // Null for a review the merchant added by hand (migration 146, reviews/manualReviews.js)
      // and for a reviewer who never ordered from the store.
      customerId: { type: DataTypes.UUID, allowNull: true, field: 'customer_id' },
      authorName: { type: DataTypes.STRING(120), allowNull: true, field: 'author_name' },
      // Links a merchant typed in for a manual review; a shopper's photos are photoUploadIds.
      photos: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      photoUploadIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [], field: 'photo_upload_ids' },
      // 'customer' (sent from the storefront), 'manual' or 'import' (added by the merchant),
      // or 'external' (brought by the merchant from another site, migration 731).
      source: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'customer' },
      // An external review's site: facebook | google | instagram | whatsapp | other (+ its typed name).
      externalSource: { type: DataTypes.STRING(20), allowNull: true, field: 'external_source' },
      externalSourceLabel: { type: DataTypes.STRING(60), allowNull: true, field: 'external_source_label' },
      externalUrl: { type: DataTypes.STRING(1000), allowNull: true, field: 'external_url' },
      // The day it was written there (optional).
      reviewedAt: { type: DataTypes.DATEONLY, allowNull: true, field: 'reviewed_at' },
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      rating: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 5 } },
      comment: { type: DataTypes.TEXT, allowNull: true },
      // pending = waiting for the merchant, approved = published, rejected = hidden.
      status: {
        type: DataTypes.ENUM('pending', 'approved', 'rejected'),
        allowNull: false,
        defaultValue: 'pending',
      },
      // false: published as stars only, the text and photos stay in the dashboard.
      showText: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'show_text' },
      phoneNormalized: { type: DataTypes.STRING(32), allowNull: true, field: 'phone_normalized' },
      deviceId: { type: DataTypes.STRING(128), allowNull: true, field: 'device_id' },
      requestIp: { type: DataTypes.STRING(45), allowNull: true, field: 'request_ip' },
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
