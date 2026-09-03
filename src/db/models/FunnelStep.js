'use strict';

module.exports = (sequelize, DataTypes) => {
  const FunnelStep = sequelize.define(
    'FunnelStep',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      funnelId: { type: DataTypes.UUID, allowNull: false, field: 'funnel_id' },
      key: { type: DataTypes.STRING(100), allowNull: false }, // stable key referenced by edges
      stepType: {
        type: DataTypes.ENUM('landing', 'sales', 'opt_in', 'checkout', 'upsell', 'downsell', 'thank_you', 'custom'),
        allowNull: false,
        field: 'step_type',
      },
      name: { type: DataTypes.STRING(200), allowNull: false },
      builderData: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'builder_data' },
      offerId: { type: DataTypes.UUID, allowNull: true, field: 'offer_id' }, // for upsell/downsell steps
      abTestExperimentId: { type: DataTypes.UUID, allowNull: true, field: 'ab_test_experiment_id' },
      seo: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    },
    { tableName: 'funnel_steps', indexes: [{ unique: true, fields: ['funnel_id', 'key'] }] }
  );
  FunnelStep.associate = (models) => {
    FunnelStep.belongsTo(models.Funnel, { foreignKey: 'funnelId', as: 'funnel' });
    // `offerId` is what an upsell/downsell step sells when a visitor accepts it.
    FunnelStep.belongsTo(models.Offer, { foreignKey: 'offerId', as: 'offer' });
  };
  return FunnelStep;
};
