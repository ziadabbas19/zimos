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
        type: DataTypes.ENUM('cod', 'card', 'wallet', 'valu', 'kiosk', 'bank_transfer'),
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
      // The shopper's IP, its country and their browser (storefront orders only) — migration 141.
      ipAddress: { type: DataTypes.STRING(45), allowNull: true, field: 'ip_address' },
      ipCountry: { type: DataTypes.STRING(2), allowNull: true, field: 'ip_country' },
      userAgent: { type: DataTypes.STRING(400), allowNull: true, field: 'user_agent' },
      // The browser's own id, from the storefront — migration 144.
      deviceId: { type: DataTypes.STRING(128), allowNull: true, field: 'device_id' },
      // risk/riskService: points, low | moderate | high, the reasons, good | low — migration 142.
      riskScore: { type: DataTypes.INTEGER, allowNull: true, field: 'risk_score' },
      riskLevel: { type: DataTypes.STRING(10), allowNull: true, field: 'risk_level' },
      riskReasons: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'risk_reasons' },
      dataQuality: { type: DataTypes.STRING(10), allowNull: true, field: 'data_quality' },
      idempotencyKey: { type: DataTypes.STRING(200), allowNull: true, field: 'idempotency_key' },
      // Set when a merchant cancels the order directly (distinct from a COD
      // confirmation rejection, though both land on confirmationState 'rejected').
      cancelledAt: { type: DataTypes.DATE, allowNull: true, field: 'cancelled_at' },
      cancellationReason: { type: DataTypes.STRING(500), allowNull: true, field: 'cancellation_reason' },
      // 'pickup': the customer collects it from the store (shipping/storePickup.js); null = delivered.
      deliveryMethod: { type: DataTypes.STRING(20), allowNull: true, field: 'delivery_method' },
      // Links an appended-order (e.g. COD upsell that couldn't be merged
      // because the waybill was already created) back to the original order.
      linkedFromOrderId: { type: DataTypes.UUID, allowNull: true, field: 'linked_from_order_id' },
      // SPEC §4.2 (migration 139, modules/orders/orderMetaService.js): where
      // the order came from, the merchant's labels, whether anyone opened it,
      // a test order (kept out of sales figures and pixels), and the archive.
      source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'store' },
      // SPEC §13.3/§13.4 (migration 154, modules/marketing): first/last touch,
      // the visitor's stats before buying, and when Purchase was reported.
      attribution: { type: DataTypes.JSONB, allowNull: true },
      sessionStats: { type: DataTypes.JSONB, allowNull: true, field: 'session_stats' },
      purchaseEventSentAt: { type: DataTypes.DATE, allowNull: true, field: 'purchase_event_sent_at' },
      // The ad platforms' browser ids sent with the checkout (migration 193, marketing/pixelMatching.js).
      adMatch: { type: DataTypes.JSONB, allowNull: true, field: 'ad_match' },
      // The shipping card's saved draft (migration 194, orders/shipmentDraft.js); cleared when a shipment is created.
      shipmentDraft: { type: DataTypes.JSONB, allowNull: true, field: 'shipment_draft' },
      tags: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
      // { wrapped, message, hidePrices } — a gift order (migration 647, modules/giftOptions).
      giftOptions: { type: DataTypes.JSONB, allowNull: true, field: 'gift_options' },
      isSeen: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_seen' },
      seenAt: { type: DataTypes.DATE, allowNull: true, field: 'seen_at' },
      isTest: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_test' },
      archivedAt: { type: DataTypes.DATE, allowNull: true, field: 'archived_at' },
      // Weight snapshot taken at checkout — see migration 097.
      totalWeightGrams: { type: DataTypes.INTEGER, allowNull: true, field: 'total_weight_grams' },
      weightTierSnapshot: { type: DataTypes.JSONB, allowNull: true, field: 'weight_tier_snapshot' },
      weightEstimated: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'weight_estimated' },
      // How shippingAmount was reached (rule, base, extra fees, governorate) —
      // migration 114. Display only; the amount is shippingAmount.
      shippingSnapshot: { type: DataTypes.JSONB, allowNull: true, field: 'shipping_snapshot' },
      // When the current confirmation happened; null while not confirmed —
      // migration 115, written by orderStateService.setConfirmationState.
      confirmedAt: { type: DataTypes.DATE, allowNull: true, field: 'confirmed_at' },
      // unlocked | due | null — whether the customer's details stay visible
      // once the order is confirmed (migration 718, orders/orderLock.js).
      contactLock: { type: DataTypes.STRING(10), allowNull: true, field: 'contact_lock' },
      // When the order became a sale — see modules/orders/orderCompletion.js.
      completedAt: { type: DataTypes.DATE, allowNull: true, field: 'completed_at' },
      // Unpaid online orders — see migration 099. The token hash is never
      // serialized (toJSON below).
      paymentExpiresAt: { type: DataTypes.DATE, allowNull: true, field: 'payment_expires_at' },
      paymentTokenHash: { type: DataTypes.STRING(64), allowNull: true, field: 'payment_token_hash' },
      completionContext: { type: DataTypes.JSONB, allowNull: true, field: 'completion_context' },
      // Answers to the purchase-form fields with no column (checkout/checkoutForm.js).
      checkoutFields: { type: DataTypes.JSONB, allowNull: true, field: 'checkout_fields' },
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

  Order.prototype.toJSON = function toJSON() {
    const values = this.get({ plain: true });
    delete values.paymentTokenHash;
    delete values.completionContext;
    return values;
  };

  Order.associate = (models) => {
    Order.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Order.belongsTo(models.Customer, { foreignKey: 'customerId', as: 'customer' });
    Order.hasMany(models.OrderItem, { foreignKey: 'orderId', as: 'items' });
    Order.hasMany(models.Payment, { foreignKey: 'orderId', as: 'payments' });
    Order.hasMany(models.Refund, { foreignKey: 'orderId', as: 'refunds' });
    Order.hasMany(models.Shipment, { foreignKey: 'orderId', as: 'shipments' });
    Order.hasMany(models.ConfirmationTask, { foreignKey: 'orderId', as: 'confirmationTasks' });
    Order.hasMany(models.OrderNote, { foreignKey: 'orderId', as: 'orderNotes' });
  };

  return Order;
};
