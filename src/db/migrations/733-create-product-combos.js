'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Combos: different products sold together at one price (modules/combos,
 * PRODUCT_COMBOS_ENABLED). Nothing here is read or written while the flag is
 * off.
 *
 * product_combos        name, picture, status (draft | active | archived),
 *                       pricing_mode fixed_price (price_value = what one combo
 *                       costs, minor units) | percent_off (basis points off the
 *                       components' total) | amount_off (minor units off it),
 *                       show_on_product_ids (empty = every component's page)
 * product_combo_items   one component: a product, either a fixed variant or
 *                       pick_variant (the shopper chooses one of its
 *                       variants), and how many. product_id / variant_id go
 *                       NULL when the product or variant is deleted for good:
 *                       the combo then stops selling until the merchant fixes it
 * cart_items            combo_id + combo_selection: one cart line for a whole
 *                       combo; variant_id holds its first component's variant
 * order_items           combo_id, combo_key (the lines of one combo bought
 *                       once share it) and combo_name_snapshot. A combo is
 *                       written as one ordinary line per component, so stock,
 *                       returns, shipping, tax and reports work per product;
 *                       the combo's saving is spread over its lines'
 *                       line_discount_amount. Nullable, no default: adding them
 *                       to the large order_items table is a catalogue change
 *                       only, and no index is built on it here.
 *
 * Run-twice safe. down refuses while an order line belongs to a combo (the
 * code before this migration would show those lines with no combo), then
 * removes everything added here.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const timestamps = {
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    };

    await qi.createTable('product_combos', {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      name: { type: DataTypes.STRING(200), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      image_url: { type: DataTypes.STRING(1000), allowNull: true },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'draft' },
      pricing_mode: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'fixed_price' },
      price_value: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      show_on_product_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      ...timestamps,
    });
    await queryInterface.sequelize.query('ALTER TABLE product_combos DROP CONSTRAINT IF EXISTS product_combos_check');
    await queryInterface.sequelize.query(
      `ALTER TABLE product_combos ADD CONSTRAINT product_combos_check CHECK (
         status IN ('draft', 'active', 'archived')
         AND pricing_mode IN ('fixed_price', 'percent_off', 'amount_off')
         AND price_value >= 0
         AND (pricing_mode <> 'percent_off' OR price_value <= 10000)
       )`
    );
    await qi.addIndex('product_combos', ['workspace_id', 'status'], { name: 'product_combos_workspace_status_idx' });

    await qi.createTable('product_combo_items', {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      combo_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'product_combos', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      product_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'products', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
      variant_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'product_variants', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
      pick_variant: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      ...timestamps,
    });
    await queryInterface.sequelize.query('ALTER TABLE product_combo_items DROP CONSTRAINT IF EXISTS product_combo_items_check');
    await queryInterface.sequelize.query('ALTER TABLE product_combo_items ADD CONSTRAINT product_combo_items_check CHECK (quantity BETWEEN 1 AND 100)');
    await qi.addIndex('product_combo_items', ['combo_id', 'position'], { name: 'product_combo_items_combo_idx' });
    await qi.addIndex('product_combo_items', ['product_id'], { name: 'product_combo_items_product_idx' });

    await qi.addColumn('cart_items', 'combo_id', { type: DataTypes.UUID, allowNull: true, references: { model: 'product_combos', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' });
    await qi.addColumn('cart_items', 'combo_selection', { type: DataTypes.JSONB, allowNull: true });

    await qi.addColumn('order_items', 'combo_id', { type: DataTypes.UUID, allowNull: true });
    await qi.addColumn('order_items', 'combo_key', { type: DataTypes.STRING(40), allowNull: true });
    await qi.addColumn('order_items', 'combo_name_snapshot', { type: DataTypes.STRING(200), allowNull: true });
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    const [[{ present }]] = await queryInterface.sequelize.query(
      "SELECT COUNT(*)::int AS present FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'order_items' AND column_name = 'combo_key'"
    );
    if (present) {
      const [[{ lines }]] = await queryInterface.sequelize.query('SELECT COUNT(*)::int AS lines FROM order_items WHERE combo_key IS NOT NULL');
      if (lines > 0) throw new Error(`733 down: ${lines} order line(s) belong to a combo; the code before this migration cannot show them as one.`);
    }
    await qi.removeColumn('order_items', 'combo_name_snapshot');
    await qi.removeColumn('order_items', 'combo_key');
    await qi.removeColumn('order_items', 'combo_id');
    await queryInterface.sequelize.query('DELETE FROM cart_items WHERE combo_id IS NOT NULL').catch(() => null);
    await qi.removeColumn('cart_items', 'combo_selection');
    await qi.removeColumn('cart_items', 'combo_id');
    await qi.dropTable('product_combo_items');
    await qi.dropTable('product_combos');
  },
};
