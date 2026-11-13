'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Cart rewards (modules/cartRewards, CART_REWARDS_ENABLED): spend thresholds
 * in the store's cart that unlock a discount or free shipping. Nothing here is
 * read or written while the flag is off.
 *
 * cart_reward_settings   one row per store, made the first time it saves the
 *                        section; a store with no row has the feature off.
 *   enabled                 the store shows the bar and the checkout gives the reward
 *   allow_coupon_stacking   a coupon (or automatic discount) and the reward both
 *                           apply; off (the default), only the bigger one does
 *   tiers                   [{ thresholdAmount, type: percent | fixed |
 *                           free_shipping, value, label: { ar, en } | null }],
 *                           at most 6, minor units except a percent's value (1–100)
 *   trust_items             [{ text: { ar, en }, enabled }]: the lines under the
 *                           checkout button, only what the merchant wrote
 *
 * The reward an order got is kept in its discounts_snapshot (kind
 * 'cart_reward'), next to the coupon and bundle entries: nothing is added to
 * the orders table.
 *
 * Additive and run-twice safe: a new table, made only when missing. down drops it.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await qi.createTable('cart_reward_settings', {
      workspace_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      allow_coupon_stacking: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      tiers: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      trust_items: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.dropTable('cart_reward_settings');
  },
};
