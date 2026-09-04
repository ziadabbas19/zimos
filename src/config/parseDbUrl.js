'use strict';

/**
 * Parses a single Postgres connection string (Railway / Heroku style:
 * `postgres://user:pass@host:port/dbname?sslmode=require`) into the discrete
 * fields the rest of the config uses. Returns null when given nothing so
 * callers can fall back to the separate DB_HOST/DB_PORT/... variables.
 */
function parseDbUrl(url) {
  if (!url) return null;

  let u;
  try {
    u = new URL(url);
  } catch (err) {
    throw new Error(`DATABASE_URL is not a valid connection string (starts with "${String(url).slice(0, 12)}...")`);
  }

  const sslmode = (u.searchParams.get('sslmode') || u.searchParams.get('ssl') || '').toLowerCase();

  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 5432,
    name: decodeURIComponent(u.pathname.replace(/^\//, '')),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: ['require', 'verify-ca', 'verify-full', 'true', '1'].includes(sslmode),
  };
}

module.exports = { parseDbUrl };
