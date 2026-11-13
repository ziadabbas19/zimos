'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Email campaigns (modules/emailCampaigns, EMAIL_CAMPAIGNS_ENABLED): a store
 * emails its own customers who agreed to marketing (customers.marketing_consent),
 * from the platform's sending address under the store's name. Nothing here is
 * read or written while the flag is off.
 *
 * plans.max_campaign_emails_per_month   the emails one store may send a month
 *   (Cairo time) on that plan. NULL = unlimited, like the other limits. Existing
 *   plans get 0: nothing can be sent until the console sets a number.
 *
 * email_campaigns            one row per campaign
 *   status                   draft | scheduled | sending | sent | failed | cancelled
 *   blocks                   the content as blocks (heading, text, image, button,
 *                            products, divider), rendered on the server only
 *   audience                 { type: all | segment | rfm | rules, ... }
 *   *_count                  moved only by the recipient row that changed, so
 *                            they never drift from the rows below
 *
 * email_campaign_recipients  one row per address a campaign goes to, made when
 *   sending starts: UNIQUE (campaign_id, email) is what keeps an address from
 *   being emailed twice by one campaign, whatever the worker does.
 *   handed_at                set just before the provider is called: a row left
 *                            'sending' without it was never handed over and is
 *                            put back in line after a restart; one with it is
 *                            failed as interrupted, never sent twice.
 *
 * Additive and run-twice safe: new tables made only when missing, the column
 * added only when missing, constraints and indexes by name. down drops them.
 */

const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'];
const RECIPIENT_STATUSES = ['queued', 'sending', 'sent', 'failed', 'skipped', 'cancelled'];
const DELIVERY_STATUSES = ['delivered', 'bounced', 'complained', 'undelivered'];
const list = (values) => values.map((v) => `'${v}'`).join(', ');

async function constraintExists(sequelize, name) {
  const [rows] = await sequelize.query('SELECT 1 FROM pg_constraint WHERE conname = :name', { replacements: { name } });
  return rows.length > 0;
}

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { sequelize } = queryInterface;
    const { DataTypes } = Sequelize;
    const counter = { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 };

    await qi.addColumn('plans', 'max_campaign_emails_per_month', { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 });

    await qi.createTable('email_campaigns', {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      name: { type: DataTypes.STRING(120), allowNull: false },
      subject: { type: DataTypes.STRING(200), allowNull: false, defaultValue: '' },
      preheader: { type: DataTypes.STRING(200), allowNull: true },
      blocks: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      locale: { type: DataTypes.STRING(5), allowNull: false, defaultValue: 'ar' },
      reply_to: { type: DataTypes.STRING(255), allowNull: true },
      audience: { type: DataTypes.JSONB, allowNull: false, defaultValue: { type: 'all' } },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
      scheduled_at: { type: DataTypes.DATE, allowNull: true },
      started_at: { type: DataTypes.DATE, allowNull: true },
      finished_at: { type: DataTypes.DATE, allowNull: true },
      cancelled_at: { type: DataTypes.DATE, allowNull: true },
      paused_until: { type: DataTypes.DATE, allowNull: true },
      failure_reason: { type: DataTypes.STRING(60), allowNull: true },
      recipients_count: counter,
      sent_count: counter,
      failed_count: counter,
      skipped_count: counter,
      delivered_count: counter,
      opened_count: counter,
      clicked_count: counter,
      bounced_count: counter,
      complained_count: counter,
      unsubscribed_count: counter,
      created_by_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await qi.createTable('email_campaign_recipients', {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
      campaign_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'email_campaigns', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      // The campaign's store, kept on the row: the daily cap and the monthly quota count by it.
      workspace_id: { type: DataTypes.UUID, allowNull: false },
      customer_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'customers', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      email: { type: DataTypes.STRING(255), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'queued' },
      attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
      next_attempt_at: { type: DataTypes.DATE, allowNull: true },
      claimed_at: { type: DataTypes.DATE, allowNull: true },
      handed_at: { type: DataTypes.DATE, allowNull: true },
      sent_at: { type: DataTypes.DATE, allowNull: true },
      provider: { type: DataTypes.STRING(20), allowNull: true },
      provider_message_id: { type: DataTypes.STRING(255), allowNull: true },
      error: { type: DataTypes.STRING(300), allowNull: true },
      delivery_status: { type: DataTypes.STRING(20), allowNull: true },
      delivered_at: { type: DataTypes.DATE, allowNull: true },
      opened_at: { type: DataTypes.DATE, allowNull: true },
      clicked_at: { type: DataTypes.DATE, allowNull: true },
      unsubscribed_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    const checks = [
      ['email_campaigns', 'email_campaigns_status_check', `status IN (${list(CAMPAIGN_STATUSES)})`],
      ['email_campaigns', 'email_campaigns_locale_check', "locale IN ('ar', 'en')"],
      ['email_campaign_recipients', 'email_campaign_recipients_status_check', `status IN (${list(RECIPIENT_STATUSES)})`],
      [
        'email_campaign_recipients',
        'email_campaign_recipients_delivery_check',
        `delivery_status IS NULL OR delivery_status IN (${list(DELIVERY_STATUSES)})`,
      ],
    ];
    for (const [table, name, expression] of checks) {
      if (!(await constraintExists(sequelize, name))) {
        await sequelize.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expression})`);
      }
    }

    // New, empty tables: plain CREATE INDEX (guarded() builds CONCURRENTLY only on a table it did not create).
    await qi.addIndex('email_campaigns', ['workspace_id', 'created_at'], { name: 'email_campaigns_workspace_created_idx' });
    await qi.addIndex('email_campaigns', ['scheduled_at'], {
      name: 'email_campaigns_due_idx',
      where: { status: 'scheduled' },
    });
    await qi.addIndex('email_campaign_recipients', ['campaign_id', 'email'], { name: 'email_campaign_recipients_campaign_email_key', unique: true });
    await qi.addIndex('email_campaign_recipients', ['campaign_id', 'status', 'next_attempt_at'], { name: 'email_campaign_recipients_queue_idx' });
    await qi.addIndex('email_campaign_recipients', ['workspace_id', 'created_at'], { name: 'email_campaign_recipients_quota_idx' });
    await qi.addIndex('email_campaign_recipients', ['workspace_id', 'handed_at'], {
      name: 'email_campaign_recipients_daily_idx',
      where: { handed_at: { [Sequelize.Op.ne]: null } },
    });
    await qi.addIndex('email_campaign_recipients', ['provider_message_id'], {
      name: 'email_campaign_recipients_message_idx',
      where: { provider_message_id: { [Sequelize.Op.ne]: null } },
    });
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.dropTable('email_campaign_recipients');
    await qi.dropTable('email_campaigns');
    await qi.removeColumn('plans', 'max_campaign_emails_per_month');
  },
};
