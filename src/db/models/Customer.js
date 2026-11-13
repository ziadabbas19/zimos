'use strict';

module.exports = (sequelize, DataTypes) => {
  // Customer identity is primarily keyed on normalized phone number, since
  // COD workflows in this market run on phone contact rather than email.
  // `phoneNormalized` is E.164-ish (digits only, country-code prefixed) and
  // is what uniqueness and lookups are based on; `phoneRaw` preserves what
  // the customer actually typed for display purposes.
  const Customer = sequelize.define(
    'Customer',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      phoneNormalized: { type: DataTypes.STRING(32), allowNull: false, field: 'phone_normalized' },
      phoneRaw: { type: DataTypes.STRING(32), allowNull: true, field: 'phone_raw' },
      alternatePhone: { type: DataTypes.STRING(32), allowNull: true, field: 'alternate_phone' },
      email: { type: DataTypes.STRING(255), allowNull: true },
      fullName: { type: DataTypes.STRING(200), allowNull: true, field: 'full_name' },
      marketingConsent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'marketing_consent' },
      // Where the current marketing consent was given (migration 749, emailCampaigns/consent.js):
      // checkout | quick_order | cart | footer | popup; null for one from elsewhere or from before.
      marketingConsentSource: { type: DataTypes.STRING(20), allowNull: true, field: 'marketing_consent_source' },
      isBlacklisted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_blacklisted' },
      blacklistReason: { type: DataTypes.STRING(300), allowNull: true, field: 'blacklist_reason' },
      // When the current blacklisting started; null while not blacklisted.
      // Set and cleared only by customerService.applyBlacklist.
      blacklistedAt: { type: DataTypes.DATE, allowNull: true, field: 'blacklisted_at' },
      segments: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
      // Contact labels and first source (migration 172, modules/contacts).
      tags: { type: DataTypes.ARRAY(DataTypes.STRING(60)), allowNull: false, defaultValue: [] },
      source: { type: DataTypes.STRING(20), allowNull: true },
      reliabilityScore: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100, field: 'reliability_score' },
      // Denormalized rolling counters, maintained by the orders module when
      // confirmation/fulfillment outcomes are recorded.
      totalOrders: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'total_orders' },
      totalRejectedOrders: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'total_rejected_orders' },
      // Shopper accounts (migrations 670, 672, modules/shopperAccounts).
      savedAddresses: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'saved_addresses' },
      accountVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: 'account_version' },
      lastLoginAt: { type: DataTypes.DATE, allowNull: true, field: 'last_login_at' },
      // When the shopper proved they own `email`: only then does it sign them in.
      emailVerifiedAt: { type: DataTypes.DATE, allowNull: true, field: 'email_verified_at' },
      // Store credit held at the store, minor units, store currency (migration 681, modules/storeCredit).
      storeCreditAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'store_credit_amount' },
      // Loyalty points balance and last earn/spend (migration 680, modules/loyalty).
      loyaltyPoints: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'loyalty_points' },
      loyaltyActivityAt: { type: DataTypes.DATE, allowNull: true, field: 'loyalty_activity_at' },
    },
    {
      tableName: 'customers',
      indexes: [
        { unique: true, fields: ['workspace_id', 'phone_normalized'] },
        { fields: ['workspace_id', 'is_blacklisted'] },
      ],
    }
  );

  Customer.associate = (models) => {
    Customer.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Customer.hasMany(models.CustomerAddress, { foreignKey: 'customerId', as: 'addresses' });
    Customer.hasMany(models.Order, { foreignKey: 'customerId', as: 'orders' });
  };

  return Customer;
};
