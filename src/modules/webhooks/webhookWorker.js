'use strict';

const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { scanOnce, releaseHeld } = require('./orderChangeDetector');
const { deliverDue } = require('./webhookDispatcher');

/**
 * The webhook loop: find order changes, then send what is due. Run in the API
 * process every env.webhooks.intervalMs (server.js), or once per invocation
 * from scripts/dispatch-webhooks.js on a cron — both at once is safe, since
 * each step locks what it works on.
 */

/**
 * One full pass. The detector reads its whole window page by page in one
 * scan, so a single call covers every change up to now.
 */
async function runOnce({ now } = {}) {
  const { scanned, events } = await scanOnce({ now: now || new Date() });
  // Locked orders that have opened since: their events go out in this pass (orderChangeDetector).
  const released = await releaseHeld({ now: now || new Date() });
  const sent = await deliverDue({ now });
  return { scanned, events: events + released.events, released: released.released, ...sent };
}

let timer = null;
let running = false;

async function tick() {
  // A pass that outlives the interval is not started a second time on top.
  if (running) return;
  running = true;
  try {
    const result = await runOnce();
    if (result.events > 0 || result.attempted > 0) logger.info('Webhook pass', result);
  } catch (err) {
    logger.error('Webhook pass failed', { message: err.message, stack: err.stack });
  } finally {
    running = false;
  }
}

function start({ intervalMs = env.webhooks.intervalMs } = {}) {
  if (timer) return;
  timer = setInterval(tick, intervalMs);
  // Never the reason the process stays up: shutdown closes the server and
  // the pool, and a pending tick must not hold the event loop open.
  timer.unref();
  logger.info(`Webhook worker running in-process every ${intervalMs} ms`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { runOnce, start, stop };
