'use strict';

// Webhook signing secrets sealed at rest (migration 714,
// webhooks/signingSecretStore.js, WEBHOOK_SECRET_SEALING): off stores them in
// clear as before; on seals new and rotated ones with WEBHOOK_SECRETS_KEY,
// deliveries still verify, and the secret shows up in no answer but the
// creation / rotation one, and in no log line.

const crypto = require('crypto');
const http = require('http');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { verifySignature } = require('../../src/modules/webhooks/webhookSigning');
const secretStore = require('../../src/modules/webhooks/signingSecretStore');
const sealScript = require('../../scripts/seal-webhook-secrets');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const KEY = crypto.randomBytes(32).toString('base64');

function startReceiver() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.end('ok');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}/hooks`, received, close: () => new Promise((done) => server.close(done)) })
    );
  });
}

/** Everything written to stdout / stderr while `fn` runs (the logger writes there). */
async function captureLogs(fn) {
  const lines = [];
  const out = jest.spyOn(process.stdout, 'write').mockImplementation((chunk, ...rest) => {
    lines.push(String(chunk));
    return true;
  });
  const err = jest.spyOn(process.stderr, 'write').mockImplementation((chunk, ...rest) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return lines.join('');
}

let receiver;
const saved = { ...env.webhooks };
beforeEach(async () => {
  receiver = await startReceiver();
});
afterEach(async () => {
  Object.assign(env.webhooks, saved);
  await receiver.close();
});

async function addEndpoint(token, workspaceId) {
  return request(app).post(`/api/v1/workspaces/${workspaceId}/webhooks`).set(bearer(token)).send({ url: receiver.url, events: ['*'] });
}

const rawRow = async (id) =>
  (await db.sequelize.query('SELECT signing_secret, signing_secret_sealed FROM webhook_endpoints WHERE id = :id', { replacements: { id }, type: db.Sequelize.QueryTypes.SELECT }))[0];

describe('webhook signing secrets at rest', () => {
  it('off: stored in clear, exactly as before', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await addEndpoint(auth.accessToken, workspace.id);
    expect(res.status).toBe(201);
    const row = await rawRow(res.body.endpoint.id);
    expect(row.signing_secret).toBe(res.body.signingSecret);
    expect(row.signing_secret_sealed).toBeNull();
  });

  it('on: sealed, signs deliveries that verify, and is in no answer but creation and rotation', async () => {
    Object.assign(env.webhooks, { secretSealing: true, secretsKey: KEY });
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const created = await addEndpoint(auth.accessToken, workspace.id);
    expect(created.status).toBe(201);
    const { endpoint, signingSecret } = created.body;
    expect(signingSecret).toMatch(/^whsec_/);
    expect(endpoint.secretHint).toBe(`whsec_…${signingSecret.slice(-4)}`);

    const row = await rawRow(endpoint.id);
    expect(row.signing_secret).toBeNull();
    expect(row.signing_secret_sealed).toMatch(/^v1:/);
    expect(row.signing_secret_sealed).not.toContain(signingSecret);
    expect(row.signing_secret_sealed).not.toContain(signingSecret.slice(6));

    const base = `/api/v1/workspaces/${workspace.id}/webhooks`;
    const answers = [];
    const logs = await captureLogs(async () => {
      answers.push(await request(app).get(base).set(bearer(auth.accessToken)));
      answers.push(await request(app).patch(`${base}/${endpoint.id}`).set(bearer(auth.accessToken)).send({ events: ['order.created'] }));
      answers.push(await request(app).post(`${base}/${endpoint.id}/test`).set(bearer(auth.accessToken)));
      answers.push(await request(app).get(`${base}/${endpoint.id}/deliveries`).set(bearer(auth.accessToken)));
      answers.push(await request(app).get(`${base}/deliveries`).set(bearer(auth.accessToken)));
    });
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      const text = JSON.stringify(answer.body);
      expect(text).not.toContain(signingSecret);
      expect(text).not.toContain(row.signing_secret_sealed);
    }
    expect(logs).not.toContain(signingSecret);
    expect(logs).not.toContain(row.signing_secret_sealed);

    // The test event was signed with the secret the merchant was shown.
    expect(receiver.received).toHaveLength(1);
    const [hit] = receiver.received;
    expect(verifySignature(signingSecret, hit.headers['x-zimos-signature'], hit.body)).toBe(true);
    expect(JSON.stringify(hit.headers)).not.toContain(signingSecret);

    // Rotation: a new sealed secret; the old one no longer verifies.
    const rotated = await request(app).post(`${base}/${endpoint.id}/rotate-secret`).set(bearer(auth.accessToken));
    expect(rotated.status).toBe(200);
    const fresh = rotated.body.signingSecret;
    expect(fresh).not.toBe(signingSecret);
    const after = await rawRow(endpoint.id);
    expect(after.signing_secret).toBeNull();
    expect(after.signing_secret_sealed).not.toBe(row.signing_secret_sealed);
    await request(app).post(`${base}/${endpoint.id}/test`).set(bearer(auth.accessToken));
    const second = receiver.received[1];
    expect(verifySignature(fresh, second.headers['x-zimos-signature'], second.body)).toBe(true);
    expect(verifySignature(signingSecret, second.headers['x-zimos-signature'], second.body)).toBe(false);

    // The audit trail names the actions, never the secret.
    const audits = await db.AuditLog.findAll({ where: { workspaceId: workspace.id } });
    const auditText = JSON.stringify(audits.map((a) => a.toJSON()));
    expect(auditText).not.toContain(signingSecret);
    expect(auditText).not.toContain(fresh);
  });

  it('on without a usable key: creating answers 503 and stores nothing', async () => {
    Object.assign(env.webhooks, { secretSealing: true, secretsKey: '' });
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await addEndpoint(auth.accessToken, workspace.id);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('WEBHOOK_SECRETS_NOT_CONFIGURED');
    expect(await db.WebhookEndpoint.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  it('a sealed secret keeps signing after the flag is turned off; with the key gone nothing is sent unsigned', async () => {
    Object.assign(env.webhooks, { secretSealing: true, secretsKey: KEY });
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const { endpoint, signingSecret } = (await addEndpoint(auth.accessToken, workspace.id)).body;
    const base = `/api/v1/workspaces/${workspace.id}/webhooks/${endpoint.id}`;

    env.webhooks.secretSealing = false;
    const ok = await request(app).post(`${base}/test`).set(bearer(auth.accessToken));
    expect(ok.body.delivery.status).toBe('delivered');
    expect(verifySignature(signingSecret, receiver.received[0].headers['x-zimos-signature'], receiver.received[0].body)).toBe(true);

    env.webhooks.secretsKey = '';
    let res;
    const logs = await captureLogs(async () => {
      res = await request(app).post(`${base}/test`).set(bearer(auth.accessToken));
    });
    expect(res.status).toBe(200);
    expect(res.body.delivery).toMatchObject({ status: 'failed', attemptCount: 0, lastResponseStatus: null });
    expect(res.body.delivery.lastError).toMatch(/signing secret/i);
    expect(receiver.received).toHaveLength(1);
    expect(logs).toContain('Webhook signing secret unreadable');
    expect(logs).not.toContain(signingSecret);
    // The endpoint is not marked failing for our own missing key.
    const stored = await db.WebhookEndpoint.findByPk(endpoint.id);
    expect(stored.failingSince).toBeNull();
    // After three days of that, the row ends instead of coming back for ever.
    const row = await db.WebhookDelivery.findByPk(res.body.delivery.id);
    await row.update({ status: 'failed', createdAt: new Date(Date.now() - 4 * 24 * 3600 * 1000) }, { silent: true });
    await db.sequelize.query('UPDATE webhook_deliveries SET created_at = :at WHERE id = :id', { replacements: { at: new Date(Date.now() - 4 * 24 * 3600 * 1000), id: row.id } });
    const ended = await require('../../src/modules/webhooks/webhookDispatcher').attemptDelivery(row.id);
    expect(ended).toMatchObject({ status: 'exhausted', nextAttemptAt: null, attemptCount: 0 });
    expect(ended.lastError).toMatch(/3 days/);
    expect(receiver.received).toHaveLength(1);
    // Listing still works; the hint is simply unknown while the key is gone.
    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/webhooks`).set(bearer(auth.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.endpoints[0].secretHint).toBeNull();
  });

  it('a sealed value moved onto another endpoint does not open', async () => {
    Object.assign(env.webhooks, { secretSealing: true, secretsKey: KEY });
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const a = (await addEndpoint(auth.accessToken, workspace.id)).body.endpoint;
    const b = (await addEndpoint(auth.accessToken, workspace.id)).body.endpoint;
    const rowA = await rawRow(a.id);
    const endpointB = await db.WebhookEndpoint.findByPk(b.id);
    expect(() => secretStore.readSecret({ ...endpointB.get({ plain: true }), signingSecretSealed: rowA.signing_secret_sealed })).toThrow();
  });
});

describe('scripts/seal-webhook-secrets.js', () => {
  const cipher = require('../../src/core/utils/credentialsCipher');

  it('seals the secrets kept in clear, unseals them back, and changes nothing twice', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const { endpoint, signingSecret } = (await addEndpoint(auth.accessToken, workspace.id)).body;
    Object.assign(env.webhooks, { secretsKey: KEY });
    const key = cipher.parseKey(KEY);

    const todo = await sealScript.candidates({ mode: 'seal', workspace: workspace.id });
    expect(todo.map((r) => r.id)).toEqual([endpoint.id]);
    expect(await sealScript.convert(endpoint.id, { mode: 'seal', key })).toBe('changed');
    expect(await sealScript.convert(endpoint.id, { mode: 'seal', key })).toBe('skipped');
    let row = await rawRow(endpoint.id);
    expect(row.signing_secret).toBeNull();
    expect(secretStore.readSecret(await db.WebhookEndpoint.findByPk(endpoint.id))).toBe(signingSecret);

    // Delivered and verified while sealed, with the flag off.
    const test = await request(app).post(`/api/v1/workspaces/${workspace.id}/webhooks/${endpoint.id}/test`).set(bearer(auth.accessToken));
    expect(test.body.delivery.status).toBe('delivered');
    expect(verifySignature(signingSecret, receiver.received[0].headers['x-zimos-signature'], receiver.received[0].body)).toBe(true);

    expect(await sealScript.convert(endpoint.id, { mode: 'unseal', key })).toBe('changed');
    row = await rawRow(endpoint.id);
    expect(row).toEqual({ signing_secret: signingSecret, signing_secret_sealed: null });
    expect(await sealScript.convert(endpoint.id, { mode: 'unseal', key })).toBe('skipped');
  });

  it('rotates the key: the old one read only meanwhile, --reseal moves every row, the census tells the keys apart', async () => {
    const OLD = KEY;
    const NEW = crypto.randomBytes(32).toString('base64');
    Object.assign(env.webhooks, { secretSealing: true, secretsKey: OLD, secretsKeyPrevious: '' });
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const { endpoint, signingSecret } = (await addEndpoint(auth.accessToken, workspace.id)).body;
    const sealedWithOld = (await rawRow(endpoint.id)).signing_secret_sealed;

    // New key in place, old one as _PREVIOUS: deliveries keep signing.
    Object.assign(env.webhooks, { secretsKey: NEW, secretsKeyPrevious: OLD });
    expect(secretStore.readSecret(await db.WebhookEndpoint.findByPk(endpoint.id))).toBe(signingSecret);
    const rows = await sealScript.candidates({ mode: 'reseal', workspace: workspace.id });
    expect(sealScript.census(rows)).toEqual({ current: 0, previous: 1, neither: 0 });

    expect(await sealScript.convert(endpoint.id, { mode: 'reseal', key: cipher.parseKey(NEW) })).toBe('changed');
    expect(await sealScript.convert(endpoint.id, { mode: 'reseal', key: cipher.parseKey(NEW) })).toBe('skipped');
    const after = await rawRow(endpoint.id);
    expect(after.signing_secret).toBeNull();
    expect(after.signing_secret_sealed).not.toBe(sealedWithOld);

    // _PREVIOUS dropped: everything opens with the new key alone.
    env.webhooks.secretsKeyPrevious = '';
    expect(secretStore.openSealed(await db.WebhookEndpoint.findByPk(endpoint.id))).toEqual({ secret: signingSecret, which: 'current' });
    // A run with some other key sees secrets that open with neither: not the API's key.
    env.webhooks.secretsKey = crypto.randomBytes(32).toString('base64');
    expect(sealScript.census(await sealScript.candidates({ mode: 'reseal', workspace: workspace.id }))).toEqual({ current: 0, previous: 0, neither: 1 });
    expect(secretStore.fingerprint(cipher.parseKey(NEW))).toMatch(/^[0-9a-f]{8}$/);
  });

  it('reads only the arguments it knows, and writes only to the database --confirm-db names', () => {
    expect(sealScript.readArgs(['--apply', '--unseal', '--workspace', 'w1', '--confirm-db', 'zimos'])).toMatchObject({ apply: true, mode: 'unseal', workspace: 'w1', confirmDb: 'zimos' });
    expect(sealScript.readArgs(['--reseal']).mode).toBe('reseal');
    expect(() => sealScript.readArgs(['--everything'])).toThrow('Unknown argument');
    expect(() => sealScript.readArgs(['--confirm-production'])).toThrow('Unknown argument');

    expect(() => sealScript.assertTarget({ apply: false }, 'railway')).not.toThrow();
    expect(() => sealScript.assertTarget({ apply: true, confirmDb: null }, 'railway')).toThrow('--confirm-db railway');
    expect(() => sealScript.assertTarget({ apply: true, confirmDb: 'zimos_test' }, 'railway')).toThrow('nothing written');
    expect(() => sealScript.assertTarget({ apply: true, confirmDb: 'railway' }, 'railway')).not.toThrow();
  });
});
