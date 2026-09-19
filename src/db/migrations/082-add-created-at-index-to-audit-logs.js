'use strict';

/**
 * GET /admin/audit-log is the first reader of audit_logs, and its default
 * query is platform-wide: ORDER BY created_at DESC, id DESC with no
 * workspace filter. The existing (workspace_id, created_at) index can't
 * serve that — created_at is the second column — so without this the log
 * page degrades into a full sort of the table as it grows.
 *
 * `id` is in the index because it is the tiebreak in the same ORDER BY:
 * created_at defaults to NOW(), so entries written by one request share a
 * timestamp, and paging over them needs a stable total order.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.addIndex('audit_logs', ['created_at', 'id'], {
      name: 'audit_logs_created_at_id_idx',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('audit_logs', 'audit_logs_created_at_id_idx');
  },
};
