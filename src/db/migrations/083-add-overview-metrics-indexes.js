'use strict';

/**
 * Indexes for the two window scans behind GET /admin/metrics/overview.
 *
 * Both queries are platform-wide and bounded only by time, so none of the
 * existing indexes on these tables can serve them: every one of them leads
 * with `workspace_id` (see 030-create-orders and 038-create-shipments), which
 * a query with no workspace filter cannot use. Today that means a sequential
 * scan of the whole table on every dashboard load.
 *
 * Built now, while both tables are small, precisely so the build itself is
 * cheap: a plain CREATE INDEX takes a write lock for as long as it runs, and
 * on tables this size that is milliseconds. Adding the same indexes once
 * orders are in the millions would mean CREATE INDEX CONCURRENTLY, which
 * cannot run inside a migration transaction and can leave an invalid index
 * behind when it fails.
 */
module.exports = {
  up: async (queryInterface) => {
    // `WHERE created_at >= :since` over a rolling 30 days, feeding ordersPerDay,
    // ordersToday and gmv30d.
    //
    // `created_at` alone, not (created_at, workspace_id): the query groups by
    // day and currency and never filters by workspace, so a second column
    // would only widen the index without narrowing the scan. Cancelled orders
    // are left in it rather than made a partial `WHERE cancelled_at IS NULL`,
    // so that any later "recent orders" query — cancelled ones included — can
    // still use it; excluding them costs one cheap heap-side filter.
    await queryInterface.addIndex('orders', ['created_at'], {
      name: 'orders_created_at_idx',
    });

    // `WHERE status IN ('delivered','failed','returned') AND updated_at >= :since`,
    // feeding deliveryRate and the high-RTO attention rows.
    //
    // `status` leads deliberately, even though `updated_at` is the window
    // column. Three of the eight shipment statuses are terminal, and the
    // in-flight ones are the rows touched most often — every carrier status
    // callback rewrites `updated_at` — so an index on `updated_at` alone would
    // return mostly rows this query immediately discards. Leading with status
    // turns it into three range scans that each return only matching rows.
    //
    // Measured on 500k synthetic shipments with ~35% in a terminal state and
    // updates spread over 120 days: (updated_at) alone read 125k index entries
    // to answer with 55k (49ms); (status, updated_at) read exactly the 55k
    // (41ms).
    //
    // A covering `INCLUDE (workspace_id)` was measured too and is faster again
    // — 19ms, an index-only scan with no heap access at all — but it is not
    // taken here. INCLUDE disables btree deduplication, which took the index
    // from 3.5MB to 24MB on that same data, and shipments is a write-hot table
    // that pays for every extra index byte on each carrier callback. Saving
    // 20ms on a dashboard nobody loads in a loop does not buy that, and the
    // index-only scan would decay toward these numbers anyway whenever the
    // visibility map lags behind the writes. Worth revisiting only if this
    // endpoint actually shows up as slow.
    await queryInterface.addIndex('shipments', ['status', 'updated_at'], {
      name: 'shipments_status_updated_at_idx',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('shipments', 'shipments_status_updated_at_idx');
    await queryInterface.removeIndex('orders', 'orders_created_at_idx');
  },
};
