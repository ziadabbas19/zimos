'use strict';

module.exports = (sequelize, DataTypes) => {
  // One random salt per UTC day for analytics_sessions.ip_hash (migration 704,
  // analytics/traffic/ipHash.js); deleted two days later.
  const TrafficSalt = sequelize.define(
    'TrafficSalt',
    {
      day: { type: DataTypes.DATEONLY, allowNull: false, primaryKey: true },
      salt: { type: DataTypes.STRING(64), allowNull: false },
    },
    { tableName: 'traffic_salts', updatedAt: false }
  );
  return TrafficSalt;
};
