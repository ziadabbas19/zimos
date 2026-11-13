'use strict';

// Migration 749 (signup placement and campaign limits): up, down and up again
// on the real test database, twice each way without an error. A plan that
// existed before gets null (unlimited) for both new limits. It ends applied,
// as the other tests expect.

const db = require('../../src/db/models');
const migration = require('../../src/db/migrations/749-email-signup-and-campaign-limits');

const qi = db.sequelize.getQueryInterface();
const select = (sql, replacements = {}) => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });
const tableExists = async (name) => (await select('SELECT to_regclass(:name) AS oid', { name: `public.${name}` }))[0].oid !== null;
const columnOf = async (table, column) =>
  (await select('SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = :table AND column_name = :column', { table, column }))[0] || null;
const indexValid = async (name) => {
  const [row] = await select("SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = :name AND c.relkind = 'i'", { name });
  return row ? row.valid : null;
};
const constraints = async () =>
  (await select("SELECT conname FROM pg_constraint WHERE conname IN ('customers_marketing_consent_source_check', 'email_subscribers_source_check', 'plans_max_campaigns_per_month_check', 'plans_max_recipients_per_campaign_check') ORDER BY conname")).map(
    (r) => r.conname
  );

it('goes up, down and up again, and a second run either way changes nothing', async () => {
  try {
    await roundTrip();
  } finally {
    await db.sequelize.query("DELETE FROM plans WHERE key = 'mig-749'");
    // Whatever happened, leave it applied for the tests that follow.
    await migration.up(qi, db.Sequelize);
  }
});

async function roundTrip() {
  expect(await tableExists('email_subscribers')).toBe(true);
  await migration.down(qi, db.Sequelize);
  expect(await tableExists('email_subscribers')).toBe(false);
  expect(await columnOf('plans', 'max_campaigns_per_month')).toBeNull();
  expect(await columnOf('plans', 'max_recipients_per_campaign')).toBeNull();
  expect(await columnOf('customers', 'marketing_consent_source')).toBeNull();
  expect(await indexValid('customers_workspace_email_idx')).toBeNull();
  expect(await constraints()).toEqual([]);
  // Down twice: nothing left to remove, no error.
  await migration.down(qi, db.Sequelize);

  await db.sequelize.query(
    "INSERT INTO plans (id, key, name, monthly_price_amount, yearly_price_amount, features, created_at, updated_at) VALUES (gen_random_uuid(), 'mig-749', 'Before 749', 0, 0, '[]', NOW(), NOW())"
  );
  await migration.up(qi, db.Sequelize);
  await migration.up(qi, db.Sequelize);
  expect(await tableExists('email_subscribers')).toBe(true);
  expect(await columnOf('plans', 'max_campaigns_per_month')).toEqual({ column_default: null, is_nullable: 'YES' });
  expect(await columnOf('plans', 'max_recipients_per_campaign')).toEqual({ column_default: null, is_nullable: 'YES' });
  expect(await columnOf('customers', 'marketing_consent_source')).toEqual({ column_default: null, is_nullable: 'YES' });
  expect(await indexValid('customers_workspace_email_idx')).toBe(true);
  expect(await constraints()).toEqual([
    'customers_marketing_consent_source_check',
    'email_subscribers_source_check',
    'plans_max_campaigns_per_month_check',
    'plans_max_recipients_per_campaign_check',
  ]);
  // A plan from before: unlimited on both, nothing changes for it.
  const [plan] = await select("SELECT max_campaigns_per_month AS campaigns, max_recipients_per_campaign AS recipients FROM plans WHERE key = 'mig-749'");
  expect(plan).toEqual({ campaigns: null, recipients: null });
  // The checks hold.
  await expect(db.sequelize.query("UPDATE plans SET max_recipients_per_campaign = 0 WHERE key = 'mig-749'")).rejects.toThrow(/plans_max_recipients_per_campaign_check/);
  await expect(
    db.sequelize.query("INSERT INTO email_subscribers (id, workspace_id, email, source) VALUES (gen_random_uuid(), gen_random_uuid(), 'x@example.com', 'somewhere')")
  ).rejects.toThrow(/email_subscribers_source_check/);
}
