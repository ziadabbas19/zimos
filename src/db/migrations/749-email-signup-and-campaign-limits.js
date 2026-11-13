'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Where shoppers sign up for a store's marketing emails, and two more limits
 * on email campaigns (modules/emailCampaigns, EMAIL_CAMPAIGNS_ENABLED). Nothing
 * here is read or written while the flag is off.
 *
 * The merchant's signup settings (which places show a box or a form, their
 * text, the popup's trigger) are one key of workspaces.settings
 * (`email_signup`, emailCampaigns/signupSettings.js), like the newsletter and
 * the social proof settings: no column or table for them.
 *
 * plans.max_campaigns_per_month      campaigns one store may send or schedule
 *                                    in a Cairo month. NULL = unlimited.
 * plans.max_recipients_per_campaign  the largest audience one campaign may
 *                                    have. NULL = unlimited.
 *   Existing plans get NULL for both: nothing changes for them.
 *
 * customers.marketing_consent_source  where the customer's current marketing
 *   consent was given: checkout | quick_order | cart | footer | popup. NULL for
 *   a consent from before (or from the newsletter, a form, a funnel, their
 *   account or the merchant).
 *
 * email_subscribers   an address that signed up from the footer or the popup
 *   while the store had no customer with it: a lightweight subscriber (the
 *   customers table needs a phone). One row per address per store. Once a
 *   customer with the address exists, the customer's own consent is the one
 *   that counts (emailCampaigns/consent.js, campaignAudience.js).
 *
 * customers_workspace_email_idx  (workspace_id, lower(trim(email))): the
 *   signup's lookup by address, and the audience leaving out subscribers who
 *   are customers. Built CONCURRENTLY: customers is a large table.
 *
 * Additive and run-twice safe: columns, the table, constraints and indexes
 * made only when missing. down removes them.
 */

const SOURCES = ['checkout', 'quick_order', 'cart', 'footer', 'popup'];
const list = (values) => values.map((v) => `'${v}'`).join(', ');
const EMAIL_INDEX = 'customers_workspace_email_idx';

async function one(sequelize, sql, replacements) {
  const [rows] = await sequelize.query(sql, { replacements });
  return rows[0] || null;
}

const constraintExists = (sequelize, name) => one(sequelize, 'SELECT 1 AS present FROM pg_constraint WHERE conname = :name', { name }).then(Boolean);

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { sequelize } = queryInterface;
    const { DataTypes } = Sequelize;

    await qi.addColumn('plans', 'max_campaigns_per_month', { type: DataTypes.INTEGER, allowNull: true });
    await qi.addColumn('plans', 'max_recipients_per_campaign', { type: DataTypes.INTEGER, allowNull: true });
    // Like the plans' other limits: never below zero, an audience of at least one.
    const planChecks = [
      ['plans_max_campaigns_per_month_check', 'max_campaigns_per_month IS NULL OR max_campaigns_per_month >= 0'],
      ['plans_max_recipients_per_campaign_check', 'max_recipients_per_campaign IS NULL OR max_recipients_per_campaign >= 1'],
    ];
    for (const [name, expression] of planChecks) {
      if (!(await constraintExists(sequelize, name))) await sequelize.query(`ALTER TABLE plans ADD CONSTRAINT ${name} CHECK (${expression})`);
    }

    // Nullable, no default: a catalogue change only, whatever the table's size.
    await qi.addColumn('customers', 'marketing_consent_source', { type: DataTypes.STRING(20), allowNull: true });
    if (!(await constraintExists(sequelize, 'customers_marketing_consent_source_check'))) {
      // NOT VALID, then VALIDATE: the scan runs without blocking writes to customers.
      await sequelize.query(
        `ALTER TABLE customers ADD CONSTRAINT customers_marketing_consent_source_check
           CHECK (marketing_consent_source IS NULL OR marketing_consent_source IN (${list(SOURCES)})) NOT VALID`
      );
      await sequelize.query('ALTER TABLE customers VALIDATE CONSTRAINT customers_marketing_consent_source_check');
    }

    await qi.createTable('email_subscribers', {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      // Lowercased and trimmed.
      email: { type: DataTypes.STRING(255), allowNull: false },
      marketing_consent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      source: { type: DataTypes.STRING(20), allowNull: false },
      consented_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    if (!(await constraintExists(sequelize, 'email_subscribers_source_check'))) {
      await sequelize.query(`ALTER TABLE email_subscribers ADD CONSTRAINT email_subscribers_source_check CHECK (source IN (${list(SOURCES)}))`);
    }
    // A new, empty table: plain CREATE INDEX (guarded() builds CONCURRENTLY only on a table it did not create).
    await qi.addIndex('email_subscribers', ['workspace_id', 'email'], { name: 'email_subscribers_workspace_email_key', unique: true });

    // An expression index, so by hand: CONCURRENTLY (outside any transaction), and
    // an invalid leftover of a build that died half way is dropped and built again.
    const state = await one(
      sequelize,
      "SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = :name AND c.relkind = 'i'",
      { name: EMAIL_INDEX }
    );
    if (!state || !state.valid) {
      if (state) await sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS ${EMAIL_INDEX}`);
      await sequelize.query(`CREATE INDEX CONCURRENTLY ${EMAIL_INDEX} ON customers (workspace_id, lower(trim(email))) WHERE email IS NOT NULL`);
    }
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    const { sequelize } = queryInterface;
    await sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS ${EMAIL_INDEX}`);
    await qi.dropTable('email_subscribers');
    await sequelize.query('ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_marketing_consent_source_check');
    await qi.removeColumn('customers', 'marketing_consent_source');
    await sequelize.query('ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_max_recipients_per_campaign_check');
    await sequelize.query('ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_max_campaigns_per_month_check');
    await qi.removeColumn('plans', 'max_recipients_per_campaign');
    await qi.removeColumn('plans', 'max_campaigns_per_month');
  },
};
