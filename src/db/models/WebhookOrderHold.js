'use strict';
module.exports = (sequelize, DataTypes) => {
  // An order whose webhooks wait because it is locked (migration 718,
  // modules/webhooks/orderChangeDetector.js). Written and removed only by that
  // detector: the row goes when the order opens and its events are sent.
  const WebhookOrderHold = sequelize.define(
    'WebhookOrderHold',
    {
      orderId: { type: DataTypes.UUID, primaryKey: true, field: 'order_id' },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      heldAt: { type: DataTypes.DATE, allowNull: false, field: 'held_at' },
      checkedAt: { type: DataTypes.DATE, allowNull: false, field: 'checked_at' },
    },
    { tableName: 'webhook_order_holds' }
  );
  return WebhookOrderHold;
};
