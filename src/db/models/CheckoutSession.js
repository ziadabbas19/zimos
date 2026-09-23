'use strict';

module.exports = (sequelize, DataTypes) => {
  // A checkout a shopper has started filling in, autosaved from the storefront
  // (see modules/checkoutSessions). Converted when an order lands; "abandoned"
  // is derived at read time, never stored — see checkoutSessionStatus.js.
  const CheckoutSession = sequelize.define(
    'CheckoutSession',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      cartId: { type: DataTypes.UUID, allowNull: true, field: 'cart_id' },
      visitorId: { type: DataTypes.STRING(64), allowNull: true, field: 'visitor_id' },
      contactFields: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'contact_fields' },
      phoneNormalized: { type: DataTypes.STRING(32), allowNull: false, field: 'phone_normalized' },
      items: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      subtotalAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'subtotal_amount' },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'EGP' },
      source: { type: DataTypes.ENUM('store', 'funnel'), allowNull: false, defaultValue: 'store' },
      attribution: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      // 'abandoned' stays in the type for compatibility but is never written.
      status: {
        type: DataTypes.ENUM('in_progress', 'converted', 'abandoned'),
        allowNull: false,
        defaultValue: 'in_progress',
      },
      recoveryStatus: {
        type: DataTypes.ENUM('not_contacted', 'contacted', 'recovered', 'lost'),
        allowNull: false,
        defaultValue: 'not_contacted',
        field: 'recovery_status',
      },
      contactedAt: { type: DataTypes.DATE, allowNull: true, field: 'contacted_at' },
      convertedOrderId: { type: DataTypes.UUID, allowNull: true, field: 'converted_order_id' },
      lastActivityAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'last_activity_at' },
    },
    {
      tableName: 'checkout_sessions',
      // The list, phone-match and open-visitor indexes are created in
      // migration 091 (DESC columns and a partial unique index).
      indexes: [{ fields: ['workspace_id', 'status'] }, { fields: ['cart_id'] }],
    }
  );
  return CheckoutSession;
};
