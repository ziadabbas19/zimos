'use strict';

// The console's person and store details: GET /admin/users/:id (location,
// phone verification, each store's created date and link) and the store
// list's link and owner (GET /admin/workspaces). Creators and admins only,
// no secret ever in a response, and a fixed number of queries however many
// stores there are.

const { app, request, registerAndActivate, createWorkspace, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const getUser = (H, id) => request(app).get(`/api/v1/admin/users/${id}`).set(H);
const listWorkspaces = (H) => request(app).get('/api/v1/admin/workspaces').set(H);

async function primaryDomain(workspaceId, hostname, overrides = {}) {
  const website = await db.Website.create({ workspaceId, name: hostname, subdomain: `site-${workspaceId.slice(0, 8)}` });
  return db.Domain.create({
    workspaceId,
    websiteId: website.id,
    hostname,
    verificationToken: 'test-token',
    status: 'active',
    sslStatus: 'issued',
    isPrimary: true,
    verifiedAt: new Date(),
    ...overrides,
  });
}

async function visit(userId, { country = null, governorate = null, event = 'view', at = new Date() } = {}) {
  await db.sequelize.query(
    `INSERT INTO site_visits (visitor_hash, session_id, event, country, governorate, user_id, created_at)
     VALUES ('h', 's', :event, :country, :governorate, :userId, :at)`,
    { replacements: { event, country, governorate, userId, at } }
  );
}

/** Every key anywhere in a JSON value. */
function keysOf(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysOf(v, out);
    }
  }
  return out;
}
const SECRET = /password|secret|token|hash|otp|recovery/i;

/** How many SQL statements a request runs. */
async function queriesDuring(run) {
  let count = 0;
  const hook = () => {
    count += 1;
  };
  db.sequelize.addHook('beforeQuery', 'countQueries', hook);
  try {
    await run();
  } finally {
    db.sequelize.removeHook('beforeQuery', 'countQueries');
  }
  return count;
}

describe('console user details', () => {
  it('shows the phone with its verification, and each store with its created date and link', async () => {
    const admin = await makePlatformUser('admin');
    const owner = await registerAndActivate({ fullName: 'Mona Owner' });
    const plain = await createWorkspace(owner.accessToken, 'Plain Store');
    const branded = await createWorkspace(owner.accessToken, 'Branded Store');
    await primaryDomain(branded.id, 'shop.mona-example.com');
    await db.User.update({ phone: '+201000000001', phoneVerifiedAt: new Date() }, { where: { id: owner.userId } });

    const res = await getUser(admin.H, owner.userId);
    expect(res.status).toBe(200);
    const { user } = res.body;
    expect(user).toMatchObject({ email: owner.email, phone: '+201000000001', phoneVerified: true, emailVerified: true });
    const byId = Object.fromEntries(user.workspaces.map((w) => [w.id, w]));
    expect(byId[plain.id]).toMatchObject({ name: 'Plain Store', storeUrl: `https://${plain.slug}.${env.platformRootDomain}` });
    expect(byId[branded.id].storeUrl).toBe('https://shop.mona-example.com');
    expect(new Date(byId[plain.id].createdAt).toString()).not.toBe('Invalid Date');
    expect(byId[plain.id].subscription).toMatchObject({ status: expect.any(String) });

    await db.User.update({ phoneVerifiedAt: null }, { where: { id: owner.userId } });
    expect((await getUser(admin.H, owner.userId)).body.user.phoneVerified).toBe(false);
  });

  it('links a primary domain only when it can be served: verified, certificate issued, not suspended', async () => {
    const admin = await makePlatformUser('admin');
    const owner = await registerAndActivate();
    const store = await createWorkspace(owner.accessToken, 'Pending Domain Store');
    const domain = await primaryDomain(store.id, 'pending.mona-example.com', { sslStatus: 'pending' });
    const subdomain = `https://${store.slug}.${env.platformRootDomain}`;
    const link = async () => (await getUser(admin.H, owner.userId)).body.user.workspaces[0].storeUrl;

    expect(await link()).toBe(subdomain);
    await domain.update({ sslStatus: 'issued', suspendedAt: new Date(), suspendedReason: 'plan' });
    expect(await link()).toBe(subdomain);
    await domain.update({ suspendedAt: null, suspendedReason: null });
    expect(await link()).toBe('https://pending.mona-example.com');
  });

  it('shows the sign-up location the marketing site kept, and none when it kept nothing', async () => {
    const admin = await makePlatformUser('admin');
    const tracked = await registerAndActivate();
    const untracked = await registerAndActivate();
    await visit(tracked.userId, { country: 'EG', governorate: 'giza', at: new Date('2026-10-01T10:00:00Z') });
    await visit(tracked.userId, { country: 'EG', event: 'signup', at: new Date('2026-10-01T10:05:00Z') });
    await visit(untracked.userId, {});

    const found = (await getUser(admin.H, tracked.userId)).body.user.location;
    expect(found).toEqual({ country: 'EG', governorate: 'giza', source: 'signup_visit', seenAt: '2026-10-01T10:05:00.000Z' });
    expect((await getUser(admin.H, untracked.userId)).body.user.location).toBeNull();
  });

  it('never returns a password, token or secret', async () => {
    const admin = await makePlatformUser('admin');
    const owner = await registerAndActivate();
    await createWorkspace(owner.accessToken, 'Quiet Store');

    const detail = await getUser(admin.H, owner.userId);
    const search = await request(app).get('/api/v1/admin/users').set(admin.H).query({ q: owner.email });
    const list = await listWorkspaces(admin.H);
    for (const res of [detail, search, list]) {
      expect(res.status).toBe(200);
      expect(keysOf(res.body).filter((k) => SECRET.test(k))).toEqual([]);
    }
    expect(JSON.stringify(detail.body)).not.toContain('$2'); // a bcrypt hash's prefix
  });

  it('is for creators and admins: no token, an agent or a merchant is refused', async () => {
    const owner = await registerAndActivate();
    const agent = await makePlatformUser('agent');
    const merchant = { Authorization: `Bearer ${owner.accessToken}` };
    expect((await request(app).get(`/api/v1/admin/users/${owner.userId}`)).status).toBe(401);
    expect((await request(app).get('/api/v1/admin/workspaces')).status).toBe(401);
    for (const H of [agent.H, merchant]) {
      expect((await getUser(H, owner.userId)).status).toBe(403);
      expect((await listWorkspaces(H)).status).toBe(403);
    }
  });

  it('runs the same number of queries for one store or three', async () => {
    const admin = await makePlatformUser('admin');
    const one = await registerAndActivate();
    await createWorkspace(one.accessToken, 'Only Store');
    const three = await registerAndActivate();
    for (const name of ['First Store', 'Second Store', 'Third Store']) {
      const w = await createWorkspace(three.accessToken, name);
      await primaryDomain(w.id, `${w.slug}.mona-example.com`);
    }
    await getUser(admin.H, one.userId); // warm-up: lazy model and cache loads

    const forOne = await queriesDuring(() => getUser(admin.H, one.userId));
    const forThree = await queriesDuring(() => getUser(admin.H, three.userId));
    expect(forThree).toBe(forOne);
  });
});

describe('console store list', () => {
  it('gives every store its link and its owner, who links to their page', async () => {
    const admin = await makePlatformUser('admin');
    const owner = await registerAndActivate({ fullName: 'Sara Founder' });
    const plain = await createWorkspace(owner.accessToken, 'Sara Plain');
    const branded = await createWorkspace(owner.accessToken, 'Sara Branded');
    await primaryDomain(branded.id, 'www.sara-example.com');

    const res = await listWorkspaces(admin.H);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.workspaces.map((w) => [w.id, w]));
    expect(byId[plain.id]).toMatchObject({
      storeUrl: `https://${plain.slug}.${env.platformRootDomain}`,
      owner: { id: owner.userId, fullName: 'Sara Founder', email: owner.email },
    });
    expect(byId[branded.id].storeUrl).toBe('https://www.sara-example.com');
  });

  it('gives every store its platform subdomain too, and its own domain with its state', async () => {
    const admin = await makePlatformUser('admin');
    const owner = await registerAndActivate();
    const plain = await createWorkspace(owner.accessToken, 'Nada Plain');
    const connected = await createWorkspace(owner.accessToken, 'Nada Connected');
    const pending = await createWorkspace(owner.accessToken, 'Nada Pending');
    await primaryDomain(connected.id, 'www.nada-example.com');
    await primaryDomain(pending.id, 'shop.nada-example.com', {
      status: 'pending_verification',
      sslStatus: 'none',
      isPrimary: false,
      verifiedAt: null,
    });
    const subdomain = (w) => `https://${w.slug}.${env.platformRootDomain}`;

    const res = await listWorkspaces(admin.H);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.workspaces.map((w) => [w.id, w]));

    expect(byId[plain.id]).toMatchObject({
      slug: plain.slug,
      storeUrl: subdomain(plain),
      platformUrl: subdomain(plain),
      customDomain: null,
      customDomainCount: 0,
    });
    expect(byId[connected.id]).toMatchObject({
      storeUrl: 'https://www.nada-example.com',
      platformUrl: subdomain(connected),
      customDomainCount: 1,
    });
    expect(byId[connected.id].customDomain).toEqual({
      hostname: 'www.nada-example.com',
      status: 'active',
      sslStatus: 'issued',
      primary: true,
      suspended: false,
      state: 'connected',
    });
    expect(byId[pending.id]).toMatchObject({
      storeUrl: subdomain(pending),
      platformUrl: subdomain(pending),
      customDomain: { hostname: 'shop.nada-example.com', status: 'pending_verification', sslStatus: 'none', primary: false, state: 'pending' },
      customDomainCount: 1,
    });
  });

  it('looks the links up in one query, not one per store', async () => {
    const admin = await makePlatformUser('admin');
    const owner = await registerAndActivate();
    await createWorkspace(owner.accessToken, 'Count One');
    await listWorkspaces(admin.H); // warm-up
    const before = await queriesDuring(() => listWorkspaces(admin.H));
    for (const name of ['Count Two', 'Count Three', 'Count Four']) {
      const w = await createWorkspace(owner.accessToken, name);
      await primaryDomain(w.id, `${w.slug}.count-example.com`);
    }
    expect(await queriesDuring(() => listWorkspaces(admin.H))).toBe(before);
  });
});
