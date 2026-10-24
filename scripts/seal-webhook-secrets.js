#!/usr/bin/env node
'use strict';

/**
 * Seals the webhook signing secrets still kept in clear (migration 714,
 * modules/webhooks/signingSecretStore.js), or — with --unseal — puts sealed
 * ones back in clear, which is what undoing migration 714 needs first.
 *
 * Dry run by default: prints how many endpoints would change, and writes
 * nothing. --apply writes: each endpoint is locked, read again, sealed (or
 * opened), checked by opening the result back to the same secret, and
 * updated in its own transaction. A secret is never printed.
 *
 *   node scripts/seal-webhook-secrets.js                        # dry run
 *   node scripts/seal-webhook-secrets.js --apply                # seal
 *   node scripts/seal-webhook-secrets.js --unseal --apply       # back in clear
 *   node scripts/seal-webhook-secrets.js --workspace <uuid>     # one store
 *
 * Needs WEBHOOK_SECRETS_KEY (32 bytes, base64) — the same value the API runs
 * with, or the API cannot open what this sealed. Under NODE_ENV=production,
 * --apply also needs --confirm-production: this changes stored secrets.
 * Sealing does not need WEBHOOK_SECRET_SEALING on; the API reads either form.
 *
 * Runs against whatever database src/config/env resolves (DATABASE_URL / DB_*).
 */

const db = require('../src/db/models');
const env = require('../src/config/env');
const cipher = require('../src/core/utils/credentialsCipher');
const secretStore = require('../src/modules/webhooks/signingSecretStore');

function readArgs(argv) {
  const args = { apply: false, unseal: false, workspace: null, confirmProduction: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--unseal') args.unseal = true;
    else if (a === '--confirm-production') args.confirmProduction = true;
    else if (a === '--workspace') args.workspace = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

async function candidates({ unseal, workspace }) {
  const where = unseal ? { signingSecretSealed: { [db.Sequelize.Op.ne]: null } } : { signingSecretSealed: null, signingSecret: { [db.Sequelize.Op.ne]: null } };
  if (workspace) where.workspaceId = workspace;
  return db.WebhookEndpoint.findAll({ where, attributes: ['id', 'workspaceId'], order: [['createdAt', 'ASC']] });
}

/** One endpoint, in its own transaction. Returns 'changed', 'skipped' (changed meanwhile) or throws. */
async function convert(id, { unseal, key }) {
  return db.sequelize.transaction(async (transaction) => {
    const endpoint = await db.WebhookEndpoint.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!endpoint) return 'skipped';
    if (unseal) {
      if (!endpoint.signingSecretSealed) return 'skipped';
      const secret = secretStore.readSecret(endpoint);
      if (!secret) throw new Error(`endpoint ${id}: sealed value opened to nothing`);
      await endpoint.update({ signingSecret: secret, signingSecretSealed: null }, { transaction });
      return 'changed';
    }
    if (endpoint.signingSecretSealed || !endpoint.signingSecret) return 'skipped';
    const sealed = secretStore.seal(endpoint.workspaceId, endpoint.id, endpoint.signingSecret, key);
    // Opened back before the clear value is dropped: a key that cannot read its own output stops here.
    const reopened = secretStore.readSecret({ id: endpoint.id, workspaceId: endpoint.workspaceId, signingSecretSealed: sealed });
    if (reopened !== endpoint.signingSecret) throw new Error(`endpoint ${id}: sealed value does not open to the same secret`);
    await endpoint.update({ signingSecret: null, signingSecretSealed: sealed }, { transaction });
    return 'changed';
  });
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const key = cipher.parseKey(env.webhooks.secretsKey, 'WEBHOOK_SECRETS_KEY');
  if (!key) throw new Error('WEBHOOK_SECRETS_KEY is not set (or is not 32 bytes of base64): nothing can be sealed or opened');
  if (args.apply && env.isProduction && !args.confirmProduction) {
    throw new Error('NODE_ENV=production: add --confirm-production to change stored secrets');
  }

  const rows = await candidates(args);
  const verb = args.unseal ? 'unseal' : 'seal';
  console.log(`${rows.length} endpoint(s) to ${verb}${args.workspace ? ` in workspace ${args.workspace}` : ''}.`);
  if (!args.apply) {
    console.log('Dry run: nothing written. Add --apply to write.');
    return;
  }

  const tally = { changed: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    try {
      tally[await convert(row.id, { unseal: args.unseal, key })] += 1;
    } catch (err) {
      tally.failed += 1;
      console.error(`endpoint ${row.id}: ${err.message}`);
    }
  }
  console.log(`Done: ${tally.changed} changed, ${tally.skipped} skipped, ${tally.failed} failed.`);
  if (tally.failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => db.sequelize.close());
}

module.exports = { convert, candidates, readArgs };
