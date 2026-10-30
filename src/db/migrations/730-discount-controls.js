'use strict';

const { guarded } = require('../migrationGuards');

/**
 * The merchant's full control over a store coupon (modules/discounts). Every
 * column's default is what a coupon did before it existed, so every coupon
 * that exists today works exactly as it did:
 *
 *   audience               who may use it: 'any' (as before), 'new' (a phone
 *                          with no earlier order of the store that was not
 *                          cancelled) or 'existing' (one with such an order).
 *                          The same words as referral codes (migration 725)
 *   customer_phones        only these phones (normalized), on top of
 *                          customer_restrictions; empty = no such limit
 *   vip_tier_ids           only customers in these VIP tiers (vipTiers);
 *                          empty = no such limit
 *   schedule               { days: [0-6, 0 = Sunday], startMinute, endMinute }
 *                          in Cairo time, between starts_at and ends_at; NULL =
 *                          any time
 *   max_discount_amount    a percentage code takes at most this (minor units)
 *   min_quantity           the covered pieces the order must hold
 *   excluded_product_ids   never discounted, whatever else covers them
 *   applies_to_shipping    the code also comes off the delivery fee
 *   applies_to_discounted  lines already sold below their list price (a sale
 *                          price, a quantity bundle) are covered (true, as
 *                          before) or left out
 *   combines_with_offers   lines of an offer, an order bump or an upsell are
 *                          covered (true, as before) or left out
 *   strict_customer_limit  per_customer_limit counts the customer's phone
 *                          (false, as before) or also their e-mail and device
 *
 * Run-twice safe (every column and the constraint checked first); down
 * removes everything added here.
 */

const COLUMNS = [
  'audience',
  'customer_phones',
  'vip_tier_ids',
  'schedule',
  'max_discount_amount',
  'min_quantity',
  'excluded_product_ids',
  'applies_to_shipping',
  'applies_to_discounted',
  'combines_with_offers',
  'strict_customer_limit',
];

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await qi.addColumn('discounts', 'audience', { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'any' });
    await qi.addColumn('discounts', 'customer_phones', { type: DataTypes.ARRAY(DataTypes.STRING(32)), allowNull: false, defaultValue: [] });
    await qi.addColumn('discounts', 'vip_tier_ids', { type: DataTypes.ARRAY(DataTypes.STRING(64)), allowNull: false, defaultValue: [] });
    await qi.addColumn('discounts', 'schedule', { type: DataTypes.JSONB, allowNull: true });
    await qi.addColumn('discounts', 'max_discount_amount', { type: DataTypes.BIGINT, allowNull: true });
    await qi.addColumn('discounts', 'min_quantity', { type: DataTypes.INTEGER, allowNull: true });
    await qi.addColumn('discounts', 'excluded_product_ids', { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] });
    await qi.addColumn('discounts', 'applies_to_shipping', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    await qi.addColumn('discounts', 'applies_to_discounted', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true });
    await qi.addColumn('discounts', 'combines_with_offers', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true });
    await qi.addColumn('discounts', 'strict_customer_limit', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });

    await queryInterface.sequelize.query('ALTER TABLE discounts DROP CONSTRAINT IF EXISTS discounts_controls_check');
    await queryInterface.sequelize.query(
      `ALTER TABLE discounts ADD CONSTRAINT discounts_controls_check CHECK (
         audience IN ('any', 'new', 'existing')
         AND (max_discount_amount IS NULL OR max_discount_amount >= 1)
         AND (min_quantity IS NULL OR min_quantity >= 1)
       )`
    );
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await queryInterface.sequelize.query('ALTER TABLE discounts DROP CONSTRAINT IF EXISTS discounts_controls_check');
    for (const column of [...COLUMNS].reverse()) await qi.removeColumn('discounts', column);
  },
};
