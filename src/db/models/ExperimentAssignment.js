'use strict';

module.exports = (sequelize, DataTypes) => {
  // Unique (experiment_id, visitor_id) makes assignment sticky: once a
  // visitor is assigned a variant, re-reading this table always returns the
  // same one for the life of the experiment.
  const ExperimentAssignment = sequelize.define(
    'ExperimentAssignment',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      experimentId: { type: DataTypes.UUID, allowNull: false, field: 'experiment_id' },
      visitorId: { type: DataTypes.STRING(64), allowNull: false, field: 'visitor_id' },
      variantKey: { type: DataTypes.STRING(50), allowNull: false, field: 'variant_key' },
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
    },
    { tableName: 'experiment_assignments', updatedAt: false, indexes: [{ unique: true, fields: ['experiment_id', 'visitor_id'] }] }
  );
  return ExperimentAssignment;
};
