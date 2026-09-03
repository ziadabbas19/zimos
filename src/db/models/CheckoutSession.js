'use strict';

module.exports = (sequelize, DataTypes) => {
  // Tracks a checkout in progress for abandoned-checkout detection/recovery.
  // Closed/converted the moment the linked order is successfully created.
  const CheckoutSession = sequelize.define(
    'CheckoutSession',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      cartId: { type: DataTypes.UUID, allowNull: false, field: 'cart_id' },
      visitorId: { type: DataTypes.STRING(64), allowNull: true, field: 'visitor_id' },
      contactFields: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'contact_fields' },
      attribution: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      status: {
        type: DataTypes.ENUM('in_progress', 'converted', 'abandoned'),
        allowNull: false,
        defaultValue: 'in_progress',
      },
      convertedOrderId: { type: DataTypes.UUID, allowNull: true, field: 'converted_order_id' },
      lastActivityAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'last_activity_at' },
    },
    { tableName: 'checkout_sessions', indexes: [{ fields: ['workspace_id', 'status'] }, { fields: ['cart_id'] }] }
  );
  return CheckoutSession;
};
