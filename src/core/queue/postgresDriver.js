'use strict';

const os = require('os');
const { QueryTypes, Sequelize, ConnectionError } = require('sequelize');
const db = require('../../db/models');
const logger = require('../utils/logger');
const { QUEUE_NAMES, policyFor, isPermanent } = require('./queues');

/**
 * The queue on PostgreSQL: jobs are rows of queue_jobs, claimed with
 * FOR UPDATE SKIP LOCKED so any number of workers can run side by side. It
 * needs nothing but the database, and `add` can join the caller's
 * transaction — the job exists only if the change it belongs to commits.

 */

const WORKER_ID = `${os.hostname()}:${process.pid}`;
// An `active` job whose lock is older than this had its worker stop: it is
// handed out again, or failed when it may not run twice. A running job
// renews its lock every heartbeatMs, so a long job is never taken from a
// live worker. Set by start() (QUEUE_STALE_LOCK_MS).
let staleLockMs = 10 * 60 * 1000;
const heartbeatMs = () => Math.min(60 * 1000, Math.max(1000, Math.floor(staleLockMs / 4)));
const SCHEDULE_TICK_MS = 5000;

const handlers = new Map(); // queue → (job) => Promise
const schedules = new Map(); // name → { everyMs, handle }

let pollMs = 1000;
let concurrency = 10;
let pollTimer = null;
let scheduleTimer = null;
let polling = false;
let kicked = false;
let inFlight = 0;
let stopped = true;
let lastStaleSweep = 0;
// "queue/name" of jobs that are never run again after their worker stopped
// mid-run (a courier booking: it may have gone through), and what is told
// when that happens (index.js); and of jobs safe to run again, put back in
// line even after their last attempt, at most RESUMES more times. Set by
// configureInterruptions.
let onceKeys = [];
let resumableKeys = [];
let onInterrupted = null;
const RESUMES = 2;

/*
 * The control plane — claiming jobs, renewing their locks, taking back stale
 * ones — on a connection of its own (QUEUE_CONTROL_CONNECTION). On the shared
 * pool those statements wait behind the jobs themselves: handlers that hold
 * every connection keep their own heartbeats from landing, and their locks go
 * stale under live workers. Open between start() and stop() only; without it,
 * or when it cannot get a connection, the shared pool is used as before.
 */
let control = null;

function openControl() {
  const { config } = db.sequelize;
  return new Sequelize(config.database, config.username, config.password, {
    host: config.host,
    port: config.port,
    dialect: 'postgres',
    logging: false,
    dialectOptions: config.dialectOptions,
    // One kept open, a second for a heartbeat that lands during a sweep.
    pool: { max: 2, min: 1, idle: 10000, acquire: 30000 },
  });
}

async function controlQuery(sql, options) {
  if (!control) return db.sequelize.query(sql, options);
  try {
    return await control.query(sql, options);
  } catch (err) {
    // No connection to send it on, so nothing ran: the shared pool may run it.
    if (!(err instanceof ConnectionError)) throw err;
    logger.warn(`[queue] control connection unavailable, using the shared pool: ${err.message}`);
    return db.sequelize.query(sql, options);
  }
}

function configureInterruptions({ once = [], resumable = [], interrupted = null } = {}) {
  onceKeys = [...once];
  resumableKeys = [...resumable];
  onInterrupted = interrupted;
}

async function add(queue, name, payload = {}, { delayMs = 0, dedupeKey = null, workspaceId = null, transaction = null } = {}) {
  const policy = policyFor(queue);
  const rows = await db.sequelize.query(
    `INSERT INTO queue_jobs (queue, name, payload, max_attempts, run_at, dedupe_key, workspace_id)
     VALUES (:queue, :name, CAST(:payload AS jsonb), :maxAttempts, NOW() + (:delayMs * INTERVAL '1 millisecond'), :dedupeKey, :workspaceId)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    {
      replacements: {
        queue,
        name,
        payload: JSON.stringify(payload || {}),
        maxAttempts: policy.delays.length + 1,
        delayMs: Math.max(0, Math.round(delayMs)),
        dedupeKey,
        workspaceId,
      },
      type: QueryTypes.SELECT,
      transaction,
    }
  );
  // Wake the loop of this process right away instead of at the next tick.
  if (transaction) transaction.afterCommit(kick);
  else kick();
  return rows[0] ? { id: rows[0].id, queued: true } : { id: null, queued: false };
}

function process_(queue, handle) {
  policyFor(queue);
  handlers.set(queue, handle);
}

function every(name, everyMs, handle) {
  schedules.set(name, { everyMs, handle });
}

async function claim(limit) {
  const queues = [...handlers.keys()];
  if (queues.length === 0 || limit <= 0) return [];
  return controlQuery(
    `UPDATE queue_jobs j
        SET status = 'active', attempts = j.attempts + 1, locked_at = NOW(), locked_by = :worker, updated_at = NOW()
      WHERE j.id IN (
              SELECT id FROM queue_jobs
               WHERE status = 'pending' AND run_at <= NOW() AND queue IN (:queues)
               ORDER BY run_at
               LIMIT :limit
               FOR UPDATE SKIP LOCKED)
  RETURNING j.id, j.queue, j.name, j.payload, j.attempts, j.max_attempts AS "maxAttempts", j.workspace_id AS "workspaceId"`,
    { replacements: { worker: WORKER_ID, queues, limit }, type: QueryTypes.SELECT, logging: false }
  );
}

// Only while this worker still holds the job: one taken back as stale (its
// lock not renewed for staleLockMs) belongs to the sweep or another worker.
const HELD = `id = :id AND locked_by = :worker AND status = 'active'`;

async function finish(job, err) {
  if (!err) {
    const [, meta] = await db.sequelize.query(
      `UPDATE queue_jobs SET status = 'completed', finished_at = NOW(), locked_at = NULL, locked_by = NULL, last_error = NULL, updated_at = NOW() WHERE ${HELD}`,
      { replacements: { id: job.id, worker: WORKER_ID } }
    );
    if (meta && meta.rowCount === 0) logger.warn(`[queue] ${job.queue}/${job.name} ${job.id} finished after its lock was taken back`);
    return;
  }
  const message = String(err && err.message ? err.message : err).slice(0, 2000);
  const policy = policyFor(job.queue);
  const retry = job.attempts < job.maxAttempts && !isPermanent(job.queue, err);
  if (retry) {
    const delayMs = policy.delays[job.attempts - 1] ?? policy.delays[policy.delays.length - 1] ?? 0;
    await db.sequelize.query(
      `UPDATE queue_jobs SET status = 'pending', run_at = NOW() + (:delayMs * INTERVAL '1 millisecond'),
              locked_at = NULL, locked_by = NULL, last_error = :message, updated_at = NOW() WHERE ${HELD}`,
      { replacements: { id: job.id, worker: WORKER_ID, delayMs, message } }
    );
    logger.warn(`[queue] ${job.queue}/${job.name} attempt ${job.attempts} failed, retrying in ${Math.round(delayMs / 1000)}s: ${message}`);
  } else {
    await db.sequelize.query(
      `UPDATE queue_jobs SET status = 'failed', finished_at = NOW(), locked_at = NULL, locked_by = NULL, last_error = :message, updated_at = NOW() WHERE ${HELD}`,
      { replacements: { id: job.id, worker: WORKER_ID, message } }
    );
    logger.error(`[queue] ${job.queue}/${job.name} failed for good after ${job.attempts} attempt(s): ${message}`);
  }
}

async function runJob(job) {
  inFlight += 1;
  // The heartbeat: the lock stays fresh while the handler runs, however long.
  const heartbeat = setInterval(() => {
    controlQuery(`UPDATE queue_jobs SET locked_at = NOW() WHERE ${HELD}`, { replacements: { id: job.id, worker: WORKER_ID }, logging: false }).catch(
      (err) => logger.warn(`[queue] could not renew the lock of job ${job.id}: ${err.message}`)
    );
  }, heartbeatMs());
  try {
    let failure = null;
    try {
      await handlers.get(job.queue)(job);
    } catch (err) {
      failure = err || new Error('job failed');
    } finally {
      clearInterval(heartbeat);
    }
    await finish(job, failure);
  } catch (err) {
    logger.error(`[queue] could not record the outcome of job ${job.id}: ${err.message}`);
  } finally {
    inFlight -= 1;
    // A slot is free: look for more work without waiting for the tick.
    kick();
  }
}

const INTERRUPTED = 'Its worker stopped while it was running; not run again';

// `force` (tests) sweeps now, whenever the last sweep ran.
async function releaseStale({ force = false } = {}) {
  if (!force && Date.now() - lastStaleSweep < Math.min(60 * 1000, staleLockMs / 2)) return;
  lastStaleSweep = Date.now();
  // One statement, one cutoff: jobs that may not run twice, and jobs that had
  // their last attempt (a resumable one: RESUMES more), fail; the rest go back
  // in line. A job never goes back in line because it went stale a moment
  // after its `once` neighbours were failed.
  const swept = await controlQuery(
    `WITH stale AS (
       SELECT id, ((queue || '/' || name) IN (:once)
                   OR attempts >= max_attempts + CASE WHEN (queue || '/' || name) IN (:resumable) THEN :resumes ELSE 0 END) AS fail
         FROM queue_jobs
        WHERE status = 'active' AND locked_at < NOW() - (:staleMs * INTERVAL '1 millisecond')
          FOR UPDATE SKIP LOCKED)
     UPDATE queue_jobs j
        SET status = CASE WHEN s.fail THEN 'failed' ELSE 'pending' END,
            finished_at = CASE WHEN s.fail THEN NOW() ELSE j.finished_at END,
            last_error = CASE WHEN s.fail THEN :message ELSE j.last_error END,
            locked_at = NULL, locked_by = NULL, updated_at = NOW()
       FROM stale s
      WHERE j.id = s.id
  RETURNING j.id, j.queue, j.name, j.payload, j.attempts, j.max_attempts AS "maxAttempts", j.workspace_id AS "workspaceId", s.fail`,
    {
      replacements: {
        staleMs: staleLockMs,
        message: INTERRUPTED,
        once: onceKeys.length ? onceKeys : [''],
        resumable: resumableKeys.length ? resumableKeys : [''],
        resumes: RESUMES,
      },
      type: QueryTypes.SELECT,
      logging: false,
    }
  );
  for (const job of swept.filter((row) => row.fail)) {
    logger.error(`[queue] ${job.queue}/${job.name} ${job.id} was cut off on attempt ${job.attempts} and is not run again`);
    if (onInterrupted) await onInterrupted(job);
  }
}

async function poll() {
  if (stopped || polling) {
    kicked = !stopped;
    return;
  }
  polling = true;
  kicked = false;
  try {
    await releaseStale();
    const jobs = await claim(concurrency - inFlight);
    for (const job of jobs) runJob(job);
  } catch (err) {
    logger.error(`[queue] poll failed: ${err.message}`);
  } finally {
    polling = false;
    if (kicked) setImmediate(poll);
  }
}

function kick() {
  if (stopped) return;
  setImmediate(poll);
}

async function runSchedule(name) {
  const schedule = schedules.get(name);
  // The claim moves next_run_at forward in one statement, so of several
  // workers only one runs each turn.
  const claimed = await db.sequelize.query(
    `UPDATE queue_schedules
        SET next_run_at = NOW() + (every_ms * INTERVAL '1 millisecond'), last_run_at = NOW(), updated_at = NOW()
      WHERE name = :name AND next_run_at <= NOW()
  RETURNING name`,
    { replacements: { name }, type: QueryTypes.SELECT, logging: false }
  );
  if (claimed.length === 0) return;
  const started = Date.now();
  let error = null;
  try {
    await schedule.handle();
  } catch (err) {
    error = String(err && err.message ? err.message : err).slice(0, 2000);
    logger.error(`[queue] schedule ${name} failed: ${error}`);
  }
  await db.sequelize.query(
    `UPDATE queue_schedules SET last_status = :status, last_error = :error, last_duration_ms = :ms, updated_at = NOW() WHERE name = :name`,
    { replacements: { name, status: error ? 'failed' : 'ok', error, ms: Date.now() - started } }
  );
}

const runningSchedules = new Set();

async function scheduleTick() {
  if (stopped) return;
  for (const name of schedules.keys()) {
    if (runningSchedules.has(name)) continue;
    runningSchedules.add(name);
    runSchedule(name)
      .catch((err) => logger.error(`[queue] schedule ${name}: ${err.message}`))
      .finally(() => runningSchedules.delete(name));
  }
}

async function start(options = {}) {
  if (!stopped) return;
  pollMs = options.pollMs || pollMs;
  concurrency = options.concurrency || concurrency;
  staleLockMs = options.staleLockMs || staleLockMs;
  if (options.controlConnection && !control) control = openControl();
  for (const [name, schedule] of schedules) {
    // First run one interval from now; a changed interval takes effect at once.
    await db.sequelize.query(
      `INSERT INTO queue_schedules (name, every_ms, next_run_at)
       VALUES (:name, :everyMs, NOW() + (:everyMs * INTERVAL '1 millisecond'))
       ON CONFLICT (name) DO UPDATE SET every_ms = EXCLUDED.every_ms, updated_at = NOW(),
         next_run_at = LEAST(queue_schedules.next_run_at, EXCLUDED.next_run_at)`,
      { replacements: { name, everyMs: schedule.everyMs } }
    );
  }
  stopped = false;
  pollTimer = setInterval(poll, pollMs);
  scheduleTimer = setInterval(scheduleTick, SCHEDULE_TICK_MS);
  kick();
}

async function stop({ timeoutMs = 8000 } = {}) {
  stopped = true;
  if (pollTimer) clearInterval(pollTimer);
  if (scheduleTimer) clearInterval(scheduleTimer);
  pollTimer = null;
  scheduleTimer = null;
  const deadline = Date.now() + timeoutMs;
  while ((inFlight > 0 || runningSchedules.size > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (control) {
    const closing = control;
    control = null;
    await closing.close().catch((err) => logger.warn(`[queue] could not close the control connection: ${err.message}`));
  }
}

async function stats() {
  const rows = await db.sequelize.query(
    `SELECT queue, status, COUNT(*)::int AS count, MIN(run_at) AS oldest
       FROM queue_jobs
      WHERE status IN ('pending', 'active', 'failed')
         OR (status = 'completed' AND finished_at > NOW() - INTERVAL '24 hours')
      GROUP BY queue, status`,
    { type: QueryTypes.SELECT }
  );
  const queues = QUEUE_NAMES.map((name) => {
    const of = (status) => rows.find((row) => row.queue === name && row.status === status);
    const pending = of('pending');
    return {
      name,
      pending: pending ? pending.count : 0,
      active: (of('active') || {}).count || 0,
      failed: (of('failed') || {}).count || 0,
      completedLastDay: (of('completed') || {}).count || 0,
      oldestPendingAt: pending ? pending.oldest : null,
    };
  });
  const scheduleRows = await db.QueueSchedule.findAll({ order: [['name', 'ASC']] });
  return {
    driver: 'postgres',
    queues,
    schedules: scheduleRows.map((row) => ({
      name: row.name,
      everyMs: Number(row.everyMs),
      nextRunAt: row.nextRunAt,
      lastRunAt: row.lastRunAt,
      lastStatus: row.lastStatus,
      lastError: row.lastError,
      lastDurationMs: row.lastDurationMs,
    })),
  };
}

async function listJobs({ status = 'failed', queue = null, limit = 50 } = {}) {
  const where = { status };
  if (queue) where.queue = queue;
  const rows = await db.QueueJob.findAll({ where, order: [['updatedAt', 'DESC']], limit: Math.min(200, limit) });
  return rows.map((row) => ({
    id: row.id,
    queue: row.queue,
    name: row.name,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    workspaceId: row.workspaceId,
    lastError: row.lastError,
    runAt: row.runAt,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  }));
}

/** Puts a failed job back in line with a fresh set of attempts. */
async function retryJob(id) {
  // Job ids here are uuids; anything else is no job (a 404, not a database error).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id))) return false;
  const rows = await db.sequelize.query(
    `UPDATE queue_jobs SET status = 'pending', attempts = 0, run_at = NOW(), finished_at = NULL, updated_at = NOW()
      WHERE id = :id AND status = 'failed' RETURNING id`,
    { replacements: { id }, type: QueryTypes.SELECT }
  );
  kick();
  return rows.length > 0;
}

/** Finished jobs are kept for a while for the status screen, then removed. */
async function prune({ completedDays = 3, failedDays = 30 } = {}) {
  const [, meta] = await db.sequelize.query(
    `DELETE FROM queue_jobs
      WHERE (status = 'completed' AND finished_at < NOW() - (:completedDays * INTERVAL '1 day'))
         OR (status = 'failed' AND finished_at < NOW() - (:failedDays * INTERVAL '1 day'))`,
    { replacements: { completedDays, failedDays } }
  );
  return { removed: meta && typeof meta.rowCount === 'number' ? meta.rowCount : 0 };
}

module.exports = {
  name: 'postgres',
  transactional: true,
  add,
  process: process_,
  every,
  configureInterruptions,
  releaseStale,
  start,
  stop,
  stats,
  listJobs,
  retryJob,
  prune,
};
