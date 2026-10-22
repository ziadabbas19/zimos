'use strict';

/**
 * One row per (workspace, client session): the visitor's browser/os/device/
 * screen/language/geo captured on the session's first event, plus the visit
 * that is currently open (a visit ends after 30 minutes of inactivity).
 * Ported from Umami's `session` model (MIT).
 */
module.exports = (sequelize, DataTypes) => {
  const AnalyticsSession = sequelize.define(
    'AnalyticsSession',
    {
      id: { type: DataTypes.STRING(64), allowNull: false, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'workspace_id' },
      websiteId: { type: DataTypes.UUID, allowNull: true, field: 'website_id' },
      visitorId: { type: DataTypes.STRING(64), allowNull: false, field: 'visitor_id' },
      browser: { type: DataTypes.STRING(20), allowNull: true },
      os: { type: DataTypes.STRING(20), allowNull: true },
      device: { type: DataTypes.STRING(20), allowNull: true },
      screen: { type: DataTypes.STRING(11), allowNull: true },
      language: { type: DataTypes.STRING(35), allowNull: true },
      country: { type: DataTypes.CHAR(2), allowNull: true },
      region: { type: DataTypes.STRING(20), allowNull: true },
      city: { type: DataTypes.STRING(50), allowNull: true },
      currentVisitId: { type: DataTypes.STRING(64), allowNull: false, field: 'current_visit_id' },
      lastSeenAt: { type: DataTypes.DATE, allowNull: false, field: 'last_seen_at' },
      // The events guard (migration 704, analytics/traffic): the IP hashed with
      // that day's salt, and whether the session's events are kept out of the numbers.
      ipHash: { type: DataTypes.STRING(16), allowNull: true, field: 'ip_hash' },
      isBot: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_bot' },
      isSuspicious: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_suspicious' },
      flagReason: { type: DataTypes.STRING(30), allowNull: true, field: 'flag_reason' },
      flaggedAt: { type: DataTypes.DATE, allowNull: true, field: 'flagged_at' },
      excludedEvents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'excluded_events' },
      // What the visit was (migration 705, analytics/traffic/visitorDetails.js): where it
      // came from, the governorate (from the IP, or from the shopper's order), and the
      // funnel steps it reached. Only rows with `detailed` have them.
      detailed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      source: { type: DataTypes.STRING(100), allowNull: true },
      medium: { type: DataTypes.STRING(100), allowNull: true },
      campaign: { type: DataTypes.STRING(150), allowNull: true },
      utmContent: { type: DataTypes.STRING(255), allowNull: true, field: 'utm_content' },
      utmTerm: { type: DataTypes.STRING(255), allowNull: true, field: 'utm_term' },
      referrerDomain: { type: DataTypes.STRING(255), allowNull: true, field: 'referrer_domain' },
      landingPath: { type: DataTypes.STRING(500), allowNull: true, field: 'landing_path' },
      hasGclid: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'has_gclid' },
      hasFbclid: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'has_fbclid' },
      hasTtclid: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'has_ttclid' },
      governorate: { type: DataTypes.STRING(30), allowNull: true },
      governorateApprox: { type: DataTypes.STRING(30), allowNull: true, field: 'governorate_approx' },
      // ip_approx | order_address
      geoSource: { type: DataTypes.STRING(20), allowNull: true, field: 'geo_source' },
      pageViews: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'page_views' },
      reachedProduct: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'reached_product' },
      reachedCart: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'reached_cart' },
      reachedCheckout: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'reached_checkout' },
      ordered: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      lastOrderId: { type: DataTypes.UUID, allowNull: true, field: 'last_order_id' },
    },
    {
      tableName: 'analytics_sessions',
      updatedAt: false,
      indexes: ['browser', 'os', 'device', 'country', 'language'].map((c) => ({ fields: ['workspace_id', 'created_at', c] })),
    }
  );
  return AnalyticsSession;
};
