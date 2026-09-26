'use strict';

module.exports = (sequelize, DataTypes) => {
  // `carrierCode` selects the adapter in modules/shipping/carriers/*; 'manual'
  // is always available for carriers without an API (manual waybill entry).
  const Shipment = sequelize.define(
    'Shipment',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      // Human-facing reference (`zg` + 9 digits), distinct from the UUID PK.
      // Generated with a collision-retry loop; unique per the DB index.
      trackingCode: { type: DataTypes.STRING(16), allowNull: false, field: 'tracking_code' },
      carrierCode: { type: DataTypes.STRING(100), allowNull: false, field: 'carrier_code' },
      waybillNumber: { type: DataTypes.STRING(100), allowNull: true, field: 'waybill_number' },
      status: {
        type: DataTypes.ENUM('created', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned', 'cancelled'),
        allowNull: false,
        defaultValue: 'created',
      },
      trackingUrl: { type: DataTypes.STRING(500), allowNull: true, field: 'tracking_url' },
      carrierResponse: { type: DataTypes.JSONB, allowNull: true, field: 'carrier_response' },
      shippedAt: { type: DataTypes.DATE, allowNull: true, field: 'shipped_at' },
      deliveredAt: { type: DataTypes.DATE, allowNull: true, field: 'delivered_at' },
      // Migration 102. The carrier account a courier booking went through
      // (null for manual shipments and after a disconnect).
      carrierAccountId: { type: DataTypes.UUID, allowNull: true, field: 'carrier_account_id' },
      // 'api' | 'manual_ack' — how a carrier-booked shipment was cancelled.
      cancelMode: { type: DataTypes.STRING(20), allowNull: true, field: 'cancel_mode' },
      cancelAcknowledgedBy: { type: DataTypes.UUID, allowNull: true, field: 'cancel_acknowledged_by' },
      cancelAcknowledgedAt: { type: DataTypes.DATE, allowNull: true, field: 'cancel_acknowledged_at' },
      // scripts/sync-carrier-shipments.js scheduling (carrierSyncService).
      nextPollAt: { type: DataTypes.DATE, allowNull: true, field: 'next_poll_at' },
      lastPolledAt: { type: DataTypes.DATE, allowNull: true, field: 'last_polled_at' },
      pollFailures: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'poll_failures' },
    },
    {
      tableName: 'shipments',
      indexes: [{ fields: ['workspace_id'] }, { fields: ['order_id'] }, { unique: true, fields: ['tracking_code'] }],
    }
  );
  Shipment.associate = (models) => {
    Shipment.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };
  return Shipment;
};
