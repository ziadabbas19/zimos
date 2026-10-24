'use strict';

/**
 * Runs one migration step in its own transaction with a lock_timeout, and
 * tries again a few times when the lock was not granted in time.
 *
 * Why: a statement that needs a lock on a busy table (a foreign key to
 * `orders` takes SHARE ROW EXCLUSIVE on it) waits behind any long
 * transaction already holding a conflicting lock — and every write to that
 * table queues behind the waiting statement. With a lock_timeout the step
 * gives up after `timeout` instead, nothing queued behind it waits longer,
 * and it is tried again `attempts` times, `pauseMs` apart. Still failing,
 * the error (55P03 lock_not_available) stops the migration: run it again
 * when the table is quieter.
 *
 * `fn(transaction)` runs the step's statements on that transaction.
 */
async function withLockTimeout(sequelize, fn, { timeout = '5s', attempts = 5, pauseMs = 2000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await sequelize.transaction(async (transaction) => {
        await sequelize.query(`SET LOCAL lock_timeout = '${timeout}'`, { transaction });
        return fn(transaction);
      });
    } catch (err) {
      const code = ((err && (err.parent || err.original)) || err || {}).code;
      if (code !== '55P03' || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
}

/** Whether a constraint of this name exists (ADD CONSTRAINT has no IF NOT EXISTS). */
async function constraintExists(sequelize, name, transaction) {
  const [rows] = await sequelize.query('SELECT 1 FROM pg_constraint WHERE conname = :name', { replacements: { name }, transaction });
  return rows.length > 0;
}

/**
 * A foreign key added the way that holds the least: NOT VALID first (a brief
 * lock on both tables, no scan), then VALIDATE in a second step (only SHARE
 * UPDATE EXCLUSIVE on the referencing table, ROW SHARE on the referenced one:
 * writes go on). Each step under withLockTimeout. Run-twice safe.
 */
async function addForeignKey(sequelize, { table, name, definition }) {
  await withLockTimeout(sequelize, async (transaction) => {
    if (!(await constraintExists(sequelize, name, transaction))) {
      await sequelize.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition} NOT VALID`, { transaction });
    }
  });
  await withLockTimeout(sequelize, (transaction) => sequelize.query(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`, { transaction }));
}

module.exports = { withLockTimeout, constraintExists, addForeignKey };
