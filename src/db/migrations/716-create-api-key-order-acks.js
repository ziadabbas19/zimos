'use strict';

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
 * A new table only: nothing existing changes. Run-twice safe; down drops it
 * (each key's feed would offer its acknowledged orders again).
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS api_key_order_acks (
        api_key_id UUID NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
        order_id UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
        acked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (api_key_id, order_id)
      )`);
    await queryInterface.sequelize.query('CREATE INDEX IF NOT EXISTS api_key_order_acks_order_id_idx ON api_key_order_acks (order_id)');
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS api_key_order_acks');
  },
};
