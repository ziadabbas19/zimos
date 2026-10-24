'use strict';

const { withLockTimeout, addForeignKey } = require('../lockTimeout');

/**
 * api_key_order_acks: which accepted orders each API key has confirmed it
 * received (publicApi/acceptedOrdersFeed.js, PUBLIC_API_ACK_ENABLED). A till
 * or kitchen system behind a local network cannot receive webhooks, so it
 * pulls the accepted orders its key has not acknowledged yet, then
 * acknowledges each one it took. One row per key and order: two systems
 * with two keys each get every order.
 *
 *   api_key_id  the key (revoking keeps the row; deleting the key drops it)
 *   order_id    the order (deleting the order drops it)
 *   acked_at    when the key acknowledged it; acknowledging again changes nothing
 *
 * The primary key (api_key_id, order_id) is what the feed's NOT EXISTS reads;
 * the order_id index serves the cascade when an order is deleted.
 *
 * The table is created bare, then each foreign key is added NOT VALID and
 * validated in its own step, every step under a lock_timeout with retries
 * (db/lockTimeout.js): a foreign key to `orders` locks that busy table, and
 * must never leave its writes queued behind a long transaction.
 *
 * Nothing existing changes. Run-twice safe; down drops the table (each key's
 * feed would offer its acknowledged orders again).
 */
module.exports = {
  up: async (queryInterface) => {
    const { sequelize } = queryInterface;
    await withLockTimeout(sequelize, async (transaction) => {
      await sequelize.query(
        `CREATE TABLE IF NOT EXISTS api_key_order_acks (
           api_key_id UUID NOT NULL,
           order_id UUID NOT NULL,
           acked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           PRIMARY KEY (api_key_id, order_id)
         )`,
        { transaction }
      );
      await sequelize.query('CREATE INDEX IF NOT EXISTS api_key_order_acks_order_id_idx ON api_key_order_acks (order_id)', { transaction });
    });
    await addForeignKey(sequelize, {
      table: 'api_key_order_acks',
      name: 'api_key_order_acks_api_key_id_fkey',
      definition: 'FOREIGN KEY (api_key_id) REFERENCES api_keys (id) ON DELETE CASCADE',
    });
    await addForeignKey(sequelize, {
      table: 'api_key_order_acks',
      name: 'api_key_order_acks_order_id_fkey',
      definition: 'FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE',
    });
  },

  down: async (queryInterface) => {
    const { sequelize } = queryInterface;
    await withLockTimeout(sequelize, (transaction) => sequelize.query('DROP TABLE IF EXISTS api_key_order_acks', { transaction }));
  },
};
