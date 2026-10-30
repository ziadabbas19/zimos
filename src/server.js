'use strict';

const app = require('./app');
const env = require('./config/env');
const db = require('./db/models');
const logger = require('./core/utils/logger');
const { describeStorage, storageProblems } = require('./modules/media/storage');
const { logRollout: logCarrierRollout } = require('./modules/shipping/carriers');
const { imageProcessingStatus } = require('./modules/media/imageProcessing');
const signupPolicy = require('./modules/auth/signupPolicy');
const { releaseDraftsWhenOff } = require('./modules/billing/goLiveService');
const { startUploadSweep } = require('./modules/customerUploads/customerUploadService');
const webhookWorker = require('./modules/webhooks/webhookWorker');
const workerRuntime = require('./core/workerRuntime');
const realtime = require('./modules/realtime');

async function start() {
  try {
    await db.sequelize.authenticate();
    // Report the database this process is actually on — queried live, not
    // read from .env — so it's obvious at a glance on every boot.
    const [rows] = await db.sequelize.query('SELECT current_database() AS name');
    const liveName = rows[0].name;
    const { host, port } = db.sequelize.config;
    logger.info(`Connected to database: ${liveName} (${host}:${port})`);
  } catch (err) {
    logger.error('Unable to connect to the database', { message: err.message });
    process.exit(1);
  }

  // Same idea for image storage: print what STORAGE_PROVIDER actually
  // resolved to in THIS process, so a deploy log settles "is it on R2?".
  // Every problem is logged at error level on every boot; none of them stops
  // the API (images already stored elsewhere keep working).
  logger.info(`Storage backend: ${describeStorage()}`);
  for (const problem of storageProblems()) {
    logger.error(`Storage misconfigured: ${problem} — uploaded images will not load until this is fixed`);
  }

  // Image processing (sharp): every upload is re-encoded and stripped of its
  // metadata, so a missing native binary must be visible at boot.
  logger.info(`Image processing: ${imageProcessingStatus()}`);

  // Shoppers' photos no order took are deleted after CUSTOMER_UPLOAD_TTL_HOURS.
  startUploadSweep();


  // And for couriers: which adapters this process actually switched on, from
  // CARRIERS_ENABLED / CARRIERS_BETA / CARRIERS_BETA_WORKSPACES as parsed.
  await logCarrierRollout(logger);

  // Sign-up and go-live switches (REQUIRE_*), and a verification switch with
  // no email provider behind it (sign-ups are refused until one is set).
  signupPolicy.logBootState(logger);
  // With REQUIRE_SUBSCRIPTION_TO_GO_LIVE off, drafts left from while it was
  // on become the trials they would have been.
  try {
    const released = await releaseDraftsWhenOff();
    if (released > 0) logger.info(`Released ${released} draft store(s): REQUIRE_SUBSCRIPTION_TO_GO_LIVE is off`);
  } catch (err) {
    logger.error('Could not release draft stores', { message: err.message });
  }

  const server = app.listen(env.port, () => {
    logger.info(`Zimos backend listening on port ${env.port}`, { env: env.nodeEnv });
  });
  // Idle keep-alive connections stay open longer than the proxy in front keeps
  // them (Node's default is 5 s), so the proxy never sends a request down a
  // connection Node is closing at that moment (a stray 502). headersTimeout
  // must be above keepAliveTimeout or Node can drop a request whose headers
  // arrive late on a reused connection.
  server.keepAliveTimeout = env.http.keepAliveTimeoutMs;
  server.headersTimeout = env.http.keepAliveTimeoutMs + 1000;

  // Live updates over Socket.IO on this same server: only with REALTIME_ENABLED=true.
  realtime.attach(server, app);

  // Outbound webhooks: find order changes and send them, every few seconds
  // Only with WEBHOOKS_IN_PROCESS=true; otherwise scripts/dispatch-webhooks.js does it.
  if (env.webhooks.inProcess) webhookWorker.start();

  // Background jobs and domain events (core/queue, core/outbox): run here only
  // with WORKER_IN_PROCESS=true; a separate `node src/worker.js` can run them instead.
  if (env.queue.inProcess) {
    workerRuntime.start().catch((err) => logger.error('Could not start the in-process worker', { message: err.message }));
  }

  const shutdown = (signal) => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    webhookWorker.stop();
    // Open sockets first: the server does not close while they are open.
    void realtime.stop();
    server.close(async () => {
      await workerRuntime.stop();
      // The live updates' database pool, once the worker no longer publishes through it.
      await realtime.release();
      await db.sequelize.close();
      process.exit(0);
    });
    // Force-exit if graceful shutdown hangs.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: reason && reason.message ? reason.message : reason });
  });
}

start();
