'use strict';

/**
 * The webhook delivery log past WEBHOOK_DELIVERY_RETENTION_DAYS, deleted once
 * (modules/webhooks/deliveryRetention.js) — for a daily cron service running
 * this same image when the API does not run the webhook worker in-process:
 *
 *   node scripts/prune-webhook-deliveries.js
 *
 * Only deliveries that are done (delivered, exhausted, stopped) and older
 * than that many days go; one still pending or due for a retry stays.
 * Unset or 0: deletes nothing and says so. Prints how many went, never a
 * payload. Exits 0 when it finished, 1 when it could not run.
 */

const db = require('../src/db/models');
const env = require('../src/config/env');
const logger = require('../src/core/utils/logger');
const { pruneOnce } = require('../src/modules/webhooks/deliveryRetention');

async function main() {
  const days = env.webhooks.deliveryRetentionDays;
  if (!(days > 0)) {
    logger.info('WEBHOOK_DELIVERY_RETENTION_DAYS is not set: nothing deleted');
    return;
  }
  const deleted = await pruneOnce({ days });
  logger.info('Webhook deliveries past retention deleted', { deleted, days });
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    logger.error('Webhook delivery prune failed', { message: err.message });
    process.exitCode = 1;
  })
  .finally(() => db.sequelize.close());
