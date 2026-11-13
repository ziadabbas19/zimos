'use strict';

const { guarded } = require('../migrationGuards');

/**
 * The look of the cart rewards bar (cartRewards/barAppearance.js), kept with
 * the store's cart rewards settings:
 *
 * cart_reward_settings.bar_appearance   JSONB NULL, no default
 *   { mode: 'inherit' | 'custom', custom: { shape, corners, fillColor,
 *     trackColor, marker, markerSize, showAmounts, reachedPop, showMessage,
 *     messageAlign } | null }
 *   NULL (every row that exists today) reads as `inherit`: the bar as it has
 *   always looked, so no store sees a change until its merchant picks one.
 *
 * Each reward's icon rides on its tier inside the existing `tiers` JSONB
 * (tiers[].icon), so it needs nothing here.
 *
 * Additive and run-twice safe: a nullable column without a default (a catalog
 * change, no table rewrite), added only when missing. down drops it.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.addColumn('cart_reward_settings', 'bar_appearance', { type: Sequelize.DataTypes.JSONB, allowNull: true });
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.removeColumn('cart_reward_settings', 'bar_appearance');
  },
};
