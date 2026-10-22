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
      // Web-analytics columns (ported from Umami's website_event, MIT; migration 113).
      visitId: { type: DataTypes.STRING(64), allowNull: true, field: 'visit_id' },
      eventType: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 1, field: 'event_type' }, // 1 pageview, 2 custom, 3 link, 4 pixel
      urlPath: { type: DataTypes.STRING(500), allowNull: true, field: 'url_path' },
      urlQuery: { type: DataTypes.STRING(500), allowNull: true, field: 'url_query' },
      hostname: { type: DataTypes.STRING(100), allowNull: true },
      pageTitle: { type: DataTypes.STRING(500), allowNull: true, field: 'page_title' },
      referrerDomain: { type: DataTypes.STRING(500), allowNull: true, field: 'referrer_domain' },
      referrerPath: { type: DataTypes.STRING(500), allowNull: true, field: 'referrer_path' },
      utmContent: { type: DataTypes.STRING(255), allowNull: true, field: 'utm_content' },
      utmTerm: { type: DataTypes.STRING(255), allowNull: true, field: 'utm_term' },
      tag: { type: DataTypes.STRING(50), allowNull: true },
      currency: { type: DataTypes.STRING(3), allowNull: true },
      screen: { type: DataTypes.STRING(11), allowNull: true },
      language: { type: DataTypes.STRING(35), allowNull: true },
      // Visible time on this page view and the product it showed (migration 705,
      // analytics/traffic/visitorDetails.js); page views only.
      dwellMs: { type: DataTypes.INTEGER, allowNull: true, field: 'dwell_ms' },
      productId: { type: DataTypes.UUID, allowNull: true, field: 'product_id' },
    },
    {
      tableName: 'analytics_events',
      updatedAt: false,
      indexes: [
        { fields: ['workspace_id', 'event_name', 'created_at'] },
        { fields: ['workspace_id', 'created_at', 'url_path'] },
        { fields: ['workspace_id', 'created_at', 'referrer_domain'] },
        { fields: ['workspace_id', 'session_id', 'created_at'] },
        { fields: ['workspace_id', 'visit_id', 'created_at'] },
        { fields: ['workspace_id', 'event_type', 'created_at'] },
        { unique: true, fields: ['workspace_id', 'dedupe_id'], where: { dedupe_id: { [require('sequelize').Op.ne]: null } } },
      ],
    }
  );
  return AnalyticsEvent;
};
