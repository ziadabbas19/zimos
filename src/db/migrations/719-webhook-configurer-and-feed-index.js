'use strict';

const { guarded } = require('../migrationGuards');
const { createIndexConcurrently, dropIndexConcurrently } = require('../concurrentIndex');
const { withLockTimeout } = require('../lockTimeout');

const FEED_INDEX = 'orders_workspace_updated_at_idx';

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
 * orders (workspace_id, updated_at), built CONCURRENTLY: the accepted-orders
 * feed asks every few seconds for one store's orders changed since a moment
 * (publicApi/acceptedOrdersFeed.js), and so does GET /orders?updated_since=.
 * Without it each ask walks every order of the store.
 *
 * Run-twice safe. The column is added (and dropped) in a short transaction
 * under a lock_timeout with retries (db/lockTimeout.js); the index without
 * one (CONCURRENTLY). The column is added once, only nulls are backfilled, a
 * valid index is left alone (an invalid leftover is rebuilt). Down drops the
 * index CONCURRENTLY and the column (deliveries go back to the old rule: in
 * full).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await withLockTimeout(queryInterface.sequelize, (transaction) =>
      qi.addColumn('webhook_endpoints', 'configured_by_user_id', { type: Sequelize.UUID, allowNull: true }, { transaction })
    );
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
    await createIndexConcurrently(queryInterface, { name: FEED_INDEX, table: 'orders', definition: '(workspace_id, updated_at)' });
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await dropIndexConcurrently(queryInterface, FEED_INDEX);
    await withLockTimeout(queryInterface.sequelize, (transaction) => qi.removeColumn('webhook_endpoints', 'configured_by_user_id', { transaction }));
  },
};
