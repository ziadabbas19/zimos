'use strict';

// scripts/launch-reset.js: empties the database before launch but for the
// creator's account and the platform's own setup (scripts/launch-reset-tables.js).
// Every run here is against the test database.

const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const sharp = require('sharp');
const {
  app,
  request,
  registerAndActivate,
  setPlatformRole,
  createWorkspace,
  createProductWithVariant,
  addMemberWithRole,
  confirmCodOrder,
} = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const charges = require('../../src/modules/billing/subscriptionChargeService');
const { ALL_PLATFORM_PERMISSIONS, hasPlatformPermission } = require('../../src/core/security/platformPermissions');
const reset = require('../../scripts/launch-reset');
const { TABLES } = require('../../scripts/launch-reset-tables');

const ROOT = path.join(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/launch-reset.js');
const quiet = () => {};
const CREATOR_PASSWORD = 'Creator-Passw0rd!';

const KEPT = Object.keys(TABLES).filter((name) => TABLES[name].action === 'keep');
const EMPTIED = Object.keys(TABLES).filter((name) => ['wipe', 'truncate'].includes(TABLES[name].action));

let client;
let database;

beforeEach(async () => {
  client = new Client({ host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password, database: env.db.name });
  await client.connect();
  database = (await client.query('SELECT current_database() AS d')).rows[0].d;
  if (!/test/.test(database)) throw new Error(`launchReset.test runs against a test database only, not ${database}`);
  env.wallet.enabled = true;
});

afterEach(async () => {
  env.wallet.enabled = false;
  await client.end();
});

const apply = (opts = {}) =>
  reset.run(client, { apply: true, confirmDb: database, iKnowThisIsProduction: true, expectKeep: 1, log: quiet, ...opts });

async function tableNames() {
  const { rows } = await client.query(
    `SELECT table_schema, table_name FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY 1, 2`
  );
  return rows.map((r) => (r.table_schema === 'public' ? r.table_name : `${r.table_schema}.${r.table_name}`));
}

/** Every table's row count and checksum, to show nothing changed. */
async function snapshot() {
  const out = {};
  for (const name of await tableNames()) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n, coalesce(md5(string_agg(md5(t::text), '' ORDER BY md5(t::text))), '') AS sum FROM "${name}" t`
    );
    out[name] = rows[0];
  }
  return out;
}

async function rowsOf(table, where = 'TRUE', params = []) {
  const { rows } = await client.query(`SELECT row_to_json(t)::text AS j FROM "${table}" t WHERE ${where} ORDER BY 1`, params);
  return rows.map((r) => JSON.parse(r.j));
}

// Console routes behind requirePlatformPermission. The last three need keys
// only the creator holds (admins.manage, payment_methods.manage,
// payment_methods.edit_numbers): with an empty body the creator gets past the
// guard to validation and nothing changes, while an admin is stopped at it.
const CONSOLE_ROUTES = [
  ['get', '/api/v1/admin/plans'],
  ['get', '/api/v1/admin/metrics/overview'],
  ['get', '/api/v1/admin/admins'],
  ['get', '/api/v1/admin/roles'],
  ['get', '/api/v1/admin/payment-methods'],
  ['post', '/api/v1/admin/admins'],
  ['patch', '/api/v1/admin/payment-methods/instapay'],
  ['patch', '/api/v1/admin/payment-methods/instapay/account'],
];
const CREATOR_ONLY = CONSOLE_ROUTES.slice(5).map(([method, url]) => `${method} ${url}`);

async function consoleStatuses(accessToken) {
  const out = {};
  for (const [method, url] of CONSOLE_ROUTES) {
    const req = request(app)[method](url).set({ Authorization: `Bearer ${accessToken}` });
    out[`${method} ${url}`] = (await (method === 'get' ? req : req.send({}))).status;
  }
  return out;
}

async function sequences() {
  return (await client.query('SELECT schemaname, sequencename, last_value FROM pg_sequences ORDER BY 1, 2')).rows;
}

const tree = (text) => ({
  version: 1,
  sections: [
    {
      id: 's1',
      type: 'section',
      rows: [{ id: 'r1', type: 'row', columns: [{ id: 'c1', type: 'column', span: 12, elements: [{ id: 'e1', type: 'text', props: { text } }] }] }],
    },
  ],
});

let shade = 0;
async function screenshot() {
  shade += 1;
  return sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 60, g: shade % 256, b: 120 } } })
    .png()
    .toBuffer();
}

async function placeOrder(token, workspaceId, variantId, buyer) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set({ Authorization: `Bearer ${token}` })
    .set('Idempotency-Key', `o-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: 2 }],
      contact: { fullName: buyer.name, phone: buyer.phone },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '12 Talaat Harb St' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`order: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

/**
 * A database as it might look before launch: the creator with a store of
 * their own, an admin, an agent, two merchants with stores, a team member,
 * orders, customers, invoices, subscriptions, a wallet with its ledger,
 * transfer proofs, sessions, codes, notices, and the platform's plans,
 * templates, payment methods and flags.
 */
async function seedWorld() {
  const [basic] = await db.Plan.bulkCreate([
    { key: 'eg-basic', name: 'Basic', monthlyPriceAmount: 29900, yearlyPriceAmount: 299000, currency: 'EGP', trialDays: 14 },
    { key: 'eg-pro', name: 'Pro', monthlyPriceAmount: 59900, yearlyPriceAmount: 599000, currency: 'EGP', trialDays: 14, displayOrder: 2 },
  ]);
  const template = await db.Template.create({ name: 'Cairo Bakery', category: 'food', isPublished: true, tags: ['food', 'ar'], rtl: true });
  await db.TemplateVersion.create({ templateId: template.id, version: 1, isActive: true, globalStyles: { color: '#a0522d' }, pages: [{ slug: 'home' }], sections: [] });
  await db.PaymentMethod.bulkCreate([
    { kind: 'manual', code: 'instapay', labelAr: 'إنستا باي', labelEn: 'InstaPay', sortOrder: 10, enabled: true, accountNumber: 'zimos@instapay' },
    { kind: 'manual', code: 'wallet', labelAr: 'محفظة إلكترونية', labelEn: 'Mobile wallet', sortOrder: 20, enabled: true, accountNumber: '01000000001' },
  ]);
  await db.FeatureFlag.create({ key: 'launch_banner', description: 'Launch banner', enabled: true, rollout: 100, targetWorkspaceIds: [] });

  const creator = await registerAndActivate({ fullName: 'Ziad Creator', password: CREATOR_PASSWORD });
  await setPlatformRole(creator.userId, 'creator');
  const creatorH = { Authorization: `Bearer ${creator.accessToken}` };
  const admin = await registerAndActivate({ fullName: 'Mona Admin' });
  await setPlatformRole(admin.userId, 'admin');
  const agent = await registerAndActivate({ fullName: 'Karim Agent' });
  await setPlatformRole(agent.userId, 'agent');
  const merchantA = await registerAndActivate({ fullName: 'Hany Samir' });
  const merchantB = await registerAndActivate({ fullName: 'Salma Fathy' });

  const stores = [];
  const buyers = [
    { name: 'Omar Khaled', phone: '01011112222' },
    { name: 'Nada Ali', phone: '01022223333' },
  ];
  for (const [owner, names] of [
    [creator, ['Creator Test Store']],
    [merchantA, ['Nile Shoes', 'Nile Bags']],
    [merchantB, ['Delta Spices']],
  ]) {
    for (const name of names) {
      const ws = await createWorkspace(owner.accessToken, name);
      const { variant } = await createProductWithVariant(owner.accessToken, ws.id, { stock: 20 });
      for (const buyer of buyers) {
        const order = await placeOrder(owner.accessToken, ws.id, variant.id, buyer);
        await confirmCodOrder(owner.accessToken, ws.id, order.id);
      }
      stores.push({ ...ws, owner });
    }
  }
  await addMemberWithRole(merchantA.accessToken, stores[1].id, 'order_operator', 'Nour Member');

  // A published website and funnel (each points at its published revision,
  // which points back at it), a collection, a discount and a shipping zone.
  const nile = stores[1];
  const nileH = { Authorization: `Bearer ${nile.owner.accessToken}` };
  const nileApi = (method, p) => request(app)[method](`/api/v1/workspaces/${nile.id}${p}`).set(nileH);
  const expectStatus = (res, status, what) => {
    if (res.status !== status) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const { website } = expectStatus(await nileApi('post', '/websites').send({ name: 'Nile Shoes' }), 201, 'website');
  expectStatus(await nileApi('post', `/websites/${website.id}/pages`).send({ path: '/', title: 'Home', draftData: tree('Shoes') }), 201, 'page');
  expectStatus(await nileApi('post', `/websites/${website.id}/publish`).send({}), 201, 'publish website');
  const { funnel } = expectStatus(await nileApi('post', '/funnels').send({ name: 'Eid Sale' }), 201, 'funnel');
  await nileApi('post', `/funnels/${funnel.id}/steps`).send({ key: 'landing', stepType: 'landing', name: 'Landing', builderData: tree('Sale') });
  await nileApi('post', `/funnels/${funnel.id}/steps`).send({ key: 'thanks', stepType: 'thank_you', name: 'Thanks', builderData: tree('Thanks') });
  await nileApi('post', `/funnels/${funnel.id}/edges`).send({ fromStepKey: 'landing', toStepKey: 'thanks', condition: { type: 'always' } });
  expectStatus(await nileApi('post', `/funnels/${funnel.id}/publish`).send({}), 201, 'publish funnel');
  expectStatus(await nileApi('post', '/catalog/collections').send({ name: 'Summer' }), 201, 'collection');
  expectStatus(await nileApi('post', '/discounts').send({ code: 'EID10', type: 'percentage', value: 1000 }), 201, 'discount');
  expectStatus(await nileApi('post', '/shipping/zones').send({ name: 'Egypt', countries: ['EG'] }), 201, 'zone');

  // A subscription charge with its transfer proof, and a wallet top-up the
  // creator approved (ledger entry + balance).
  await db.Subscription.update({ planId: basic.id }, { where: { workspaceId: nile.id } });
  const { invoice } = await charges.createCharge(nile.id);
  const proof = await request(app)
    .post(`/api/v1/workspaces/${nile.id}/billing/invoices/${invoice.id}/payment-proofs`)
    .set(nileH)
    .field('methodCode', 'instapay')
    .field('senderPhone', '01012345678')
    .attach('file', await screenshot(), { filename: 'shot.png', contentType: 'image/png' });
  if (proof.status !== 201) throw new Error(`proof: ${proof.status} ${JSON.stringify(proof.body)}`);
  const topup = await request(app)
    .post(`/api/v1/workspaces/${stores[3].id}/billing/wallet/topups`)
    .set({ Authorization: `Bearer ${merchantB.accessToken}` })
    .field('requestedAmount', '50000')
    .field('methodCode', 'wallet')
    .field('senderPhone', '01112345678')
    .attach('file', await screenshot(), { filename: 'transfer.png', contentType: 'image/png' });
  if (topup.status !== 201) throw new Error(`topup: ${topup.status} ${JSON.stringify(topup.body)}`);
  const approved = await request(app)
    .post(`/api/v1/admin/payment-proofs/${topup.body.proof.id}/approve`)
    .set(creatorH)
    .send({ receivedAmount: 50000 });
  if (approved.status !== 200) throw new Error(`approve: ${approved.status} ${JSON.stringify(approved.body)}`);

  // Codes and notices the flows above do not leave behind.
  const later = new Date(Date.now() + 10 * 60 * 1000);
  await db.OtpCode.create({ phone: '+201011112222', purpose: 'phone_verification', codeHash: 'a'.repeat(64), expiresAt: later });
  await db.VerificationToken.create({ userId: merchantA.userId, type: 'password_reset', tokenHash: 'b'.repeat(64), expiresAt: later });
  await db.VerificationToken.create({ userId: creator.userId, type: 'password_reset', tokenHash: 'c'.repeat(64), expiresAt: later });
  await db.NotificationLog.create({ channel: 'email', provider: 'console', recipient: merchantA.email, template: 'order_placed', status: 'sent', workspaceId: nile.id });

  // The tables still waiting for a decision.
  await db.Announcement.create({ title: 'Welcome', body: 'Hello merchants', audience: 'all', startsAt: new Date(), createdByUserId: admin.userId });
  await db.PlatformBlocklistEntry.create({ type: 'phone', value: '+201099999999', label: '01099999999', reason: 'fraud', createdByUserId: admin.userId });
  await db.ReferralCode.create({ agentId: agent.userId, code: 'KARIM10', discountType: 'none', createdByUserId: creator.userId });

  return { creator, admin, agent, merchantA, merchantB, stores };
}

describe('the classification', () => {
  it('lists every table in the database, and only those', async () => {
    const inDatabase = await tableNames();
    const classified = Object.keys(TABLES).sort();
    expect(inDatabase.filter((t) => !classified.includes(t))).toEqual([]);
    expect(classified.filter((t) => !inDatabase.includes(t))).toEqual([]);
    for (const [name, entry] of Object.entries(TABLES)) {
      expect([name, ['keep', 'keep-creator', 'wipe', 'truncate', 'decide'].includes(entry.action)]).toEqual([name, true]);
      expect(entry.why).toBeTruthy();
    }
  });

  it('catches a new table nobody classified', async () => {
    await client.query('BEGIN');
    try {
      await client.query('CREATE TABLE launch_reset_probe (id int PRIMARY KEY)');
      const inDatabase = await tableNames();
      expect(inDatabase.filter((t) => !Object.keys(TABLES).includes(t))).toEqual(['launch_reset_probe']);
      expect(reset.classify(await reset.listTables(client), TABLES).unclassified).toEqual(['launch_reset_probe']);
    } finally {
      await client.query('ROLLBACK');
    }
    const { byAction, unclassified } = reset.classify(await reset.listTables(client), TABLES);
    expect(unclassified).toEqual([]);
    expect(byAction['keep-creator']).toEqual(['users']);
  });

  it('refuses to run, a dry run included, while a table is unclassified', async () => {
    await seedWorld();
    const { support_tickets: _dropped, ...partial } = TABLES;
    await expect(reset.run(client, { tables: partial, log: quiet })).rejects.toThrow('not classified in scripts/launch-reset-tables.js: support_tickets');
  });

  it('keeps users only as keep-creator', async () => {
    await expect(
      reset.run(client, { tables: { ...TABLES, users: { action: 'wipe', why: 'x' } }, log: quiet })
    ).rejects.toThrow('users must be classified keep-creator');
  });

  it('holds the decisions taken: what is kept, what is truncated, and the four tables decided as wipe', () => {
    expect(KEPT.sort()).toEqual(['SequelizeMeta', 'feature_flags', 'geo_regions', 'payment_methods', 'plans', 'platform_roles', 'platform_settings', 'template_versions', 'templates', 'themes']);
    expect(Object.keys(TABLES).filter((n) => TABLES[n].action === 'keep-creator')).toEqual(['users']);
    expect(Object.keys(TABLES).filter((n) => TABLES[n].action === 'truncate').sort()).toEqual(['wallet_ledger_entries', 'workspace_wallets']);
    for (const name of ['announcements', 'platform_blocklist_entries', 'plan_trials', 'referral_codes']) {
      expect([name, TABLES[name].action]).toEqual([name, 'wipe']);
    }
    expect(Object.keys(TABLES).filter((n) => TABLES[n].action === 'decide')).toEqual([]);
  });

  it('no kept table has a foreign key to users or to a table that is emptied', async () => {
    const fks = await reset.loadForeignKeys(client);
    const kept = (t) => ['keep', 'keep-creator'].includes(TABLES[t].action);
    const fromKept = fks.filter((fk) => kept(fk.child)).map((fk) => `${fk.child}.${fk.child_cols} -> ${fk.parent}`).sort();
    // A new key here needs a look before the reset runs again.
    expect(fromKept).toEqual([
      'geo_regions.parent_code -> geo_regions',
      'template_versions.template_id -> templates',
      'users.platform_role -> platform_roles',
      'users.selected_plan_id -> plans',
    ]);
    expect(fks.filter((fk) => kept(fk.child) && (fk.parent === 'users' || !kept(fk.parent)))).toEqual([]);
  });
});

describe('the dry run', () => {
  it('counts every table and changes nothing', async () => {
    const world = await seedWorld();
    const before = await snapshot();
    const lines = [];
    const result = await reset.run(client, { log: (l) => lines.push(l) });
    expect(await snapshot()).toEqual(before);

    expect(result.applied).toBe(false);
    expect(result.creator.id).toBe(world.creator.userId);
    const users = result.tables.find((t) => t.name === 'users');
    expect(users).toMatchObject({ action: 'keep-creator', rows: before.users.n, toDelete: before.users.n - 1 });
    for (const t of result.tables) {
      expect(t.rows).toBe(before[t.name].n);
      if (t.action === 'wipe' || t.action === 'truncate') expect(t.toDelete).toBe(t.rows);
      if (t.action === 'keep' || t.action === 'decide') expect(t.toDelete).toBe(0);
    }
    expect(result.decide).toEqual([]);
    expect(result.pointing).toEqual([]);
    for (const name of ['announcements', 'platform_blocklist_entries', 'plan_trials', 'referral_codes']) {
      expect(result.tables.find((t) => t.name === name)).toMatchObject({ action: 'wipe', rows: before[name].n, toDelete: before[name].n });
    }
    expect(lines.some((l) => l.startsWith('wallet_ledger_entries') && /truncate\s+1\s+1$/.test(l))).toBe(true);
    // The creator's address is masked in what it prints.
    expect(lines.join('\n')).not.toContain(world.creator.email);
  });

  it('runs in a READ ONLY transaction: a write slipped into it is refused', async () => {
    await seedWorld();
    const before = await snapshot();
    const probes = [];
    // Queued from inside the report, so they run inside the dry run's
    // transaction, before its ROLLBACK.
    const log = () => {
      if (probes.length) return;
      probes.push(client.query('SHOW transaction_read_only').then((r) => r.rows[0].transaction_read_only));
      probes.push(client.query('SHOW transaction_isolation').then((r) => r.rows[0].transaction_isolation));
      probes.push(client.query("UPDATE plans SET name = name || ' (dry run)'").then(() => 'written', (err) => err.code));
    };
    const result = await reset.run(client, { log });
    expect(result.applied).toBe(false);
    // 25006 = read_only_sql_transaction
    expect(await Promise.all(probes)).toEqual(['on', 'repeatable read', '25006']);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses when no account, or more than one, is the creator, a dry run included', async () => {
    const world = await seedWorld();
    await setPlatformRole(world.admin.userId, 'creator');
    const twoCreators = await snapshot();
    await expect(reset.run(client, { log: quiet })).rejects.toThrow("expected exactly one account with platform_role 'creator', found 2");
    await expect(apply()).rejects.toThrow('found 2');
    expect(await snapshot()).toEqual(twoCreators);
    await db.User.update({ platformRole: null, platformPermissions: [] }, { where: { platformRole: 'creator' } });
    const noCreator = await snapshot();
    await expect(reset.run(client, { log: quiet })).rejects.toThrow('found 0');
    await expect(apply()).rejects.toThrow('found 0');
    expect(await snapshot()).toEqual(noCreator);
  });

  it('checks --expect-keep and --confirm-db when given', async () => {
    await seedWorld();
    await expect(reset.run(client, { expectKeep: 2, log: quiet })).rejects.toThrow('--expect-keep 2, but 1 creator account would be kept');
    await expect(reset.run(client, { confirmDb: 'railway', log: quiet })).rejects.toThrow(`is not the database this connects to ("${database}")`);
  });
});

describe('--apply', () => {
  it('needs --confirm-db, --i-know-this-is-production and --expect-keep together', () => {
    expect(reset.parseArgs([])).toMatchObject({ apply: false });
    expect(() => reset.parseArgs(['--apply'])).toThrow('--apply also needs --confirm-db <database>, --i-know-this-is-production, --expect-keep 1');
    expect(() => reset.parseArgs(['--apply', '--confirm-db', 'railway', '--expect-keep', '1'])).toThrow('--i-know-this-is-production');
    expect(() => reset.parseArgs(['--apply', '--confirm-db', 'railway', '--i-know-this-is-production'])).toThrow('--expect-keep 1');
    expect(() => reset.parseArgs(['--apply', '--i-know-this-is-production', '--expect-keep', '1'])).toThrow('--confirm-db');
    expect(() => reset.parseArgs(['--expect-keep', 'one'])).toThrow('whole number');
    expect(() => reset.parseArgs(['--force'])).toThrow('unknown argument --force');
    expect(reset.parseArgs(['--apply', '--confirm-db=railway', '--i-know-this-is-production', '--expect-keep', '1'])).toEqual({
      apply: true,
      confirmDb: 'railway',
      iKnowThisIsProduction: true,
      expectKeep: 1,
    });
  });

  it('refuses a --confirm-db that is not the database it is connected to, changing nothing', async () => {
    await seedWorld();
    const before = await snapshot();
    await expect(apply({ confirmDb: 'railway' })).rejects.toThrow(reset.Refusal);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses while a table is still marked "decide", changing nothing', async () => {
    await seedWorld();
    const before = await snapshot();
    const undecided = { ...TABLES, announcements: { action: 'decide', why: 'x' } };
    await expect(apply({ tables: undecided })).rejects.toThrow('still marked "decide" in scripts/launch-reset-tables.js: announcements');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses when a kept row points at a row it would delete, changing nothing', async () => {
    await seedWorld();
    const before = await snapshot();
    const blocklistKept = { ...TABLES, platform_blocklist_entries: { action: 'keep', why: 'x' } };
    const lines = [];
    await expect(apply({ tables: blocklistKept, log: (l) => lines.push(l) })).rejects.toThrow('kept rows point at rows this reset deletes');
    expect(lines.join('\n')).toContain('platform_blocklist_entries.created_by_user_id -> users (ON DELETE SET NULL): 1 rows');
    expect(await snapshot()).toEqual(before);
  });

  it('keeps the creator and the platform setup exactly, empties everything else, and a second run changes nothing', async () => {
    const world = await seedWorld();
    const creatorId = world.creator.userId;

    // What the console lets the creator do before the reset; an admin is
    // stopped at the creator-only keys.
    const consoleBefore = await consoleStatuses(world.creator.accessToken);
    const meBefore = (await request(app).get('/api/v1/auth/me').set({ Authorization: `Bearer ${world.creator.accessToken}` })).body.user;
    for (const [route, status] of Object.entries(consoleBefore)) {
      // 422: past the guard, stopped by validation of the empty body.
      expect([route, status]).toEqual([route, CREATOR_ONLY.includes(route) ? 422 : 200]);
    }
    const adminStatuses = await consoleStatuses(world.admin.accessToken);
    for (const route of CREATOR_ONLY) expect([route, adminStatuses[route]]).toEqual([route, 403]);

    const keptBefore = {};
    for (const name of KEPT) keptBefore[name] = await rowsOf(name);
    const creatorBefore = await rowsOf('users', 'id = $1', [creatorId]);
    const sequencesBefore = await sequences();
    const before = await snapshot();
    const wipedWithRows = EMPTIED.filter((n) => before[n].n > 0);
    // The seeded world reaches the tables the task names, and many more.
    expect(wipedWithRows).toEqual(
      expect.arrayContaining([
        'workspaces', 'orders', 'customers', 'invoices', 'billing_invoices', 'subscriptions', 'wallet_ledger_entries',
        'workspace_wallets', 'payment_proofs', 'sessions', 'verification_codes', 'verification_tokens', 'otp_codes',
        'notification_logs', 'audit_logs', 'memberships', 'roles', 'products', 'plan_trials',
        'websites', 'website_pages', 'website_revisions', 'funnels', 'funnel_steps', 'funnel_edges', 'funnel_revisions',
        'collections', 'discounts', 'shipping_zones', 'referral_codes', 'announcements', 'platform_blocklist_entries',
      ])
    );
    for (const table of ['websites', 'funnels']) {
      const { n } = (await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE published_revision_id IS NOT NULL`)).rows[0];
      expect([table, n]).toEqual([table, 1]);
    }
    expect(before.users.n).toBeGreaterThan(5);
    expect(keptBefore.plans).toHaveLength(2);
    expect(keptBefore.payment_methods.map((m) => m.account_number).sort()).toEqual(['01000000001', 'zimos@instapay']);

    const result = await apply();
    expect(result.applied).toBe(true);
    expect(result.deleted.users).toBe(before.users.n - 1);
    expect(result.deleted.wallet_ledger_entries).toBe(before.wallet_ledger_entries.n);

    for (const name of KEPT) expect([name, await rowsOf(name)]).toEqual([name, keptBefore[name]]);
    expect(await rowsOf('users')).toEqual(creatorBefore);
    for (const name of EMPTIED) {
      expect([name, (await client.query(`SELECT count(*)::int AS n FROM "${name}"`)).rows[0].n]).toEqual([name, 0]);
    }
    expect(await sequences()).toEqual(sequencesBefore);

    // Again: nothing to delete, nothing changes.
    const afterFirst = await snapshot();
    const again = await apply();
    expect(again.applied).toBe(true);
    expect(Object.values(again.deleted).every((n) => n === 0)).toBe(true);
    expect(again.totals.toDelete).toBe(0);
    expect(await snapshot()).toEqual(afterFirst);

    // The creator signs in with the same password, and its hash still matches it.
    const [{ password_hash: hash }] = (await client.query('SELECT password_hash FROM users WHERE id = $1', [creatorId])).rows;
    expect(await bcrypt.compare(CREATOR_PASSWORD, hash)).toBe(true);
    const login = await request(app).post('/api/v1/auth/login').send({ email: world.creator.email, password: CREATOR_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(creatorId);
    // Old sessions are gone: the refresh token from before the reset no longer works.
    const oldRefresh = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: world.creator.refreshToken });
    expect(oldRefresh.status).toBe(401);

    // The same role and permission set, and platformAdminGuard lets the new
    // session through exactly as before, the creator-only keys included.
    const meAfter = (await request(app).get('/api/v1/auth/me').set({ Authorization: `Bearer ${login.body.accessToken}` })).body.user;
    expect(meAfter.platformRole).toBe('creator');
    expect(meAfter.platformPermissions).toEqual(meBefore.platformPermissions);
    for (const permission of ALL_PLATFORM_PERMISSIONS) {
      expect([permission, hasPlatformPermission(meAfter, permission)]).toEqual([permission, true]);
    }
    expect(await consoleStatuses(login.body.accessToken)).toEqual(consoleBefore);
  });

  it('rolls everything back when a statement fails half-way', async () => {
    await seedWorld();
    await (await db.Order.findOne()).update({ notes: 'launch-reset-inject-failure' });
    await client.query(`
      CREATE OR REPLACE FUNCTION launch_reset_inject_failure() RETURNS trigger AS $$
      BEGIN
        IF OLD.notes = 'launch-reset-inject-failure' THEN RAISE EXCEPTION 'injected failure'; END IF;
        RETURN OLD;
      END $$ LANGUAGE plpgsql`);
    await client.query('DROP TRIGGER IF EXISTS launch_reset_inject_failure ON orders');
    await client.query('CREATE TRIGGER launch_reset_inject_failure BEFORE DELETE ON orders FOR EACH ROW EXECUTE FUNCTION launch_reset_inject_failure()');
    try {
      const before = await snapshot();
      expect(before.wallet_ledger_entries.n).toBe(1);
      await expect(apply()).rejects.toThrow('injected failure');
      // The ledger TRUNCATE and every DELETE before orders are undone too.
      expect(await snapshot()).toEqual(before);
    } finally {
      await client.query('DROP TRIGGER IF EXISTS launch_reset_inject_failure ON orders');
      await client.query('DROP FUNCTION IF EXISTS launch_reset_inject_failure()');
    }
  });

  it('rolls back when a kept row changed on the way', async () => {
    await seedWorld();
    await (await db.Order.findOne()).update({ notes: 'launch-reset-touch-plan' });
    await client.query(`
      CREATE OR REPLACE FUNCTION launch_reset_touch_plan() RETURNS trigger AS $$
      BEGIN
        IF OLD.notes = 'launch-reset-touch-plan' THEN UPDATE plans SET name = name || ' (changed)' WHERE key = 'eg-pro'; END IF;
        RETURN OLD;
      END $$ LANGUAGE plpgsql`);
    await client.query('DROP TRIGGER IF EXISTS launch_reset_touch_plan ON orders');
    await client.query('CREATE TRIGGER launch_reset_touch_plan AFTER DELETE ON orders FOR EACH ROW EXECUTE FUNCTION launch_reset_touch_plan()');
    try {
      const before = await snapshot();
      await expect(apply()).rejects.toThrow(/checks failed, rolled back:\n {2}plans: kept rows changed \(2 -> 2 rows, checksum differs\)/);
      expect(await snapshot()).toEqual(before);
    } finally {
      await client.query('DROP TRIGGER IF EXISTS launch_reset_touch_plan ON orders');
      await client.query('DROP FUNCTION IF EXISTS launch_reset_touch_plan()');
    }
  });
});

describe('the delete order', () => {
  const fk = (child, parent, onDelete = 'r') => ({ child, parent, on_delete: onDelete });

  it('deletes children before their parents', () => {
    const order = reset.deleteOrder(['users', 'workspaces', 'orders', 'order_items'], [
      fk('workspaces', 'users'),
      fk('orders', 'workspaces', 'c'),
      fk('order_items', 'orders', 'c'),
    ]);
    expect(order).toEqual(['order_items', 'orders', 'workspaces', 'users']);
  });

  it('breaks a cycle only across a CASCADE or SET NULL key', () => {
    expect(reset.deleteOrder(['funnels', 'funnel_revisions'], [fk('funnels', 'funnel_revisions', 'n'), fk('funnel_revisions', 'funnels', 'c')])).toEqual([
      'funnel_revisions',
      'funnels',
    ]);
    expect(() => reset.deleteOrder(['a', 'b'], [fk('a', 'b', 'r'), fk('b', 'a', 'a')])).toThrow('RESTRICT / NO ACTION keys form a cycle among a, b');
  });
});

describe('the command line', () => {
  const url = () =>
    `postgres://${encodeURIComponent(env.db.user)}:${encodeURIComponent(env.db.password || '')}@${env.db.host}:${env.db.port}/${database}`;
  const cli = (args, extraEnv = {}) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, DATABASE_URL: url(), ...extraEnv }, encoding: 'utf8' });

  it('loads neither the app config nor .env: DATABASE_URL is all it needs', () => {
    const probe = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(SCRIPT)}); console.log(JSON.stringify(Object.keys(require.cache)))`], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });
    expect(probe.status).toBe(0);
    const loaded = JSON.parse(probe.stdout);
    const own = loaded
      .filter((p) => !p.split(path.sep).includes('node_modules'))
      .map((p) => path.relative(ROOT, p).split(path.sep).join('/'))
      .sort();
    expect(own).toEqual(['scripts/launch-reset-tables.js', 'scripts/launch-reset.js', 'src/config/parseDbUrl.js']);
    expect(loaded.filter((p) => /[\\/]node_modules[\\/](dotenv|sequelize)[\\/]/.test(p))).toEqual([]);
  });

  it('runs from DATABASE_URL alone without printing it, refuses what it should, and applies', async () => {
    await seedWorld();
    const before = await snapshot();

    // Only PATH and DATABASE_URL: no NODE_ENV, no app secret.
    const dry = cli([]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('launch-reset: DRY RUN (nothing is changed)');
    expect(dry.stdout).toContain(`database: ${database} (PostgreSQL `);
    expect(dry.stdout).toMatch(/^users\s+keep-creator\s+\d+\s+\d+$/m);
    if (env.db.password) expect(dry.stdout + dry.stderr).not.toContain(env.db.password);

    const wrongDb = cli(['--apply', '--confirm-db', 'railway', '--i-know-this-is-production', '--expect-keep', '1']);
    expect(wrongDb.status).toBe(1);
    expect(wrongDb.stdout).toContain(`Refused: --confirm-db "railway" is not the database this connects to ("${database}")`);

    const noUrl = cli([], { DATABASE_URL: '' });
    expect(noUrl.status).toBe(1);
    expect(noUrl.stdout).toContain('Refused: DATABASE_URL is not set.');

    const noConfirm = cli(['--apply', '--i-know-this-is-production', '--expect-keep', '1']);
    expect(noConfirm.status).toBe(1);
    expect(noConfirm.stdout).toContain('Refused: --apply also needs --confirm-db <database>');
    expect(await snapshot()).toEqual(before);

    const applied = cli(['--apply', '--confirm-db', database, '--i-know-this-is-production', '--expect-keep', '1']);
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain('launch-reset: APPLY');
    expect(applied.stdout).toMatch(/Done: deleted \d+ rows; every kept row is unchanged\./);
    expect((await client.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(1);

    const again = cli(['--apply', '--confirm-db', database, '--i-know-this-is-production', '--expect-keep', '1']);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('Done: nothing to delete, nothing changed.');
    if (env.db.password) expect(applied.stdout + applied.stderr + again.stdout).not.toContain(env.db.password);
  });
});
