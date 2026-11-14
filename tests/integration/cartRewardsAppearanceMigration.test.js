'use strict';

// Migration 750 (the cart rewards bar's look): up, down and up again on the
// real test database, twice each way without an error. A store's row from
// before keeps its settings and reads its look as null (the theme's). It
// ends applied, as the other tests expect.

const db = require('../../src/db/models');
const migration = require('../../src/db/migrations/750-cart-reward-bar-appearance');
const { setupWorkspaceWithProduct } = require('../helpers/factories');

const qi = db.sequelize.getQueryInterface();
const select = (sql, replacements = {}) => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });
const column = async () =>
  (await select("SELECT data_type, column_default, is_nullable FROM information_schema.columns WHERE table_name = 'cart_reward_settings' AND column_name = 'bar_appearance'"))[0] || null;

it('goes up, down and up again, and a second run either way changes nothing', async () => {
  try {
    expect(await column()).toEqual({ data_type: 'jsonb', column_default: null, is_nullable: 'YES' });
    await migration.down(qi, db.Sequelize);
    expect(await column()).toBeNull();
    await migration.down(qi, db.Sequelize);

    // A store that saved its rewards before the column existed.
    const { workspace } = await setupWorkspaceWithProduct();
    await db.sequelize.query(
      `INSERT INTO cart_reward_settings (workspace_id, enabled, allow_coupon_stacking, tiers, trust_items, created_at, updated_at)
       VALUES (:ws, true, false, '[{"thresholdAmount":50000,"type":"free_shipping"}]', '[]', NOW(), NOW())`,
      { replacements: { ws: workspace.id } }
    );

    await migration.up(qi, db.Sequelize);
    await migration.up(qi, db.Sequelize);
    expect(await column()).toEqual({ data_type: 'jsonb', column_default: null, is_nullable: 'YES' });
    const [row] = await select('SELECT enabled, tiers, bar_appearance FROM cart_reward_settings WHERE workspace_id = :ws', { ws: workspace.id });
    expect(row).toEqual({ enabled: true, tiers: [{ thresholdAmount: 50000, type: 'free_shipping' }], bar_appearance: null });
  } finally {
    // Whatever happened, leave it applied for the tests that follow.
    await migration.up(qi, db.Sequelize);
  }
});
