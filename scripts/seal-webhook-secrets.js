#!/usr/bin/env node
'use strict';

/**
 * The webhook signing secrets at rest (migration 714,
 * modules/webhooks/signingSecretStore.js):
 *
 *   (default)  seal the secrets still kept in clear, with WEBHOOK_SECRETS_KEY
 *   --unseal   put sealed ones back in clear (undoing migration 714 needs it)
 *   --reseal   seal again with WEBHOOK_SECRETS_KEY every secret sealed with
 *              WEBHOOK_SECRETS_KEY_PREVIOUS — the key rotation: set the new
 *              key and the old one as _PREVIOUS on the API, run this, then
 *              drop _PREVIOUS
 *
 * Dry run by default: prints the keys' fingerprints (8 hex characters, never
 * a key), how many sealed secrets open with each — a secret that opens with
 * neither means this is not the API's key — and how many endpoints would
 * change. Nothing is written.
 *
 * --apply writes, and needs --confirm-db <name>: the name of the database
 * this run is connected to, the way scripts/launch-reset.js asks for it, so
 * a production URL in the environment can never be written to by accident.
 * Each endpoint is locked, read again, changed, checked by opening the
 * result back to the same secret, and saved in its own transaction. A
 * secret is never printed.
 *
 *   node scripts/seal-webhook-secrets.js                                     # dry run
 *   node scripts/seal-webhook-secrets.js --apply --confirm-db <name>          # seal
 *   node scripts/seal-webhook-secrets.js --reseal --apply --confirm-db <name> # rotate
 *   node scripts/seal-webhook-secrets.js --unseal --apply --confirm-db <name> # back in clear
 *   node scripts/seal-webhook-secrets.js --workspace <uuid> …                 # one store
 *
 * Runs against whatever database src/config/env resolves (DATABASE_URL / DB_*).
 */

const db = require('../src/db/models');
const env = require('../src/config/env');
const cipher = require('../src/core/utils/credentialsCipher');
const secretStore = require('../src/modules/webhooks/signingSecretStore');

const MODES = ['seal', 'unseal', 'reseal'];

function readArgs(argv) {
  const args = { apply: false, mode: 'seal', workspace: null, confirmDb: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--unseal') args.mode = 'unseal';
    else if (a === '--reseal') args.mode = 'reseal';
    else if (a === '--confirm-db') args.confirmDb = argv[++i] || null;
    else if (a === '--workspace') args.workspace = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

/** Refuses --apply unless --confirm-db names the database actually connected. */
function assertTarget(args, databaseName) {
  if (!args.apply) return;
  if (!args.confirmDb) throw new Error(`--apply needs --confirm-db ${databaseName}: the name of the database this run would change`);
  if (args.confirmDb !== databaseName) throw new Error(`--confirm-db says "${args.confirmDb}" but this run is connected to "${databaseName}": nothing written`);
}

async function currentDatabase() {
  const [[row]] = await db.sequelize.query('SELECT current_database() AS name');
  return row.name;
}

async function candidates({ mode, workspace }) {
  const where = mode === 'seal' ? { signingSecretSealed: null, signingSecret: { [db.Sequelize.Op.ne]: null } } : { signingSecretSealed: { [db.Sequelize.Op.ne]: null } };
  if (workspace) where.workspaceId = workspace;
  return db.WebhookEndpoint.findAll({ where, attributes: ['id', 'workspaceId', 'signingSecretSealed'], order: [['createdAt', 'ASC']] });
}

/** How many sealed secrets open with the current key, the previous one, or neither. */
function census(rows) {
  const tally = { current: 0, previous: 0, neither: 0 };
  for (const row of rows) {
    if (!row.signingSecretSealed) continue;
    try {
      tally[secretStore.openSealed(row).which] += 1;
    } catch {
      tally.neither += 1;
    }
  }
  return tally;
}

/** One endpoint, in its own transaction. Returns 'changed', 'skipped' (nothing to do, or changed meanwhile) or throws. */
async function convert(id, { mode, key }) {
  return db.sequelize.transaction(async (transaction) => {
    const endpoint = await db.WebhookEndpoint.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!endpoint) return 'skipped';
    if (mode === 'unseal') {
      if (!endpoint.signingSecretSealed) return 'skipped';
      const secret = secretStore.readSecret(endpoint);
      if (!secret) throw new Error(`endpoint ${id}: sealed value opened to nothing`);
      await endpoint.update({ signingSecret: secret, signingSecretSealed: null }, { transaction });
      return 'changed';
    }
    let secret;
    if (mode === 'reseal') {
      if (!endpoint.signingSecretSealed) return 'skipped';
      const opened = secretStore.openSealed(endpoint);
      if (opened.which === 'current') return 'skipped';
      secret = opened.secret;
    } else {
      if (endpoint.signingSecretSealed || !endpoint.signingSecret) return 'skipped';
      secret = endpoint.signingSecret;
    }
    const sealed = secretStore.seal(endpoint.workspaceId, endpoint.id, secret, key);
    // Opened back with the current key before anything is dropped: a key that cannot read its own output stops here.
    const reopened = secretStore.openSealed({ id: endpoint.id, workspaceId: endpoint.workspaceId, signingSecretSealed: sealed });
    if (reopened.which !== 'current' || reopened.secret !== secret) throw new Error(`endpoint ${id}: sealed value does not open to the same secret`);
    await endpoint.update({ signingSecret: null, signingSecretSealed: sealed }, { transaction });
    return 'changed';
  });
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const key = cipher.parseKey(env.webhooks.secretsKey, 'WEBHOOK_SECRETS_KEY');
  if (!key) throw new Error('WEBHOOK_SECRETS_KEY is not set (or is not 32 bytes of base64): nothing can be sealed or opened');
  const previous = secretStore.previousKey();
  if (args.mode === 'reseal' && !previous) throw new Error('--reseal needs WEBHOOK_SECRETS_KEY_PREVIOUS: the key the secrets are sealed with now');
  const databaseName = await currentDatabase();
  assertTarget(args, databaseName);

  console.log(`Database: ${databaseName}. Key fingerprint: ${secretStore.fingerprint(key)}${previous ? `, previous key: ${secretStore.fingerprint(previous)}` : ''}.`);
  const sealed = await candidates({ mode: 'unseal', workspace: args.workspace });
  const seen = census(sealed);
  console.log(`Sealed secrets: ${sealed.length} — ${seen.current} open with the key, ${seen.previous} with the previous key, ${seen.neither} with neither.`);
  if (seen.neither > 0) console.log('Secrets that open with neither key: this is not the key the API runs with, or one is missing.');

  const rows = args.mode === 'unseal' ? sealed : await candidates(args);
  console.log(`${rows.length} endpoint(s) to ${args.mode}${args.workspace ? ` in workspace ${args.workspace}` : ''}.`);
  if (!args.apply) {
    console.log('Dry run: nothing written. Add --apply --confirm-db <database> to write.');
    return;
  }

  const tally = { changed: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    try {
      tally[await convert(row.id, { mode: args.mode, key })] += 1;
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

module.exports = { convert, candidates, census, readArgs, assertTarget, MODES };
