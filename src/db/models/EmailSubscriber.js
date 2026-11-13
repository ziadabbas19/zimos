'use strict';

module.exports = (sequelize, DataTypes) => {
  // An address that signed up for a store's marketing emails from the footer
  // or the popup while the store had no customer with it (migration 749,
  // modules/emailCampaigns/consent.js). One row per address per store.
  const EmailSubscriber = sequelize.define(
    'EmailSubscriber',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      // Lowercased and trimmed.
      email: { type: DataTypes.STRING(255), allowNull: false },
      marketingConsent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'marketing_consent' },
      // checkout | quick_order | cart | footer | popup
      source: { type: DataTypes.STRING(20), allowNull: false },
      consentedAt: { type: DataTypes.DATE, allowNull: true, field: 'consented_at' },
    },
    { tableName: 'email_subscribers', indexes: [{ unique: true, fields: ['workspace_id', 'email'], name: 'email_subscribers_workspace_email_key' }] }
  );
  return EmailSubscriber;
};
