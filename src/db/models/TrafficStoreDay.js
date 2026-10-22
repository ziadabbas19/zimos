'use strict';

module.exports = (sequelize, DataTypes) => {
  // Raw events stored per store and UTC day, and what went over the daily cap
  // (migration 704, analytics/traffic/trafficCounters.js).
  const TrafficStoreDay = sequelize.define(
    'TrafficStoreDay',
    {
      workspaceId: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'workspace_id' },
      day: { type: DataTypes.DATEONLY, allowNull: false, primaryKey: true },
      storedEvents: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'stored_events' },
      overflowEvents: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'overflow_events' },
      overflowPageViews: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'overflow_page_views' },
      capReachedAt: { type: DataTypes.DATE, allowNull: true, field: 'cap_reached_at' },
    },
    { tableName: 'traffic_store_days', createdAt: false }
  );
  return TrafficStoreDay;
};
