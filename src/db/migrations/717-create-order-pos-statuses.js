'use strict';

const { withLockTimeout, addForeignKey } = require('../lockTimeout');

/**
 * order_pos_statuses: where an order stands in the merchant's own till or
 * kitchen, as that system reports it through the public API
 * (publicApi/posStatus.js, PUBLIC_API_ACK_ENABLED). A note beside the order,
 * never its stage: nothing in Zimos moves because of it, and the orders
 * table is not altered.
 *
 *   order_id      one row per order
 *   workspace_id  the order's store
 *   status        received | preparing | ready | completed (VARCHAR + CHECK)
 *   reference     the order's number in that system, if it sent one
 *   api_key_id    the key that set it last (null once that key is deleted)
 *
 * The table is created bare, then each foreign key is added NOT VALID and
 * validated in its own step, every step under a lock_timeout with retries
 * (db/lockTimeout.js): a foreign key to `orders` locks that busy table.
 *
 * Run-twice safe; down drops the table (the statuses go with it).
 */

const STATUSES = ['received', 'preparing', 'ready', 'completed'];

module.exports = {
  up: async (queryInterface) => {
    const { sequelize } = queryInterface;
    await withLockTimeout(sequelize, (transaction) =>
      sequelize.query(
        `CREATE TABLE IF NOT EXISTS order_pos_statuses (
           order_id UUID PRIMARY KEY,
           workspace_id UUID NOT NULL,
           status VARCHAR(20) NOT NULL CONSTRAINT order_pos_statuses_status_check CHECK (status IN (${STATUSES.map((s) => `'${s}'`).join(', ')})),
           reference VARCHAR(120),
           api_key_id UUID,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`,
        { transaction }
      )
    );
    await addForeignKey(sequelize, {
      table: 'order_pos_statuses',
      name: 'order_pos_statuses_order_id_fkey',
      definition: 'FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE',
    });
    await addForeignKey(sequelize, {
      table: 'order_pos_statuses',
      name: 'order_pos_statuses_workspace_id_fkey',
      definition: 'FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE',
    });
    await addForeignKey(sequelize, {
      table: 'order_pos_statuses',
      name: 'order_pos_statuses_api_key_id_fkey',
      definition: 'FOREIGN KEY (api_key_id) REFERENCES api_keys (id) ON DELETE SET NULL',
    });
  },

  down: async (queryInterface) => {
    const { sequelize } = queryInterface;
    await withLockTimeout(sequelize, (transaction) => sequelize.query('DROP TABLE IF EXISTS order_pos_statuses', { transaction }));
  },
};
