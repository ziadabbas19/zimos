'use strict';

// Migration 748 (email campaigns): up, down and up again on the real test
// database, and a second up that changes nothing. It ends applied, as the
// other tests expect.

const db = require('../../src/db/models');
const migration = require('../../src/db/migrations/748-email-campaigns');

const qi = db.sequelize.getQueryInterface();
const tableExists = async (name) => (await db.sequelize.query('SELECT to_regclass(:name) AS oid', { replacements: { name: `public.${name}` }, type: db.Sequelize.QueryTypes.SELECT }))[0].oid !== null;
const column = async () =>
  (await db.sequelize.query("SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'plans' AND column_name = 'max_campaign_emails_per_month'", { type: db.Sequelize.QueryTypes.SELECT }))[0] || null;

it('goes up, down and up again, and a second up adds nothing', async () => {
  try {
    await roundTrip();
  } finally {
    // Whatever happened, leave it applied for the tests that follow.
    await migration.up(qi, db.Sequelize);
  }
});

async function roundTrip() {
  expect(await tableExists('email_campaigns')).toBe(true);
  await migration.down(qi, db.Sequelize);
  expect(await tableExists('email_campaigns')).toBe(false);
  expect(await tableExists('email_campaign_recipients')).toBe(false);
  expect(await column()).toBeNull();
  // Down twice: nothing left to drop, no error.
  await migration.down(qi, db.Sequelize);

  await db.sequelize.query("INSERT INTO plans (id, key, name, monthly_price_amount, yearly_price_amount, features, created_at, updated_at) VALUES (gen_random_uuid(), 'mig-748', 'Before 748', 0, 0, '[]', NOW(), NOW())");
  await migration.up(qi, db.Sequelize);
  await migration.up(qi, db.Sequelize);
  expect(await tableExists('email_campaigns')).toBe(true);
  expect(await tableExists('email_campaign_recipients')).toBe(true);
  expect(await column()).toEqual({ column_default: '0', is_nullable: 'YES' });
  // A plan that existed before gets 0: nothing can be sent until the console sets a number.
  const [plan] = await db.sequelize.query("SELECT max_campaign_emails_per_month AS max FROM plans WHERE key = 'mig-748'", { type: db.Sequelize.QueryTypes.SELECT });
  expect(plan.max).toBe(0);
  const checks = await db.sequelize.query("SELECT conname FROM pg_constraint WHERE conname LIKE 'email_campaign%_check' ORDER BY conname", { type: db.Sequelize.QueryTypes.SELECT });
  expect(checks.map((c) => c.conname)).toEqual([
    'email_campaign_recipients_delivery_check',
    'email_campaign_recipients_status_check',
    'email_campaigns_locale_check',
    'email_campaigns_status_check',
  ]);
  await expect(db.sequelize.query("INSERT INTO email_campaigns (id, workspace_id, name, status) VALUES (gen_random_uuid(), gen_random_uuid(), 'x', 'weird')")).rejects.toThrow();
}
