'use strict';

/**
 * Online payments through a merchant's own gateway account (Paymob first).
 *
 * payment_gateway_accounts — one row per workspace per gateway. Credentials
 * are AES-256-GCM encrypted with GATEWAY_CREDENTIALS_KEY and bound to
 * `<workspaceId>:<providerCode>` (see core/utils/credentialsCipher.js). The
 * webhook token is the account's identity in the callback URL. `mode` is
 * 'test' or 'live', read from the keys when the account is connected.
 *
 * payments — each row is now one payment ATTEMPT: a shopper sent to the
 * gateway once. New columns: the method (card / wallet), the account mode, the
 * gateway's order and transaction ids (callbacks are matched on the order id,
 * which the callback HMAC covers), where the shopper was sent, when the
 * attempt stops being payable, when it was paid, when we last asked the
 * gateway about it. Unique on (provider_code, provider_order_id).
 *
 * payment_events — the inbox. Every signed callback (and every inquiry
 * answer that changed something) lands here first, deduplicated on
 * (provider_code, event_key), then is processed. An unprocessed row is retried
 * by the sweep. The payload is stored as received minus card data the
 * gateway already masks.
 *
 * orders — payment_expires_at (unpaid online order: when it stops holding
 * stock), payment_token_hash (sha256 of the shopper's status token, for the
 * public status / retry / switch-to-COD endpoints), completion_context (what
 * the order-completed step needs once the payment lands: cart, autosaved
 * session, discount).
 *
 * VARCHAR + CHECK instead of new enums throughout, so later values are a
 * constraint swap instead of ALTER TYPE ... ADD VALUE.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'payment_gateway_accounts',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
          workspace_id: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'workspaces', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          provider_code: { type: DataTypes.STRING(50), allowNull: false },
          credentials_encrypted: { type: DataTypes.TEXT, allowNull: false },
          settings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
          mode: { type: DataTypes.STRING(10), allowNull: false },
          status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
          webhook_token: { type: DataTypes.STRING(64), allowNull: false },
          last_verified_at: { type: DataTypes.DATE, allowNull: true },
          last_webhook_at: { type: DataTypes.DATE, allowNull: true },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
          updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE payment_gateway_accounts
           ADD CONSTRAINT payment_gateway_accounts_mode_check CHECK (mode IN ('test', 'live')),
           ADD CONSTRAINT payment_gateway_accounts_status_check CHECK (status IN ('active', 'invalid'));
         CREATE UNIQUE INDEX payment_gateway_accounts_workspace_provider_uniq
           ON payment_gateway_accounts (workspace_id, provider_code);
         CREATE UNIQUE INDEX payment_gateway_accounts_webhook_token_uniq
           ON payment_gateway_accounts (webhook_token);`,
        { transaction }
      );

      await queryInterface.addColumn('payments', 'method', { type: DataTypes.STRING(20), allowNull: true }, { transaction });
      await queryInterface.addColumn('payments', 'mode', { type: DataTypes.STRING(10), allowNull: true }, { transaction });
      await queryInterface.addColumn('payments', 'provider_order_id', { type: DataTypes.STRING(100), allowNull: true }, { transaction });
      await queryInterface.addColumn('payments', 'provider_transaction_id', { type: DataTypes.STRING(100), allowNull: true }, { transaction });
      await queryInterface.addColumn('payments', 'redirect_url', { type: DataTypes.TEXT, allowNull: true }, { transaction });
      await queryInterface.addColumn('payments', 'return_url', { type: DataTypes.TEXT, allowNull: true }, { transaction });
      await queryInterface.addColumn('payments', 'expires_at', { type: DataTypes.DATE, allowNull: true }, { transaction });
      await queryInterface.addColumn('payments', 'paid_at', { type: DataTypes.DATE, allowNull: true }, { transaction });
      await queryInterface.addColumn('payments', 'last_inquired_at', { type: DataTypes.DATE, allowNull: true }, { transaction });
      await queryInterface.sequelize.query(
        `ALTER TABLE payments
           ADD CONSTRAINT payments_mode_check CHECK (mode IS NULL OR mode IN ('test', 'live'));
         CREATE UNIQUE INDEX payments_provider_order_uniq
           ON payments (provider_code, provider_order_id) WHERE provider_order_id IS NOT NULL;
         CREATE INDEX payments_provider_transaction_idx
           ON payments (provider_code, provider_transaction_id) WHERE provider_transaction_id IS NOT NULL;`,
        { transaction }
      );

      await queryInterface.createTable(
        'payment_events',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
          workspace_id: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'workspaces', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          account_id: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'payment_gateway_accounts', key: 'id' },
            onDelete: 'SET NULL',
            onUpdate: 'CASCADE',
          },
          provider_code: { type: DataTypes.STRING(50), allowNull: false },
          event_key: { type: DataTypes.STRING(200), allowNull: false },
          source: { type: DataTypes.STRING(20), allowNull: false },
          kind: { type: DataTypes.STRING(20), allowNull: true },
          provider_order_id: { type: DataTypes.STRING(100), allowNull: true },
          provider_transaction_id: { type: DataTypes.STRING(100), allowNull: true },
          payment_id: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'payments', key: 'id' },
            onDelete: 'SET NULL',
            onUpdate: 'CASCADE',
          },
          order_id: {
            type: DataTypes.UUID,
            allowNull: true,
            references: { model: 'orders', key: 'id' },
            onDelete: 'SET NULL',
            onUpdate: 'CASCADE',
          },
          payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
          processed_at: { type: DataTypes.DATE, allowNull: true },
          outcome: { type: DataTypes.STRING(60), allowNull: true },
          error: { type: DataTypes.STRING(500), allowNull: true },
          attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
          updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE payment_events
           ADD CONSTRAINT payment_events_source_check CHECK (source IN ('webhook', 'redirect', 'inquiry'));
         CREATE UNIQUE INDEX payment_events_provider_key_uniq ON payment_events (provider_code, event_key);
         CREATE INDEX payment_events_order_idx ON payment_events (order_id, created_at);
         CREATE INDEX payment_events_unprocessed_idx ON payment_events (created_at) WHERE processed_at IS NULL;`,
        { transaction }
      );

      await queryInterface.addColumn('orders', 'payment_expires_at', { type: DataTypes.DATE, allowNull: true }, { transaction });
      await queryInterface.addColumn('orders', 'payment_token_hash', { type: DataTypes.STRING(64), allowNull: true }, { transaction });
      await queryInterface.addColumn('orders', 'completion_context', { type: DataTypes.JSONB, allowNull: true }, { transaction });
      // The sweep's work list: unpaid online orders by expiry.
      await queryInterface.sequelize.query(
        `CREATE INDEX orders_payment_expires_idx ON orders (payment_expires_at)
          WHERE payment_expires_at IS NOT NULL AND cancelled_at IS NULL;`,
        { transaction }
      );
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query('DROP INDEX IF EXISTS orders_payment_expires_idx;', { transaction });
      await queryInterface.removeColumn('orders', 'completion_context', { transaction });
      await queryInterface.removeColumn('orders', 'payment_token_hash', { transaction });
      await queryInterface.removeColumn('orders', 'payment_expires_at', { transaction });
      await queryInterface.dropTable('payment_events', { transaction });
      await queryInterface.sequelize.query(
        `DROP INDEX IF EXISTS payments_provider_transaction_idx;
         DROP INDEX IF EXISTS payments_provider_order_uniq;
         ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_mode_check;`,
        { transaction }
      );
      for (const column of [
        'last_inquired_at',
        'paid_at',
        'expires_at',
        'return_url',
        'redirect_url',
        'provider_transaction_id',
        'provider_order_id',
        'mode',
        'method',
      ]) {
        await queryInterface.removeColumn('payments', column, { transaction });
      }
      await queryInterface.dropTable('payment_gateway_accounts', { transaction });
    });
  },
};
