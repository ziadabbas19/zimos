'use strict';

const { createIndexConcurrently, dropIndexConcurrently } = require('../concurrentIndex');

/**
 * The bell's two reads, made on every dashboard page load and every 20
 * seconds after (notifications/merchantNotificationService summary). Measured
 * on a store with 60,000 notifications (REPORT-dashboard-bootstrap.md has the
 * plans): both read every notification the store ever had.
 *
 * notifications_unread_idx (workspace_id, user_id) WHERE read_at IS NULL
 *   The unread count: only the store's unread rows, read from the index
 *   alone (10.8 ms -> 1.6 ms).
 *
 * notifications_type_created_idx (workspace_id, type, created_at DESC)
 *   The newest new-order notification (which rings the chime): read from
 *   the newest end and stopped at the first match, instead of sorting all
 *   of the store's order notifications (18 ms -> 0.06 ms).
 *
 * Built CONCURRENTLY (no write lock on notifications while they build;
 * db/concurrentIndex drops and rebuilds an invalid leftover) and run twice
 * safely. No data is changed; down drops the two indexes.
 */

const INDEXES = [
  { name: 'notifications_unread_idx', table: 'notifications', definition: '(workspace_id, user_id) WHERE read_at IS NULL' },
  { name: 'notifications_type_created_idx', table: 'notifications', definition: '(workspace_id, type, created_at DESC)' },
];

module.exports = {
  up: async (queryInterface) => {
    for (const index of INDEXES) await createIndexConcurrently(queryInterface, index);
  },

  down: async (queryInterface) => {
    for (const index of [...INDEXES].reverse()) await dropIndexConcurrently(queryInterface, index.name);
  },
};
