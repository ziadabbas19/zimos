'use strict';

module.exports = (sequelize, DataTypes) => {
  // Events of a session the guard flagged, moved out of analytics_events so no
  // report counts them (migration 704, analytics/traffic/suspicion.js). The
  // table has every column of analytics_events; only the ones read are here.
  const AnalyticsQuarantineEvent = sequelize.define(
    'AnalyticsQuarantineEvent',
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      visitorId: { type: DataTypes.STRING(64), allowNull: false, field: 'visitor_id' },
      sessionId: { type: DataTypes.STRING(64), allowNull: true, field: 'session_id' },
      eventName: { type: DataTypes.STRING(100), allowNull: false, field: 'event_name' },
      urlPath: { type: DataTypes.STRING(500), allowNull: true, field: 'url_path' },
      pageTitle: { type: DataTypes.STRING(500), allowNull: true, field: 'page_title' },
      reason: { type: DataTypes.STRING(30), allowNull: false },
      quarantinedAt: { type: DataTypes.DATE, allowNull: false, field: 'quarantined_at' },
    },
    { tableName: 'analytics_quarantine_events', updatedAt: false }
  );
  return AnalyticsQuarantineEvent;
};
