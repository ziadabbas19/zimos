'use strict';

/**
 * Weight tiers and the per-zone price of each tier.
 *
 * shipping_weight_tiers: a workspace's tiers, stored as inclusive upper bounds
 * in grams, ordered by `position`. A tier covers (previous bound, up_to_grams];
 * the first one starts at 0. Only the last tier may have a NULL bound (open
 * ended). The ordering rules are enforced by the service that replaces the
 * whole set at once, not by constraints: a replace moves bounds between rows,
 * and row-by-row constraint checks would reject valid intermediate states.
 *
 * shipping_zone_tier_prices: what a zone charges for a tier, in minor units.
 * One row per (zone, tier); deleting either side deletes the price.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'shipping_weight_tiers',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
          workspace_id: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'workspaces', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          up_to_grams: { type: DataTypes.INTEGER, allowNull: true },
          position: { type: DataTypes.INTEGER, allowNull: false },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
          updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );
      await queryInterface.addIndex('shipping_weight_tiers', ['workspace_id', 'position'], {
        name: 'shipping_weight_tiers_workspace_position_idx',
        transaction,
      });

      await queryInterface.createTable(
        'shipping_zone_tier_prices',
        {
          id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
          workspace_id: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'workspaces', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          zone_id: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'shipping_zones', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          tier_id: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'shipping_weight_tiers', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          amount: { type: DataTypes.BIGINT, allowNull: false },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
          updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );
      await queryInterface.addIndex('shipping_zone_tier_prices', ['zone_id', 'tier_id'], {
        unique: true,
        name: 'shipping_zone_tier_prices_zone_tier_unique',
        transaction,
      });
      await queryInterface.addIndex('shipping_zone_tier_prices', ['tier_id'], {
        name: 'shipping_zone_tier_prices_tier_idx',
        transaction,
      });
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('shipping_zone_tier_prices', { transaction });
      await queryInterface.dropTable('shipping_weight_tiers', { transaction });
    });
  },
};
