'use strict';

/**
 * One carrier-shipment sync run, then exit. Meant for a Railway cron service
 * (every 15 minutes) running this same image:
 *
 *   node scripts/sync-carrier-shipments.js
 *
 * What it does (modules/shipping/carrierSyncService.js):
 *   - reads every open shipment whose next_poll_at is due from its carrier
 *     (bulk where the carrier has a bulk endpoint) and applies the status,
 *     exactly as a webhook would; only carriers with capabilities.polling are
 *     ever scheduled — Bosta is not
 *   - runs the ~24h / ~72h checks after a manual-cancel acknowledgement and
 *     flags the order when the carrier still has the parcel moving
 *   - backs off on failures (interval x 2^failures, at most a day)
 *
 * Claimed rows are locked FOR UPDATE SKIP LOCKED and leased for 10 minutes,
 * so overlapping runs never read the same shipment twice. It never starts a
 * web server and never runs migrations. Exits 0 when the run finished
 * (whatever it found), 1 when it could not run at all.
 *
 * CARRIER_SYNC_BATCH_SIZE (default 200) caps each batch; batches repeat
 * while they come back full. With nothing scheduled the run takes a second.
 */

const db = require('../src/db/models');
const logger = require('../src/core/utils/logger');
const { syncDue } = require('../src/modules/shipping/carrierSyncService');

async function main() {
  const started = Date.now();
  const result = await syncDue();
  logger.info('Carrier shipment sync finished', { ms: Date.now() - started, ...result });
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    logger.error('Carrier shipment sync failed', { message: err.message, stack: err.stack });
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.sequelize.close();
    } catch (err) {
      // Already closed or never opened; the exit code says what happened.
    }
  });
