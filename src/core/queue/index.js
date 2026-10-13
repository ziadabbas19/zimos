'use strict';

const requestContext = require('../utils/requestContext');
const env = require('../../config/env');
const logger = require('../utils/logger');
const { QUEUE_NAMES } = require('./queues');

/**
 * The job queue every module talks to. See README.md in this folder.
 *
 *   queue.add('io', 'orders.export', { exportId }, { transaction })
 *
 * Handlers and repeatable jobs are declared in `src/modules/<module>/jobs.js`
 * (registry.js) and run by the worker (src/worker.js, or inside the API
 * process while WORKER_IN_PROCESS is on).
 *
 * The driver is PostgreSQL (postgresDriver.js).
 */

const driver = require('./postgresDriver');

const jobHandlers = new Map(); // "queue/name" → handle(job)
const jobOptions = new Map(); // "queue/name" → { once, resumable, onInterrupted }
const scheduleHandlers = new Map(); // name → { everyMs, handle }

/**
 * Registers what runs for jobs called `name` on `queue`. One handler per pair.
 * Options: `once` — a job whose worker stopped mid-run is failed instead of
 * run again (it may have done its work: a courier booking); `resumable` — safe
 * to run again, so it is put back in line even after its last attempt (a sync
 * that skips what it already did); `onInterrupted(job)` — called when a job is
 * failed that way, to tell the merchant.
 */
function handle(queue, name, fn, options = {}) {
  const key = `${queue}/${name}`;
  jobHandlers.set(key, fn);
  if (options.once || options.resumable || options.onInterrupted) {
    jobOptions.set(key, { once: Boolean(options.once), resumable: Boolean(options.resumable) && !options.once, onInterrupted: options.onInterrupted || null });
  } else jobOptions.delete(key);
}

/** A job the driver failed because its worker stopped while running it. */
async function interrupted(job) {
  const options = jobOptions.get(`${job.queue}/${job.name}`);
  if (!options || !options.onInterrupted) return;
  await requestContext.run({ jobId: `${job.queue}/${job.name}:${job.id}`, ...(job.workspaceId ? { workspaceId: job.workspaceId } : {}) }, async () => {
    try {
      await options.onInterrupted(job);
    } catch (err) {
      logger.error(`[queue] ${job.queue}/${job.name} ${job.id}: could not report the interruption: ${err.message}`);
    }
  });
}

/** The once / resumable keys and the interruption hook, as the driver takes them. */
function interruptionSettings() {
  return {
    once: [...jobOptions].filter(([, options]) => options.once).map(([key]) => key),
    resumable: [...jobOptions].filter(([, options]) => options.resumable).map(([key]) => key),
    interrupted,
  };
}

/** Registers a repeatable job: `fn` runs about every `everyMs`, on one worker at a time. */
function every(name, everyMs, fn) {
  scheduleHandlers.set(name, { everyMs, handle: fn });
}

async function route(job) {
  // Every log line of the job carries its id and store (core/utils/requestContext).
  return requestContext.run({ jobId: `${job.queue}/${job.name}:${job.id}`, ...(job.workspaceId ? { workspaceId: job.workspaceId } : {}) }, async () => {
    return routeIn(job);
  });
}

async function routeIn(job) {
  const fn = jobHandlers.get(`${job.queue}/${job.name}`);
  if (!fn) {
    const err = new Error(`No handler registered for ${job.queue}/${job.name}`);
    err.permanent = true;
    throw err;
  }
  return fn(job);
}

/**
 * Queues a job. Options: `delayMs`, `dedupeKey` (a second add with the same
 * key is dropped), `workspaceId` (shown on the status screen), `transaction`
 * (the job is queued only if it commits).
 *
 * Under NODE_ENV=test there is no worker: the job runs at once (after the
 * commit when a transaction is given) and the returned promise waits for it.
 */
async function add(queue, name, payload = {}, options = {}) {
  if (env.isTest) {
    // eslint-disable-next-line global-require
    require('./registry').load();
    const job = { id: null, queue, name, payload, attempts: 1, maxAttempts: 1, workspaceId: options.workspaceId || null };
    const run = () => route(job).catch((err) => logger.error(`[queue] ${queue}/${name} failed: ${err.message}`));
    if (options.transaction) options.transaction.afterCommit(run);
    else await run();
    return { id: null, queued: true };
  }
  return driver.add(queue, name, payload, options);
}

let started = false;

async function start() {
  if (started) return;
  started = true;
  const used = new Set([...jobHandlers.keys()].map((key) => key.split('/')[0]));
  for (const name of QUEUE_NAMES) if (used.has(name)) driver.process(name, route);
  // A scheduled run logs as its schedule (core/utils/requestContext).
  for (const [name, schedule] of scheduleHandlers) {
    driver.every(name, schedule.everyMs, (...args) => requestContext.run({ jobId: `schedule/${name}` }, () => schedule.handle(...args)));
  }
  if (driver.configureInterruptions) driver.configureInterruptions(interruptionSettings());
  await driver.start({
    pollMs: env.queue.pollMs,
    concurrency: env.queue.concurrency,
    staleLockMs: env.queue.staleLockMs,
    controlConnection: env.queue.controlConnection,
  });
  logger.info(`Queue worker running on the ${driver.name} driver`, {
    queues: [...used],
    schedules: [...scheduleHandlers.keys()],
  });
}

async function stop() {
  if (!started) return;
  started = false;
  await driver.stop();
}

module.exports = {
  add,
  handle,
  every,
  interruptionSettings,
  start,
  stop,
  stats: (...args) => driver.stats(...args),
  listJobs: (...args) => driver.listJobs(...args),
  retryJob: (...args) => driver.retryJob(...args),
  prune: (...args) => driver.prune(...args),
  get driverName() {
    return driver.name;
  },
  get transactional() {
    return driver.transactional;
  },
  get scheduleNames() {
    return [...scheduleHandlers.keys()];
  },
};
