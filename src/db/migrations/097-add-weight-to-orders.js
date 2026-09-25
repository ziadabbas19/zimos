'use strict';

/**
 * Order weight, frozen at checkout like every other order snapshot.
 *
 * - orders.total_weight_grams: sum of the items' weights. NULL on orders
 *   placed before this migration, and when an item had no weight and the
 *   store had no default item weight to stand in for it.
 * - orders.weight_tier_snapshot: the tier the weight fell into
 *   ({ id, position, fromGrams, upToGrams, flags }), NULL when the store has
 *   no tiers. `flags` carries 'weight_over_last_tier' when the weight is
 *   above a closed last tier and was charged as that tier.
 * - orders.weight_estimated: true when at least one item's weight came from
 *   the store's default item weight rather than the variant.
 * - order_items.unit_weight_grams: the weight of one unit of the line (for
 *   an offer, one bundle: every offer line's variant × its quantity).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn('orders', 'total_weight_grams', { type: DataTypes.INTEGER, allowNull: true }, { transaction });
      await queryInterface.addColumn('orders', 'weight_tier_snapshot', { type: DataTypes.JSONB, allowNull: true }, { transaction });
      await queryInterface.addColumn(
        'orders',
        'weight_estimated',
        { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        { transaction }
      );
      await queryInterface.addColumn('order_items', 'unit_weight_grams', { type: DataTypes.INTEGER, allowNull: true }, { transaction });
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn('order_items', 'unit_weight_grams', { transaction });
      await queryInterface.removeColumn('orders', 'weight_estimated', { transaction });
      await queryInterface.removeColumn('orders', 'weight_tier_snapshot', { transaction });
      await queryInterface.removeColumn('orders', 'total_weight_grams', { transaction });
    });
  },
};
