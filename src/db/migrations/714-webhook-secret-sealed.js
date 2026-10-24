'use strict';

const { guarded } = require('../migrationGuards');

/**
 * A webhook endpoint's signing secret, sealed (webhooks/signingSecretStore.js,
 * WEBHOOK_SECRET_SEALING):
 *
 *   signing_secret_sealed  AES-256-GCM with WEBHOOK_SECRETS_KEY
 *                          (core/utils/credentialsCipher), bound to the
 *                          endpoint; null while the secret is kept in clear
 *   signing_secret         now nullable: null once the secret is sealed
 *
 * Nothing is rewritten here: rows keep their secret in clear until
 * scripts/seal-webhook-secrets.js --apply seals them. Additive and run-twice
 * safe. Down refuses while any secret is only sealed — dropping the column
 * then would lose it; `node scripts/seal-webhook-secrets.js --unseal --apply`
 * puts them back in clear first.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.addColumn('webhook_endpoints', 'signing_secret_sealed', { type: Sequelize.TEXT, allowNull: true });
    await queryInterface.sequelize.query('ALTER TABLE webhook_endpoints ALTER COLUMN signing_secret DROP NOT NULL');
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    const [[row]] = await queryInterface.sequelize.query('SELECT count(*)::int AS n FROM webhook_endpoints WHERE signing_secret IS NULL');
    if (row.n > 0) {
      throw new Error(
        `${row.n} webhook endpoint(s) hold their signing secret sealed only: run "node scripts/seal-webhook-secrets.js --unseal --apply" before undoing migration 714`
      );
    }
    await queryInterface.sequelize.query('ALTER TABLE webhook_endpoints ALTER COLUMN signing_secret SET NOT NULL');
    await qi.removeColumn('webhook_endpoints', 'signing_secret_sealed');
  },
};
