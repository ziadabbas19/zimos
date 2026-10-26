'use strict';

const { guarded } = require('../migrationGuards');
const { withLockTimeout } = require('../lockTimeout');

/**
 * automation_rules.configured_by_user_id: the teammate who last saved a
 * rule's steps — whose role decides whether its webhook steps send the
 * customer's name and the order's tracking and recovery links in full
 * (automations/automationSteps.js), the rule webhook endpoints follow
 * (webhook_endpoints.configured_by_user_id, migration 719). No foreign key: a
 * teammate who is deleted simply stops matching an active member, and the
 * rule's webhook steps send the masked form.
 *
 * Backfilled from the activity log (append-only, never purged): the actor of
 * the rule's creation, or of the latest edit that changed its steps. A rule
 * with no such entry stays null and sends the masked form until a teammate
 * who may see customers in full saves its steps again.
 *
 * Run-twice safe: the column is added (and dropped) in a short transaction
 * under a lock_timeout with retries (db/lockTimeout.js), once; only nulls are
 * backfilled. Down drops the column (webhook steps go back to the old rule:
 * in full).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await withLockTimeout(queryInterface.sequelize, (transaction) =>
      qi.addColumn('automation_rules', 'configured_by_user_id', { type: Sequelize.UUID, allowNull: true }, { transaction })
    );
    await queryInterface.sequelize.query(`
      UPDATE automation_rules r
         SET configured_by_user_id = a.actor_user_id
        FROM (
          SELECT DISTINCT ON (entity_id) entity_id, actor_user_id
            FROM audit_logs
           WHERE entity_type = 'AutomationRule'
             AND actor_user_id IS NOT NULL
             AND (action = 'automation.create'
                  OR (action = 'automation.update'
                      AND (before_state->'actions') IS DISTINCT FROM (after_state->'actions')))
           ORDER BY entity_id, created_at DESC
        ) a
       WHERE r.configured_by_user_id IS NULL
         AND a.entity_id = r.id::text`);
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await withLockTimeout(queryInterface.sequelize, (transaction) => qi.removeColumn('automation_rules', 'configured_by_user_id', { transaction }));
  },
};
