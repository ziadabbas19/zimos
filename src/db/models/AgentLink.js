'use strict';

module.exports = (sequelize, DataTypes) => {
  // Which agent earns on a store's payments (migration 725, referrals/agentLinkService).
  // One open link (endedAt null) per store. Never deleted: ending or replacing
  // one sets endedAt, and the next is a new row.
  const AgentLink = sequelize.define(
    'AgentLink',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      agentId: { type: DataTypes.UUID, allowNull: false, field: 'agent_id' },
      // 'code' (entering a code linked the store) | 'manual' (set in the console).
      source: { type: DataTypes.STRING(10), allowNull: false },
      codeId: { type: DataTypes.UUID, allowNull: true, field: 'code_id' },
      redemptionId: { type: DataTypes.UUID, allowNull: true, field: 'redemption_id' },
      // A link backfilled from before migration 725: it earns as a code did then
      // (on a payment that carries its code, at the code's rate now).
      legacy: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      startsAt: { type: DataTypes.DATE, allowNull: false, field: 'starts_at' },
      // Optional planned end: payments after it earn nothing.
      endsAt: { type: DataTypes.DATE, allowNull: true, field: 'ends_at' },
      endedAt: { type: DataTypes.DATE, allowNull: true, field: 'ended_at' },
      // 'replaced' (another link took its place) | 'ended' (ended in the console).
      endReason: { type: DataTypes.STRING(20), allowNull: true, field: 'end_reason' },
      // { monthly: CommissionStep[], yearly: CommissionStep[] } (referrals/referralTerms.js); null on a legacy link.
      terms: { type: DataTypes.JSONB, allowNull: true },
      commissionBasis: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'paid', field: 'commission_basis' },
      note: { type: DataTypes.TEXT, allowNull: true },
      createdByUserId: { type: DataTypes.UUID, allowNull: true, field: 'created_by_user_id' },
      endedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'ended_by_user_id' },
    },
    { tableName: 'agent_links' }
  );
  AgentLink.associate = (models) => {
    AgentLink.belongsTo(models.User, { foreignKey: 'agentId', as: 'agent' });
    AgentLink.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    AgentLink.belongsTo(models.ReferralCode, { foreignKey: 'codeId', as: 'code' });
    AgentLink.belongsTo(models.ReferralCodeRedemption, { foreignKey: 'redemptionId', as: 'redemption' });
    AgentLink.belongsTo(models.User, { foreignKey: 'createdByUserId', as: 'createdBy' });
    AgentLink.belongsTo(models.User, { foreignKey: 'endedByUserId', as: 'endedBy' });
  };
  return AgentLink;
};
