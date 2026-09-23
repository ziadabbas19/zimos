'use strict';

/**
 * A merchant's own courier account (Bosta today; J&T and Aramex later), one
 * per workspace per carrier.
 *
 * credentials_encrypted holds the carrier API credentials, encrypted with
 * CARRIER_CREDENTIALS_KEY (core/utils/credentialsCipher.js). They are
 * write-only through the API: never returned, logged or audited.
 *
 * webhook_token is the secret in the carrier's status-webhook URL
 * (/webhooks/carriers/:code/:token). Unique, so the webhook resolves its
 * account with one indexed lookup; it stays the same when the merchant
 * re-enters credentials, so URLs already handed to the carrier keep working.
 *
 * settings holds carrier-specific defaults (e.g. Bosta's businessLocationId).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('carrier_accounts', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      carrier_code: { type: DataTypes.STRING(50), allowNull: false },
      credentials_encrypted: { type: DataTypes.TEXT, allowNull: false },
      status: { type: DataTypes.ENUM('active', 'invalid'), allowNull: false, defaultValue: 'active' },
      webhook_token: { type: DataTypes.STRING(100), allowNull: false },
      settings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      last_verified_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });

    await queryInterface.addIndex('carrier_accounts', ['workspace_id', 'carrier_code'], {
      unique: true,
      name: 'carrier_accounts_workspace_carrier_unique',
    });
    await queryInterface.addIndex('carrier_accounts', ['webhook_token'], {
      unique: true,
      name: 'carrier_accounts_webhook_token_unique',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('carrier_accounts');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_carrier_accounts_status";');
  },
};
