'use strict';

module.exports = (sequelize, DataTypes) => {
  // A store's email campaign to its own customers (migration 748, modules/emailCampaigns).
  const counter = (field) => ({ type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field });
  const EmailCampaign = sequelize.define(
    'EmailCampaign',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(120), allowNull: false },
      subject: { type: DataTypes.STRING(200), allowNull: false, defaultValue: '' },
      preheader: { type: DataTypes.STRING(200), allowNull: true },
      blocks: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      // ar | en: the email's language and direction.
      locale: { type: DataTypes.STRING(5), allowNull: false, defaultValue: 'ar' },
      replyTo: { type: DataTypes.STRING(255), allowNull: true, field: 'reply_to' },
      audience: { type: DataTypes.JSONB, allowNull: false, defaultValue: { type: 'all' } },
      // draft | scheduled | sending | sent | failed | cancelled
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
      scheduledAt: { type: DataTypes.DATE, allowNull: true, field: 'scheduled_at' },
      startedAt: { type: DataTypes.DATE, allowNull: true, field: 'started_at' },
      finishedAt: { type: DataTypes.DATE, allowNull: true, field: 'finished_at' },
      cancelledAt: { type: DataTypes.DATE, allowNull: true, field: 'cancelled_at' },
      // Sending waits until then: the store's daily cap was reached.
      pausedUntil: { type: DataTypes.DATE, allowNull: true, field: 'paused_until' },
      failureReason: { type: DataTypes.STRING(60), allowNull: true, field: 'failure_reason' },
      recipientsCount: counter('recipients_count'),
      sentCount: counter('sent_count'),
      failedCount: counter('failed_count'),
      skippedCount: counter('skipped_count'),
      deliveredCount: counter('delivered_count'),
      openedCount: counter('opened_count'),
      clickedCount: counter('clicked_count'),
      bouncedCount: counter('bounced_count'),
      complainedCount: counter('complained_count'),
      unsubscribedCount: counter('unsubscribed_count'),
      createdByUserId: { type: DataTypes.UUID, allowNull: true, field: 'created_by_user_id' },
    },
    { tableName: 'email_campaigns' }
  );

  EmailCampaign.associate = (models) => {
    EmailCampaign.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    EmailCampaign.hasMany(models.EmailCampaignRecipient, { foreignKey: 'campaignId', as: 'recipients' });
  };

  return EmailCampaign;
};
