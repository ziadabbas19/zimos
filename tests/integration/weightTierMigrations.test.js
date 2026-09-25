'use strict';

// Migrations 096 (weight tiers + zone tier prices) and 097 (order weight
// columns) reverse cleanly and re-apply. Runs the migration modules directly
// against the test database; SequelizeMeta is not touched.

const { Sequelize } = require('sequelize');
const db = require('../../src/db/models');
const tiersMigration = require('../../src/db/migrations/096-create-shipping-weight-tiers');
const orderWeightMigration = require('../../src/db/migrations/097-add-weight-to-orders');

const qi = () => db.sequelize.getQueryInterface();

async function tableExists(name) {
  const [rows] = await db.sequelize.query('SELECT to_regclass($1) AS t', { bind: [`public.${name}`] });
  return rows[0].t !== null;
}

describe('migrations 096/097', () => {
  it('go down and come back up', async () => {
    await orderWeightMigration.down(qi(), Sequelize);
    await tiersMigration.down(qi(), Sequelize);

    expect(await tableExists('shipping_weight_tiers')).toBe(false);
    expect(await tableExists('shipping_zone_tier_prices')).toBe(false);
    const ordersDown = await qi().describeTable('orders');
    expect(ordersDown.total_weight_grams).toBeUndefined();
    expect(ordersDown.weight_tier_snapshot).toBeUndefined();
    expect(ordersDown.weight_estimated).toBeUndefined();
    expect((await qi().describeTable('order_items')).unit_weight_grams).toBeUndefined();

    await tiersMigration.up(qi(), Sequelize);
    await orderWeightMigration.up(qi(), Sequelize);

    expect(await tableExists('shipping_weight_tiers')).toBe(true);
    expect(await tableExists('shipping_zone_tier_prices')).toBe(true);
    const orders = await qi().describeTable('orders');
    expect(orders.total_weight_grams.allowNull).toBe(true);
    expect(orders.weight_tier_snapshot.type).toBe('JSONB');
    expect(orders.weight_estimated.allowNull).toBe(false);
    expect((await qi().describeTable('order_items')).unit_weight_grams.allowNull).toBe(true);
    const prices = await qi().describeTable('shipping_zone_tier_prices');
    expect(prices.amount.type).toBe('BIGINT');
  });
});
