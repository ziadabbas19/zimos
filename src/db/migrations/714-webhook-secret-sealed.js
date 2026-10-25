'use strict';

const { guarded } = require('../migrationGuards');
const { withLockTimeout, constraintExists } = require('../lockTimeout');

/**
 * A webhook endpoint's signing secret, sealed (webhooks/signingSecretStore.js,
 * WEBHOOK_SECRET_SEALING):
 *
 *   signing_secret_sealed  AES-256-GCM with WEBHOOK_SECRETS_KEY
 *                          (core/utils/credentialsCipher), bound to the
 *                          endpoint; null while the secret is kept in clear
 *   signing_secret         now nullable: null once the secret is sealed
 *   CHECK                  one of the two always holds the secret: a row
 *                          with neither could sign nothing
 *
 * Nothing is rewritten here: rows keep their secret in clear until
 * scripts/seal-webhook-secrets.js --apply seals them. The CHECK is added NOT
 * VALID and then validated, every step — the column too — under a
 * lock_timeout with retries (db/lockTimeout.js). Additive and run-twice safe. Down refuses while any
 * secret is only sealed — dropping the column then would lose it;
 * `node scripts/seal-webhook-secrets.js --unseal --apply` puts them back in
 * clear first.
 */

const PRESENT = 'webhook_endpoints_signing_secret_present';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { sequelize } = queryInterface;
    await withLockTimeout(sequelize, (transaction) =>
      qi.addColumn('webhook_endpoints', 'signing_secret_sealed', { type: Sequelize.TEXT, allowNull: true }, { transaction })
    );
    await withLockTimeout(sequelize, async (transaction) => {
      await sequelize.query('ALTER TABLE webhook_endpoints ALTER COLUMN signing_secret DROP NOT NULL', { transaction });
      if (!(await constraintExists(sequelize, PRESENT, transaction))) {
        await sequelize.query(
          `ALTER TABLE webhook_endpoints ADD CONSTRAINT ${PRESENT} CHECK (signing_secret IS NOT NULL OR signing_secret_sealed IS NOT NULL) NOT VALID`,
          { transaction }
        );
      }
    });
    await withLockTimeout(sequelize, (transaction) => sequelize.query(`ALTER TABLE webhook_endpoints VALIDATE CONSTRAINT ${PRESENT}`, { transaction }));
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    const { sequelize } = queryInterface;
    const [[row]] = await sequelize.query('SELECT count(*)::int AS n FROM webhook_endpoints WHERE signing_secret IS NULL');
    if (row.n > 0) {
      throw new Error(
        `${row.n} webhook endpoint(s) hold their signing secret sealed only: run "node scripts/seal-webhook-secrets.js --unseal --apply" before undoing migration 714`
      );
    }
    await withLockTimeout(sequelize, async (transaction) => {
      await sequelize.query(`ALTER TABLE webhook_endpoints DROP CONSTRAINT IF EXISTS ${PRESENT}`, { transaction });
      await sequelize.query('ALTER TABLE webhook_endpoints ALTER COLUMN signing_secret SET NOT NULL', { transaction });
    });
    await withLockTimeout(sequelize, (transaction) => qi.removeColumn('webhook_endpoints', 'signing_secret_sealed', { transaction }));
  },
};
