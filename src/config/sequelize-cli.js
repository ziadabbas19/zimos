'use strict';
// Config consumed by sequelize-cli (migrations/seeders run outside the app boot path).
require('dotenv').config();

const base = {
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  dialect: 'postgres',
  logging: false,
};

module.exports = {
  development: { ...base, database: process.env.DB_NAME || 'storebuilder_dev' },
  test: { ...base, database: process.env.DB_NAME_TEST || 'storebuilder_test' },
  production: {
    ...base,
    database: process.env.DB_NAME,
    dialectOptions: process.env.DB_SSL === 'true' ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  },
};
