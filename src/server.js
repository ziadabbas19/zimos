'use strict';

const app = require('./app');
const env = require('./config/env');
const db = require('./db/models');
const logger = require('./core/utils/logger');

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

  const server = app.listen(env.port, () => {
    logger.info(`Zimos backend listening on port ${env.port}`, { env: env.nodeEnv });
  });

  const shutdown = (signal) => {
    logger.info(`Received ${signal}, shutting down gracefully`);
    server.close(async () => {
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
