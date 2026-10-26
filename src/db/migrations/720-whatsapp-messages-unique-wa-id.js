'use strict';

const { createIndexConcurrently, dropIndexConcurrently } = require('../concurrentIndex');

/**
 * whatsapp_messages: one row per Meta message id in a store.
 *
 * The webhook looked for (workspace_id, wa_message_id) before inserting
 * (whatsappService.handleWebhook), but nothing held it: two deliveries of the
 * same message at the same moment could both insert, and the bot answered
 * each copy. Now:
 *
 *  1. Rows sharing a (workspace_id, wa_message_id) are removed but the oldest
 *     (created_at, then id). In batches of BATCH ids, each in its own short
 *     transaction under SET LOCAL lock_timeout, so a busy table makes a batch
 *     give up and retry instead of queueing writes behind it. Nothing
 *     references whatsapp_messages by key; a removed copy's queued bot job
 *     finds no message and stops ('gone').
 *  2. whatsapp_messages_ws_wamid_unique: UNIQUE (workspace_id, wa_message_id),
 *     built CONCURRENTLY (sequelize-cli runs a migration without a wrapping
 *     transaction). Rows without an id (a failed send) are NULL and never
 *     clash. A copy that arrives between 1 and 2 fails the build: the leftover
 *     invalid index is dropped and 1-2 run again, up to ATTEMPTS times.
 *
 * The two plain indexes on the same columns (134's whatsapp_messages_ws_wamid_idx,
 * 156's whatsapp_messages_wa_id_idx) are left as they are.
 *
 * Run-twice safe. down() drops the unique index only; removed copies stay removed.
 */

const NAME = 'whatsapp_messages_ws_wamid_unique';
const BATCH = 500;
const LOCK_TIMEOUT = '3s';
const ATTEMPTS = 3;
const BATCH_TRIES = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lockTimedOut = (err) => (err && err.parent ? err.parent.code : err && err.code) === '55P03';
const uniqueViolation = (err) => (err && err.parent ? err.parent.code : err && err.code) === '23505';

/** One batch: up to BATCH extra copies removed. Resolves to how many. */
async function removeBatch(sequelize) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`, { transaction });
    const [rows] = await sequelize.query(
      `WITH groups AS (
         SELECT workspace_id, wa_message_id
           FROM whatsapp_messages
          WHERE wa_message_id IS NOT NULL
          GROUP BY workspace_id, wa_message_id
         HAVING count(*) > 1
          LIMIT ${BATCH}
       ), ranked AS (
         SELECT m.id, row_number() OVER (PARTITION BY m.workspace_id, m.wa_message_id ORDER BY m.created_at ASC, m.id ASC) AS rank
           FROM whatsapp_messages m
           JOIN groups g ON g.workspace_id = m.workspace_id AND g.wa_message_id = m.wa_message_id
       ), doomed AS (
         SELECT id FROM ranked WHERE rank > 1 LIMIT ${BATCH}
       )
       DELETE FROM whatsapp_messages m USING doomed WHERE m.id = doomed.id
       RETURNING m.id`,
      { transaction }
    );
    return rows.length;
  });
}

async function removeCopies(sequelize) {
  let removed = 0;
  for (;;) {
    let count = null;
    for (let tryNo = 1; count === null; tryNo += 1) {
      try {
        count = await removeBatch(sequelize);
      } catch (err) {
        if (!lockTimedOut(err) || tryNo >= BATCH_TRIES) throw err;
        await sleep(1000 * tryNo);
      }
    }
    removed += count;
    if (count === 0) return removed;
  }
}

module.exports = {
  up: async (queryInterface) => {
    const { sequelize } = queryInterface;
    for (let attempt = 1; ; attempt += 1) {
      const removed = await removeCopies(sequelize);
      // eslint-disable-next-line no-console
      if (removed > 0) console.log(`720: removed ${removed} duplicate whatsapp_messages row(s), kept the oldest of each`);
      try {
        await createIndexConcurrently(queryInterface, { name: NAME, table: 'whatsapp_messages', definition: '(workspace_id, wa_message_id)', unique: true });
        return;
      } catch (err) {
        if (!uniqueViolation(err) || attempt >= ATTEMPTS) throw err;
        // A copy arrived during the build; the invalid index left behind is dropped by the next call.
      }
    }
  },

  down: async (queryInterface) => {
    await dropIndexConcurrently(queryInterface, NAME);
  },
};
