'use strict';

/**
 * The table @socket.io/postgres-adapter and @socket.io/postgres-emitter keep
 * a message in when it is too big for a NOTIFY (8000 bytes) or carries binary
 * data (modules/realtime). The live updates send ids only, far below that, so
 * in practice it stays empty; the adapter still reads and cleans it (every
 * 30 seconds, rows older than that), so it has to exist. The columns are the
 * ones the library documents. Nothing else reads or writes it, and nothing
 * touches it at all while REALTIME_ENABLED is off.
 *
 * A new table only: nothing existing changes. Harmless if it runs again (IF
 * NOT EXISTS). Down drops it; with REALTIME_ENABLED off nothing misses it.
 */

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS socket_io_attachments (
        id          bigserial UNIQUE,
        created_at  timestamptz DEFAULT NOW(),
        payload     bytea
      )`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS socket_io_attachments');
  },
};
