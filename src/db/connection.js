'use strict';

const { Sequelize } = require('sequelize');
const env = require('../config/env');
const logger = require('../core/utils/logger');

const sequelize = new Sequelize(env.db.name, env.db.user, env.db.password, {
  host: env.db.host,
  port: env.db.port,
  dialect: 'postgres',
  logging: env.isProduction ? false : (msg) => logger.debug(msg),
  dialectOptions: env.db.ssl ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  pool: {
    max: env.db.poolMax,
    min: env.db.poolMin,
    idle: 10000,
    acquire: 30000,
  },
  define: {
    underscored: true,
    timestamps: true,
  },
});

module.exports = sequelize;
