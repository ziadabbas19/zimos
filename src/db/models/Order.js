'use strict';

module.exports = (sequelize, DataTypes) => {
  // Order lifecycle is intentionally split into three independent state
  // machines (confirmation, financial, fulfillment) rather than one giant
  // status field, per the product requirement that "Delivered" must never be
  // assumed to mean "Paid". Each is advanced independently by the module
  // that owns that concern (confirmation module, payments module, shipping
  // module) via modules/orders/orderStateService.js, which is the only place
  // allowed to write these columns.
  const Order = sequelize.define(
    'Order',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      websiteId: { type: DataTypes.UUID, allowNull: true, field: 'website_id' },
      funnelId: { type: DataTypes.UUID, allowNull: true, field: 'funnel_id' },
      customerId: { type: DataTypes.UUID, allowNull: false, field: 'customer_id' },
      orderNumber: { type: DataTypes.STRING(40), allowNull: false, field: 'order_number' },

      confirmationState: {
        type: DataTypes.ENUM('pending', 'confirmed', 'rejected', 'unreachable', 'postponed'),
        allowNull: false,
        defaultValue: 'pending',
        field: 'confirmation_state',
      },
      financialState: {
        type: DataTypes.ENUM('pending', 'partially_paid', 'paid', 'failed', 'refunded', 'partially_refunded'),
        allowNull: false,
        defaultValue: 'pending',
        field: 'financial_state',
      },
      fulfillmentState: {
        type: DataTypes.ENUM('unfulfilled', 'partially_fulfilled', 'fulfilled', 'returned'),
        allowNull: false,
        defaultValue: 'unfulfilled',
        field: 'fulfillment_state',
      },

      paymentMethod: {
        type: DataTypes.ENUM('cod', 'card', 'wallet', 'bank_transfer'),
        allowNull: false,
        field: 'payment_method',
      },

      currency: { type: DataTypes.STRING(3), allowNull: false },
      subtotalAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'subtotal_amount' },
      discountAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'discount_amount' },
      shippingAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'shipping_amount' },
      taxAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'tax_amount' },
      totalAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'total_amount' },
      amountPaid: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'amount_paid' },
      amountRefunded: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'amount_refunded' },

      // Contact/address snapshot — never joined live against Customer for
      // display, since the customer's info can change after the order.
      contactSnapshot: { type: DataTypes.JSONB, allowNull: false, field: 'contact_snapshot' },
      shippingAddressSnapshot: { type: DataTypes.JSONB, allowNull: true, field: 'shipping_address_snapshot' },
      discountsSnapshot: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'discounts_snapshot' },
      notes: { type: DataTypes.TEXT, allowNull: true },
      riskFlags: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [], field: 'risk_flags' },
      idempotencyKey: { type: DataTypes.STRING(200), allowNull: true, field: 'idempotency_key' },
      // Set when a merchant cancels the order directly (distinct from a COD
      // confirmation rejection, though both land on confirmationState 'rejected').
      cancelledAt: { type: DataTypes.DATE, allowNull: true, field: 'cancelled_at' },
      cancellationReason: { type: DataTypes.STRING(500), allowNull: true, field: 'cancellation_reason' },
      // Links an appended-order (e.g. COD upsell that couldn't be merged
      // because the waybill was already created) back to the original order.
      linkedFromOrderId: { type: DataTypes.UUID, allowNull: true, field: 'linked_from_order_id' },
    },
    {
      tableName: 'orders',
      indexes: [
        { unique: true, fields: ['workspace_id', 'order_number'] },
        { unique: true, fields: ['workspace_id', 'idempotency_key'] },
        { fields: ['workspace_id', 'customer_id'] },
        { fields: ['workspace_id', 'confirmation_state'] },
        { fields: ['workspace_id', 'financial_state'] },
        { fields: ['workspace_id', 'fulfillment_state'] },
      ],
    }
  );

  Order.associate = (models) => {
    Order.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Order.belongsTo(models.Customer, { foreignKey: 'customerId', as: 'customer' });
    Order.hasMany(models.OrderItem, { foreignKey: 'orderId', as: 'items' });
    Order.hasMany(models.Payment, { foreignKey: 'orderId', as: 'payments' });
    Order.hasMany(models.Refund, { foreignKey: 'orderId', as: 'refunds' });
    Order.hasMany(models.Shipment, { foreignKey: 'orderId', as: 'shipments' });
    Order.hasMany(models.ConfirmationTask, { foreignKey: 'orderId', as: 'confirmationTasks' });
  };

  return Order;
};
