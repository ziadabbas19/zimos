'use strict';

/**
 * Confirmation queue lifecycle: lock expiry, the Done history and outcome
 * corrections.
 *
 * - confirmation_attempts.source: where an outcome was recorded — the queue
 *   (a call), the order page (Confirm / Cancel order), or a correction of an
 *   earlier outcome. Existing rows are all queue calls.
 * - confirmation_attempts.previous_outcome: on a correction, the outcome it
 *   replaced. Null everywhere else.
 * - confirmation_tasks.completed_at: when the task reached `done`, so the Done
 *   tab sorts by when it finished rather than by its last write. Backfilled
 *   from updated_at for tasks already done.
 *
 * Indexes: (workspace_id, status, locked_at) serves the lazy lock-expiry sweep
 * and the In progress tab; (task_id, created_at) replaces the plain task_id
 * index, since every read of attempts is "this task's attempts, in order".
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'confirmation_attempts',
        'source',
        { type: Sequelize.ENUM('queue', 'order_page', 'correction'), allowNull: false, defaultValue: 'queue' },
        { transaction }
      );
      await queryInterface.sequelize.query(
        'ALTER TABLE confirmation_attempts ADD COLUMN previous_outcome "enum_confirmation_attempts_outcome" NULL;',
        { transaction }
      );
      await queryInterface.addColumn(
        'confirmation_tasks',
        'completed_at',
        { type: Sequelize.DATE, allowNull: true },
        { transaction }
      );
      await queryInterface.sequelize.query(
        "UPDATE confirmation_tasks SET completed_at = updated_at WHERE status = 'done';",
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS confirmation_tasks_workspace_status_locked_at_idx
           ON confirmation_tasks (workspace_id, status, locked_at);`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS confirmation_attempts_task_id_created_at_idx
           ON confirmation_attempts (task_id, created_at);`,
        { transaction }
      );
      await queryInterface.sequelize.query('DROP INDEX IF EXISTS confirmation_attempts_task_id_idx;', { transaction });
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(
        'CREATE INDEX IF NOT EXISTS confirmation_attempts_task_id_idx ON confirmation_attempts (task_id);',
        { transaction }
      );
      await queryInterface.sequelize.query('DROP INDEX IF EXISTS confirmation_attempts_task_id_created_at_idx;', { transaction });
      await queryInterface.sequelize.query('DROP INDEX IF EXISTS confirmation_tasks_workspace_status_locked_at_idx;', { transaction });
      await queryInterface.removeColumn('confirmation_tasks', 'completed_at', { transaction });
      await queryInterface.removeColumn('confirmation_attempts', 'previous_outcome', { transaction });
      await queryInterface.removeColumn('confirmation_attempts', 'source', { transaction });
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_confirmation_attempts_source";', { transaction });
    });
  },
};
