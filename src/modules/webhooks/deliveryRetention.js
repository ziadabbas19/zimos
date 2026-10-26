'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');

/**
 * WEBHOOK_DELIVERY_RETENTION_DAYS: how many days the delivery log keeps.
 * Older deliveries that are done — delivered, exhausted, or stopped (failed
 * with nothing scheduled) — are deleted; one still pending or due for a retry
 * is never touched, whatever its age. Their payloads are the customers'
 * details a store sent, so they are not kept for ever.
 *
 * Endpoint by endpoint (the endpoint_id index), BATCH rows per statement, so
 * no statement holds the table long. Run once a day: by the in-process
 * webhook worker (maybePrune), or by scripts/prune-webhook-deliveries.js on a
 * daily cron. Unset or 0 (the default): nothing is deleted, as before.
 */

const BATCH = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Deletes what is past retention now. Returns how many deliveries went. */
async function pruneOnce({ now = new Date(), days = env.webhooks.deliveryRetentionDays } = {}) {
  if (!days || days <= 0) return 0;
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const endpoints = await db.WebhookEndpoint.findAll({ attributes: ['id'] });
  let deleted = 0;
  for (const { id: endpointId } of endpoints) {
    for (;;) {
      const gone = await db.sequelize.query(
        `DELETE FROM webhook_deliveries
          WHERE id IN (
                SELECT id FROM webhook_deliveries
                 WHERE endpoint_id = :endpointId
                   AND created_at < :cutoff
                   AND (status IN ('delivered', 'exhausted') OR (status = 'failed' AND next_attempt_at IS NULL))
                 LIMIT :batch)
         RETURNING id`,
        { replacements: { endpointId, cutoff, batch: BATCH }, type: QueryTypes.SELECT }
      );
      const count = gone.length;
      deleted += count;
      if (count < BATCH) break;
    }
  }
  return deleted;
}

let lastPruneAt = 0;

/** For the in-process worker: at most once a day per process, and only while retention is set. */
async function maybePrune({ now = new Date() } = {}) {
  if (!(env.webhooks.deliveryRetentionDays > 0) || now.getTime() - lastPruneAt < DAY_MS) return 0;
  lastPruneAt = now.getTime();
  const deleted = await pruneOnce({ now });
  if (deleted > 0) logger.info('Webhook deliveries past retention deleted', { deleted, days: env.webhooks.deliveryRetentionDays });
  return deleted;
}

module.exports = { pruneOnce, maybePrune, BATCH };
