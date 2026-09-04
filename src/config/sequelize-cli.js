'use strict';
// Config consumed by sequelize-cli (migrations/seeders run outside the app boot path).
require('dotenv').config();

const { parseDbUrl } = require('./parseDbUrl');

const base = {
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  dialect: 'postgres',
  logging: false,
};

// A single DATABASE_URL (Railway / Heroku) wins over the separate DB_* vars
// for dev and production migrations; the test config always uses the
// dedicated test database.
const dbUrl = parseDbUrl(process.env.DATABASE_URL);
const sslOn = (dbUrl && dbUrl.ssl) || process.env.DB_SSL === 'true';
const dialectOptions = sslOn ? { ssl: { require: true, rejectUnauthorized: false } } : {};

const fromUrl = dbUrl && {
  username: dbUrl.user,
  password: dbUrl.password,
  host: dbUrl.host,
  port: dbUrl.port,
  database: dbUrl.name,
  dialect: 'postgres',
  dialectOptions,
  logging: false,
};

module.exports = {
  development: fromUrl || { ...base, database: process.env.DB_NAME || 'zimos_dev' },
  test: { ...base, database: process.env.DB_NAME_TEST || 'zimos_test' },
  production: fromUrl || {
    ...base,
    database: process.env.DB_NAME,
    dialectOptions,
  },
};
