'use strict';

module.exports = (sequelize, DataTypes) => {
  // One address one campaign goes to (migration 748, modules/emailCampaigns/campaignSender.js).
  const EmailCampaignRecipient = sequelize.define(
    'EmailCampaignRecipient',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      campaignId: { type: DataTypes.UUID, allowNull: false, field: 'campaign_id' },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      customerId: { type: DataTypes.UUID, allowNull: true, field: 'customer_id' },
      email: { type: DataTypes.STRING(255), allowNull: false },
      // queued | sending | sent | failed | skipped | cancelled
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'queued' },
      attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      nextAttemptAt: { type: DataTypes.DATE, allowNull: true, field: 'next_attempt_at' },
      claimedAt: { type: DataTypes.DATE, allowNull: true, field: 'claimed_at' },
      handedAt: { type: DataTypes.DATE, allowNull: true, field: 'handed_at' },
      sentAt: { type: DataTypes.DATE, allowNull: true, field: 'sent_at' },
      provider: { type: DataTypes.STRING(20), allowNull: true },
      providerMessageId: { type: DataTypes.STRING(255), allowNull: true, field: 'provider_message_id' },
      error: { type: DataTypes.STRING(300), allowNull: true },
      // delivered | bounced | complained | undelivered, from the provider's reports
      deliveryStatus: { type: DataTypes.STRING(20), allowNull: true, field: 'delivery_status' },
      deliveredAt: { type: DataTypes.DATE, allowNull: true, field: 'delivered_at' },
      openedAt: { type: DataTypes.DATE, allowNull: true, field: 'opened_at' },
      clickedAt: { type: DataTypes.DATE, allowNull: true, field: 'clicked_at' },
      unsubscribedAt: { type: DataTypes.DATE, allowNull: true, field: 'unsubscribed_at' },
    },
    { tableName: 'email_campaign_recipients', updatedAt: false }
  );

  EmailCampaignRecipient.associate = (models) => {
    EmailCampaignRecipient.belongsTo(models.EmailCampaign, { foreignKey: 'campaignId', as: 'campaign' });
  };

  return EmailCampaignRecipient;
};
