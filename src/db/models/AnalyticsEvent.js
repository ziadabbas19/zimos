'use strict';

module.exports = (sequelize, DataTypes) => {
  // `dedupeId` lets server-side and browser-side firings of the same
  // logical event (e.g. a Purchase event sent both from the pixel and from
  // the backend webhook) be deduplicated downstream.
  const AnalyticsEvent = sequelize.define(
    'AnalyticsEvent',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      websiteId: { type: DataTypes.UUID, allowNull: true, field: 'website_id' },
      funnelId: { type: DataTypes.UUID, allowNull: true, field: 'funnel_id' },
      visitorId: { type: DataTypes.STRING(64), allowNull: false, field: 'visitor_id' },
      sessionId: { type: DataTypes.STRING(64), allowNull: true, field: 'session_id' },
      dedupeId: { type: DataTypes.STRING(100), allowNull: true, field: 'dedupe_id' },
      eventName: { type: DataTypes.STRING(100), allowNull: false, field: 'event_name' },
      source: { type: DataTypes.STRING(100), allowNull: true },
      medium: { type: DataTypes.STRING(100), allowNull: true },
      campaign: { type: DataTypes.STRING(150), allowNull: true },
      referrer: { type: DataTypes.STRING(500), allowNull: true },
      landingPage: { type: DataTypes.STRING(500), allowNull: true, field: 'landing_page' },
      clickIds: { type: DataTypes.JSONB, allowNull: true, field: 'click_ids' }, // { gclid, fbclid, ttclid }
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      revenueAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'revenue_amount' },
      metadata: { type: DataTypes.JSONB, allowNull: true },
    },
    {
      tableName: 'analytics_events',
      updatedAt: false,
      indexes: [
        { fields: ['workspace_id', 'event_name', 'created_at'] },
        { unique: true, fields: ['workspace_id', 'dedupe_id'], where: { dedupe_id: { [require('sequelize').Op.ne]: null } } },
      ],
    }
  );
  return AnalyticsEvent;
};
