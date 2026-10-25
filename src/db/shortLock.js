'use strict';

/**
 * DDL that takes a heavy lock, run so that it never stalls the table it
 * touches. For migrations, next to concurrentIndex.js.
 *
 * ALTER TABLE … ADD COLUMN / ADD CONSTRAINT takes ACCESS EXCLUSIVE on the
 * table, and a foreign key SHARE ROW EXCLUSIVE on the table it points at.
 * Taking them is quick; waiting for them is what hurts: an ALTER queued
 * behind a long transaction (a heavy report, the webhook scanner reading its
 * pages) holds every new query on that table behind it, so the checkout and
 * the dashboard stop until it gets through.
 *
 * `withShortLock` runs its statements in one short transaction under
 * SET LOCAL lock_timeout (LOCAL: a plain SET would stay on the pooled
 * connection after the migration). When the lock is not granted in time
 * (55P03 lock_not_available) it gives up — the queue behind it drains — waits
 * and tries again, up to `tries` times, then throws and the deploy stops
 * before the API starts. The statements must be quick once the lock is held:
 * no table scan and no rewrite (a CHECK goes in NOT VALID and is validated by
 * a call of its own, whose lock lets reads and writes go on).
 */

const LOCK_TIMEOUT = '3s';
const LOCK_NOT_AVAILABLE = '55P03';

async function withShortLock(queryInterface, statements, { tries = 10, pauseMs = 2000 } = {}) {
  const { sequelize } = queryInterface;
  const list = Array.isArray(statements) ? statements : [statements];
  for (let attempt = 1; ; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await sequelize.transaction(async (transaction) => {
        await sequelize.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`, { transaction });
        for (const sql of list) await sequelize.query(sql, { transaction });
      });
      return;
    } catch (err) {
      const code = err && ((err.original && err.original.code) || (err.parent && err.parent.code) || err.code);
      if (code !== LOCK_NOT_AVAILABLE || attempt >= tries) throw err;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
}

module.exports = { withShortLock, LOCK_TIMEOUT };
