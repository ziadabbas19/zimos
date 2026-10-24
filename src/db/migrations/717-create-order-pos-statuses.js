'use strict';

/**
 * order_pos_statuses: where an order stands in the merchant's own till or
 * kitchen, as that system reports it through the public API
 * (publicApi/posStatus.js, PUBLIC_API_ACK_ENABLED). A note beside the order,
 * never its stage: nothing in Zimos moves because of it, and the orders
 * table is not touched.
 *
 *   order_id      one row per order
 *   workspace_id  the order's store
 *   status        received | preparing | ready | completed (VARCHAR + CHECK)
 *   reference     the order's number in that system, if it sent one
 *   api_key_id    the key that set it last (null once that key is deleted)
 *
 * A new table only. Run-twice safe; down drops it (the statuses go with it).
 */

const STATUSES = ['received', 'preparing', 'ready', 'completed'];

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS order_pos_statuses (
        order_id UUID PRIMARY KEY REFERENCES orders (id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL CONSTRAINT order_pos_statuses_status_check CHECK (status IN (${STATUSES.map((s) => `'${s}'`).join(', ')})),
        reference VARCHAR(120),
        api_key_id UUID REFERENCES api_keys (id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS order_pos_statuses');
  },
};
