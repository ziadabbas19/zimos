'use strict';

/**
 * The index behind the merchant orders screen: one workspace's orders,
 * newest first.
 *
 * Until now GET /workspaces/:ws/orders ordered by `id` and paged on an `id`
 * cursor. Order ids are UUIDv4, so that ordering is random noise: the "first
 * page" of a merchant's orders was an arbitrary subset, and an order placed
 * today could sort before one from last month. The list now orders by
 * (created_at DESC, id DESC) — `id` only as a tie-breaker so two orders
 * created in the same millisecond still have one stable, total order for the
 * keyset cursor to page on.
 *
 * Both index columns are DESC to match that ORDER BY exactly. A btree can be
 * read backwards, so an all-ASC index would serve it too — but only if every
 * column flips together; (created_at DESC, id ASC) would match neither
 * direction and force a sort. Spelling both out is what keeps the scan
 * ordered and the LIMIT cheap.
 *
 * This is also the index the pipeline filters ride on: `stage`, `q`, `from`
 * and `to` are all evaluated as a filter over rows this index already
 * delivers in the right order, which lets a filtered page stop as soon as it
 * has its LIMIT rows instead of sorting the whole workspace.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.addIndex(
      'orders',
      [{ name: 'workspace_id' }, { name: 'created_at', order: 'DESC' }, { name: 'id', order: 'DESC' }],
      { name: 'orders_workspace_created_idx' }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('orders', 'orders_workspace_created_idx');
  },
};
