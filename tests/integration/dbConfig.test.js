'use strict';

// DATABASE_URL support in the DB config: parse it when set, fall back to the
// separate DB_* vars otherwise, and never let it hijack the test database.

const path = require('path');
const { execFileSync } = require('child_process');
const { parseDbUrl } = require('../../src/config/parseDbUrl');

describe('parseDbUrl', () => {
  it('returns null for a missing value', () => {
    expect(parseDbUrl('')).toBeNull();
    expect(parseDbUrl(undefined)).toBeNull();
  });

  it('parses a Railway-style connection string', () => {
    expect(parseDbUrl('postgresql://postgres:s3cr3t@postgres.railway.internal:5432/railway')).toEqual({
      host: 'postgres.railway.internal',
      port: 5432,
      name: 'railway',
      user: 'postgres',
      password: 's3cr3t',
      ssl: false,
    });
  });

  it('url-decodes credentials and reads sslmode', () => {
    const p = parseDbUrl('postgres://us%40r:p%40ss%2Fword@monorail.proxy.rlwy.net:41234/db?sslmode=require');
    expect(p.user).toBe('us@r');
    expect(p.password).toBe('p@ss/word');
    expect(p.port).toBe(41234);
    expect(p.ssl).toBe(true);
  });

  it('defaults the port to 5432 when the URL omits it', () => {
    expect(parseDbUrl('postgres://u:p@somehost/mydb').port).toBe(5432);
  });

  it('throws a clear error on a malformed string', () => {
    expect(() => parseDbUrl('not-a-connection-string')).toThrow(/DATABASE_URL is not a valid/);
  });
});

// Run config resolution in a clean child process so nothing here touches the
// module cache or process.env of the running suite.
function resolveDb(envOverrides) {
  const script = "process.stdout.write('\\n@@' + JSON.stringify(require('./src/config/env').db))";
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: '', ...envOverrides },
  }).toString();
  // dotenv prints a banner to stdout; our payload is prefixed with @@.
  return JSON.parse(out.slice(out.lastIndexOf('@@') + 2));
}

describe('env.db resolution', () => {
  it('uses DATABASE_URL when set (non-test env)', () => {
    const db = resolveDb({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://ruser:rpass@rhost.internal:6543/proddb?sslmode=require',
    });
    expect(db).toMatchObject({
      host: 'rhost.internal',
      port: 6543,
      name: 'proddb',
      user: 'ruser',
      password: 'rpass',
      ssl: true,
    });
  });

  it('falls back to the separate DB_* vars when DATABASE_URL is absent', () => {
    const db = resolveDb({
      NODE_ENV: 'development',
      DB_HOST: 'db.example.com',
      DB_PORT: '6000',
      DB_NAME: 'localdb',
      DB_USER: 'localu',
      DB_PASSWORD: 'localp',
    });
    expect(db).toMatchObject({ host: 'db.example.com', port: 6000, name: 'localdb', user: 'localu', url: null });
  });

  it('ignores DATABASE_URL under NODE_ENV=test and keeps the test database', () => {
    const db = resolveDb({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://ruser:rpass@rhost.internal:6543/proddb',
      DB_NAME_TEST: 'zimos_test',
    });
    expect(db.name).toBe('zimos_test');
    expect(db.host).not.toBe('rhost.internal');
  });
});
