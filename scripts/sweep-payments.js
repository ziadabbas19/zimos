'use strict';

/**
 * One payments reconciliation run, then exit. Meant for a Railway cron
 * service (every 5 minutes, Railway's minimum) running this same image:
 *
 *   node scripts/sweep-payments.js
 *
 * What it does (modules/payments/paymentSweepService.js):
 *   - processes again any payment callback whose processing failed
 *   - asks the gateway about payment attempts a few minutes old that no
 *     callback has settled
 *   - expires unpaid online orders past their window — only after the gateway
 *     confirms nothing was paid — and gives their stock back (rows locked FOR
 *     UPDATE SKIP LOCKED, so overlapping runs never block each other)
 *   - looks up refunds still pending at the gateway
 *
 * It never starts a web server and never runs migrations: the web service's
 * deploy does that. Exits 0 when the run finished (whatever it found), 1 when
 * it could not run at all, so Railway's cron history shows real failures.
 *
 * Nothing to do when PAYMENTS_ONLINE_ENABLED is off and no gateway is
 * connected: every step finds no rows and the run takes a second.
 *
 * SWEEP_BATCH_SIZE (default 50) caps each step per pass; passes repeat while
 * a step keeps finding a full batch it can make progress on.
 */

const db = require('../src/db/models');
const logger = require('../src/core/utils/logger');
const { sweep } = require('../src/modules/payments/paymentSweepService');

async function main() {
  const limit = Math.max(1, parseInt(process.env.SWEEP_BATCH_SIZE || '50', 10) || 50);
  const started = Date.now();
  const result = await sweep({ limit });
  logger.info('Payments sweep finished', { ms: Date.now() - started, ...result });
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    logger.error('Payments sweep failed', { message: err.message, stack: err.stack });
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.sequelize.close();
    } catch (err) {
      // Already closed or never opened; the exit code says what happened.
    }
  });
