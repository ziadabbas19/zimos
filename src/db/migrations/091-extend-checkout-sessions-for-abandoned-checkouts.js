'use strict';

/**
 * Turns checkout_sessions (created in 029, never written by any code until
 * now) into the store behind abandoned-checkout capture: the public autosave
 * upserts one row per visitor, an order converts it, and the merchant list
 * derives "abandoned" at read time (see checkoutSessionStatus.js).
 *
 * Existing rows are deleted, not backfilled. Nothing has ever written this
 * table, so any row in it was put there by hand; none carries the priced
 * items, subtotal or normalized phone the new NOT NULL columns need, and an
 * invented phone would make conversion matching (by phone) attach real orders
 * to junk. An empty table was confirmed in dev and test when this was written.
 *
 * cart_id becomes nullable: Buy Now and funnel checkouts have no cart.
 *
 * last_activity_at gets a real now() default. 029 declared `defaultValue: {}`,
 * which Sequelize froze into the timestamp the migration happened to run at.
 * down() leaves now() in place — restoring a per-database frozen instant would
 * be reinstating a bug, not reversing a change.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });

      await q('DELETE FROM checkout_sessions');

      await q('ALTER TABLE checkout_sessions ALTER COLUMN cart_id DROP NOT NULL');
      await q('ALTER TABLE checkout_sessions ALTER COLUMN last_activity_at SET DEFAULT now()');

      await queryInterface.addColumn(
        'checkout_sessions',
        'phone_normalized',
        { type: Sequelize.STRING(32), allowNull: false },
        { transaction }
      );
      await queryInterface.addColumn(
        'checkout_sessions',
        'items',
        { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        { transaction }
      );
      await queryInterface.addColumn(
        'checkout_sessions',
        'subtotal_amount',
        { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        { transaction }
      );
      await queryInterface.addColumn(
        'checkout_sessions',
        'currency',
        { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'EGP' },
        { transaction }
      );
      await queryInterface.addColumn(
        'checkout_sessions',
        'source',
        { type: Sequelize.ENUM('store', 'funnel'), allowNull: false, defaultValue: 'store' },
        { transaction }
      );
      await queryInterface.addColumn(
        'checkout_sessions',
        'recovery_status',
        {
          type: Sequelize.ENUM('not_contacted', 'contacted', 'recovered', 'lost'),
          allowNull: false,
          defaultValue: 'not_contacted',
        },
        { transaction }
      );
      await queryInterface.addColumn(
        'checkout_sessions',
        'contacted_at',
        { type: Sequelize.DATE, allowNull: true },
        { transaction }
      );

      // The merchant list: one workspace, newest activity first, keyset on
      // (last_activity_at, id).
      await q(
        'CREATE INDEX checkout_sessions_workspace_activity_idx ON checkout_sessions (workspace_id, last_activity_at DESC, id DESC)'
      );
      // Conversion matching: same phone in the same workspace.
      await q('CREATE INDEX checkout_sessions_workspace_phone_idx ON checkout_sessions (workspace_id, phone_normalized)');
      // The autosave's ON CONFLICT arbiter: at most one open session per
      // visitor. Converted rows fall out of it, so a later visit inserts anew.
      await q(
        `CREATE UNIQUE INDEX checkout_sessions_workspace_visitor_open_uidx
           ON checkout_sessions (workspace_id, visitor_id)
          WHERE status = 'in_progress' AND visitor_id IS NOT NULL`
      );
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });

      await q('DROP INDEX IF EXISTS checkout_sessions_workspace_visitor_open_uidx');
      await q('DROP INDEX IF EXISTS checkout_sessions_workspace_phone_idx');
      await q('DROP INDEX IF EXISTS checkout_sessions_workspace_activity_idx');

      for (const column of ['contacted_at', 'recovery_status', 'source', 'currency', 'subtotal_amount', 'items', 'phone_normalized']) {
        await queryInterface.removeColumn('checkout_sessions', column, { transaction });
      }
      await q('DROP TYPE IF EXISTS "enum_checkout_sessions_recovery_status"');
      await q('DROP TYPE IF EXISTS "enum_checkout_sessions_source"');

      // Cartless sessions (Buy Now, funnels) cannot satisfy the old NOT NULL.
      await q('DELETE FROM checkout_sessions WHERE cart_id IS NULL');
      await q('ALTER TABLE checkout_sessions ALTER COLUMN cart_id SET NOT NULL');
    });
  },
};
