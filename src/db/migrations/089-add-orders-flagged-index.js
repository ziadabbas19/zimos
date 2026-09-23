'use strict';

/**
 * The index behind GET /workspaces/:ws/fraud/flagged-orders: one workspace's
 * orders that carry at least one risk flag, newest first.
 *
 * Same (workspace_id, created_at DESC, id DESC) shape as
 * orders_workspace_created_idx (087), so the keyset page is an ordered scan
 * that stops at LIMIT — but partial, holding only flagged orders. Flagged
 * orders are a small slice of a workspace's orders; without the predicate the
 * page would walk 087's index through every unflagged order between two
 * flagged ones and throw each away after a heap visit.
 *
 * risk_flags is varchar(255)[] (030-create-orders), NOT NULL with default
 * '{}'. `cardinality(...) > 0` rather than `<> '{}'`: cardinality is 0 for an
 * empty array of any dimension, and the list query spells the predicate the
 * same way, which is what lets the planner prove the query implies the index
 * predicate and pick it.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `CREATE INDEX orders_workspace_flagged_idx
         ON orders (workspace_id, created_at DESC, id DESC)
         WHERE cardinality(risk_flags) > 0`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('orders', 'orders_workspace_flagged_idx');
  },
};
