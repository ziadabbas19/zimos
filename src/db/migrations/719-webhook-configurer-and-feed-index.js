'use strict';

const { guarded } = require('../migrationGuards');

/**
 * webhook_endpoints.configured_by_user_id: the teammate who last set an
 * endpoint's address — whose role decides whether its deliveries carry the
 * customers' names, phones, emails and addresses in full
 * (webhooks/customerData.js). No foreign key: a teammate who is deleted
 * simply stops matching an active member, and the endpoint is sent the
 * masked form, as for one who left the store.
 *
 * Backfilled from the activity log (append-only, never purged): the actor of
 * the endpoint's creation, or of the latest edit that changed its URL.
 * An endpoint with no such entry stays null and is sent the masked form
 * until an owner saves its address again.
 *
 * Run-twice safe: the column is added once and only nulls are backfilled.
 * Down drops the column (deliveries go back to the old rule: in full).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.addColumn('webhook_endpoints', 'configured_by_user_id', { type: Sequelize.UUID, allowNull: true });
    await queryInterface.sequelize.query(`
      UPDATE webhook_endpoints e
         SET configured_by_user_id = a.actor_user_id
        FROM (
          SELECT DISTINCT ON (entity_id) entity_id, actor_user_id
            FROM audit_logs
           WHERE entity_type = 'WebhookEndpoint'
             AND actor_user_id IS NOT NULL
             AND (action = 'webhook_endpoint.create'
                  OR (action = 'webhook_endpoint.update'
                      AND (before_state->>'url') IS DISTINCT FROM (after_state->>'url')))
           ORDER BY entity_id, created_at DESC
        ) a
       WHERE e.configured_by_user_id IS NULL
         AND a.entity_id = e.id::text`);
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.removeColumn('webhook_endpoints', 'configured_by_user_id');
  },
};
