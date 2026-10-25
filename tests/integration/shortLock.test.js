'use strict';

// db/shortLock.js (migration 718): a heavy-lock DDL statement gives up after
// lock_timeout while another transaction holds the table — instead of
// queueing every query behind it — tries again, and goes through once the
// table is free. lock_timeout is SET LOCAL: the pooled connection keeps none.

const { QueryTypes } = require('sequelize');
const db = require('../../src/db/models');
const { withShortLock } = require('../../src/db/shortLock');

const qi = db.sequelize.getQueryInterface();
const TABLE = 'short_lock_probe';

it('gives up while the table is held, tries again, and goes through once it is free', async () => {
  await db.sequelize.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await db.sequelize.query(`CREATE TABLE ${TABLE} (id INT)`);

  let lockTaken;
  let release;
  const taken = new Promise((resolve) => {
    lockTaken = resolve;
  });
  const done = new Promise((resolve) => {
    release = resolve;
  });
  // A reader that stays in its transaction (a long report): enough to block an ALTER.
  const holder = db.sequelize.transaction(async (transaction) => {
    await db.sequelize.query(`LOCK TABLE ${TABLE} IN ACCESS SHARE MODE`, { transaction });
    lockTaken();
    await done;
  });

  try {
    await taken;
    const started = Date.now();
    let error = null;
    try {
      await withShortLock(qi, `ALTER TABLE ${TABLE} ADD COLUMN probe INT`, { tries: 2, pauseMs: 10 });
    } catch (err) {
      error = err;
    }
    expect(error).not.toBeNull();
    expect((error.original || error.parent || error).code).toBe('55P03');
    // Two tries of about three seconds each, not a wait for as long as the holder lasts.
    expect(Date.now() - started).toBeGreaterThanOrEqual(5500);
    expect(Date.now() - started).toBeLessThan(15000);

    release();
    await holder;
    await withShortLock(qi, `ALTER TABLE ${TABLE} ADD COLUMN probe INT`);
    const cols = await db.sequelize.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = '${TABLE}' AND column_name = 'probe'`,
      { type: QueryTypes.SELECT }
    );
    expect(cols).toHaveLength(1);

    // Nothing is left on the connection: a fresh query sees the server's own lock_timeout.
    const [setting] = await db.sequelize.query('SHOW lock_timeout', { type: QueryTypes.SELECT });
    expect(setting.lock_timeout).not.toBe('3s');
  } finally {
    release();
    await holder;
    await db.sequelize.query(`DROP TABLE IF EXISTS ${TABLE}`);
  }
}, 30000);
