'use strict';

const { Sequelize } = require('sequelize');
const env = require('../config/env');
const logger = require('../core/utils/logger');

// Production never logs SQL; dev logs it at debug. Under NODE_ENV=test it is
// off (it was most of a suite run's output) unless LOG_SQL=1, which writes it
// straight to stdout so it shows even though the test log level is warn.
function sqlLogging() {
  if (env.isProduction) return false;
  if (env.isTest) return process.env.LOG_SQL === '1' ? (msg) => process.stdout.write(msg + '\n') : false;
  return (msg) => logger.debug(msg);
}

const sequelize = new Sequelize(env.db.name, env.db.user, env.db.password, {
  host: env.db.host,
  port: env.db.port,
  dialect: 'postgres',
  logging: sqlLogging(),
  dialectOptions: env.db.ssl ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  pool: {
    max: env.db.poolMax,
    min: env.db.poolMin,
    idle: env.db.poolIdleMs,
    acquire: 30000,
  },
  define: {
    underscored: true,
    timestamps: true,
  },
});

module.exports = sequelize;
