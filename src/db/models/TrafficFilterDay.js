'use strict';

module.exports = (sequelize, DataTypes) => {
  // What the events guard kept out, counted per UTC day (migration 704,
  // analytics/traffic/trafficCounters.js). Written by the counters' flush only.
  const TrafficFilterDay = sequelize.define(
    'TrafficFilterDay',
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      day: { type: DataTypes.DATEONLY, allowNull: false },
      workspaceId: { type: DataTypes.UUID, allowNull: true, field: 'workspace_id' },
      // bot | rejected | suspicious | capped
      kind: { type: DataTypes.STRING(20), allowNull: false },
      reason: { type: DataTypes.STRING(30), allowNull: false },
      // The bot family, the origin host, the hashed IP… ('' when none).
      label: { type: DataTypes.STRING(100), allowNull: false, defaultValue: '' },
      country: { type: DataTypes.STRING(2), allowNull: false, defaultValue: '' },
      count: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'traffic_filter_days', createdAt: false }
  );
  return TrafficFilterDay;
};
