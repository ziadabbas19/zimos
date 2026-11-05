'use strict';

module.exports = (sequelize, DataTypes) => {
  // A change to which agent earns on a store, asked for by anyone but a creator
  // (migration 743, referrals/agentLinkService). Nothing reads it to earn: the
  // link as it stands goes on until a creator approves this.
  const AgentLinkRequest = sequelize.define(
    'AgentLinkRequest',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      // The link it changes; null on kind 'link', which makes a new one.
      agentLinkId: { type: DataTypes.UUID, allowNull: true, field: 'agent_link_id' },
      // 'link' | 'update' | 'end'
      kind: { type: DataTypes.STRING(10), allowNull: false },
      // What the console sent, checked: what agentLinkService applies on approval.
      changes: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      // 'pending' | 'approved' | 'rejected'
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
      // Why it was rejected; optional.
      reason: { type: DataTypes.TEXT, allowNull: true },
      requestedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'requested_by_user_id' },
      reviewedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'reviewed_by_user_id' },
      reviewedAt: { type: DataTypes.DATE, allowNull: true, field: 'reviewed_at' },
    },
    { tableName: 'agent_link_requests' }
  );
  AgentLinkRequest.associate = (models) => {
    AgentLinkRequest.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    AgentLinkRequest.belongsTo(models.AgentLink, { foreignKey: 'agentLinkId', as: 'link' });
    AgentLinkRequest.belongsTo(models.User, { foreignKey: 'requestedByUserId', as: 'requestedBy' });
    AgentLinkRequest.belongsTo(models.User, { foreignKey: 'reviewedByUserId', as: 'reviewedBy' });
  };
  return AgentLinkRequest;
};
