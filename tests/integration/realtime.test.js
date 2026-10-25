'use strict';

/**
 * Live updates (modules/realtime): who may connect, which rooms they are put
 * in, and that nothing of one store reaches another — the isolation of
 * tenantIsolation.test.js, over a socket. A real Socket.IO server on a free
 * port, with the postgres adapter on the test database: every message takes
 * the production path (outbox → realtime consumer → emitter NOTIFY → adapter
 * LISTEN → room).
 *
 * "Receives nothing" is always checked after a positive control received the
 * same event, so a silent socket means filtered, not slow.
 */

const fs = require('fs');
const http = require('http');
const { Op } = require('sequelize');
const path = require('path');
const { Server } = require('socket.io');
const { Adapter } = require('socket.io-adapter');
const { PostgresAdapter } = require('@socket.io/postgres-adapter');
const { io: connectSocket } = require('socket.io-client');
const WebSocket = require('ws');
const {
  app,
  request,
  registerAndActivate,
  createWorkspace,
  createProductWithVariant,
  addMemberWithRole,
  makePlatformUser,
  confirmCodOrder,
} = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const jwt = require('jsonwebtoken');
const billingService = require('../../src/modules/billing/billingService');
const pgPool = require('../../src/modules/realtime/pgPool');
const publisher = require('../../src/modules/realtime/publisher');
const { route } = require('../../src/modules/realtime/catalog');
const { createRealtimeServer, PATH } = require('../../src/modules/realtime/realtimeServer');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let server;
let realtime;
let base;
const clients = [];
const raws = [];

function listen(httpServer) {
  return new Promise((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${httpServer.address().port}`)));
}

beforeAll(async () => {
  env.realtime.enabled = true;
  server = http.createServer(app);
  realtime = createRealtimeServer(server, { app, connections: pgPool.get() });
  base = await listen(server);
});

afterEach(() => {
  for (const socket of clients.splice(0)) socket.disconnect();
  for (const ws of raws.splice(0)) ws.terminate();
  realtime.resetLimits();
  env.realtime.maxConnectionsPerUser = 10;
  env.realtime.handshakesPerMinute = 60;
});

afterAll(async () => {
  await realtime.stop();
  publisher.reset();
  await pgPool.end();
  await new Promise((resolve) => server.close(resolve));
  env.realtime.enabled = false;
});

/** A socket to `url` with `auth`; `received` collects every message, `closed` its disconnects. */
function open(auth, { url = base, headers } = {}) {
  const socket = connectSocket(url, {
    path: PATH,
    transports: ['websocket'],
    auth,
    reconnection: false,
    forceNew: true,
    timeout: 5000,
    ...(headers ? { extraHeaders: headers } : {}),
  });
  clients.push(socket);
  const received = [];
  const closed = [];
  socket.onAny((name, message) => received.push({ name, message }));
  socket.on('disconnect', (reason) => closed.push(reason));
  const ready = new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
  return { socket, received, closed, ready };
}

async function connected(token, opts) {
  const client = open({ token }, opts);
  await client.ready;
  return client;
}

/** The connect_error a handshake ends with. */
async function refusal(auth, opts) {
  const client = open(auth, opts);
  return client.ready.then(
    () => {
      throw new Error('connected, expected a refusal');
    },
    (err) => err
  );
}

/** A bare websocket to the socket server, past the engine's OPEN packet: socket.io packets are sent on it by hand. */
async function rawSocket() {
  const ws = new WebSocket(`${base.replace('http', 'ws')}${PATH}/?EIO=4&transport=websocket`);
  raws.push(ws);
  let closed = false;
  const frames = [];
  ws.on('message', (data) => frames.push(String(data)));
  ws.on('close', () => {
    closed = true;
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await waitFor(() => frames.some((f) => f.startsWith('0')), "the engine's OPEN packet");
  return { ws, frames, isClosed: () => closed };
}

async function waitFor(check, what, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const found = check();
    if (found) return found;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const named = (client, name, test = () => true) => () => client.received.find((r) => r.name === name && test(r.message));
const names = (client) => client.received.map((r) => r.name);

async function placeOrder(token, workspaceId, variantId, { quantity = 1, phone = '01000007777' } = {}) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `rt-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity }],
      contact: { fullName: 'Live Buyer', phone },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '9 Socket St' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

async function store(name, { stock = 20 } = {}) {
  const auth = await registerAndActivate({ fullName: `${name} Owner` });
  const workspace = await createWorkspace(auth.accessToken, name);
  const { product, variant } = await createProductWithVariant(auth.accessToken, workspace.id, { stock });
  return { auth, workspace, product, variant };
}

/** Every message must be exactly this shape: ids, a type and a time, nothing else. */
function expectIdsOnly(message) {
  expect(Object.keys(message).sort()).toEqual(['at', 'entity', 'id', 'type', 'v', 'workspaceId']);
  expect(Object.keys(message.entity).sort()).toEqual(['id', 'type']);
  expect(message.v).toBe(1);
  expect(message.id).toMatch(UUID);
  expect(message.entity.id).toMatch(UUID);
  if (message.workspaceId !== null) expect(message.workspaceId).toMatch(UUID);
  expect(Number.isNaN(Date.parse(message.at))).toBe(false);
}

describe('handshake', () => {
  it('refuses no token, a forged token, an expired token and a token of an account that is not active', async () => {
    const owner = await registerAndActivate();
    expect((await refusal(undefined)).message).toBe('unauthorized');
    expect((await refusal({ token: 'not-a-jwt' })).message).toBe('unauthorized');
    const forged = jwt.sign({ sub: owner.userId }, 'some-other-secret', { expiresIn: '5m' });
    expect((await refusal({ token: forged })).message).toBe('unauthorized');
    const expired = jwt.sign({ sub: owner.userId, exp: Math.floor(Date.now() / 1000) - 10 }, env.jwt.accessSecret);
    expect((await refusal({ token: expired })).message).toBe('unauthorized');

    await db.User.update({ status: 'suspended' }, { where: { id: owner.userId } });
    expect((await refusal({ token: owner.accessToken })).message).toBe('unauthorized');
  });

  it('refuses a session that has ended', async () => {
    const owner = await registerAndActivate();
    await db.Session.update({ revokedAt: new Date() }, { where: { userId: owner.userId } });
    expect((await refusal({ token: owner.accessToken })).message).toBe('session_ended');
  });

  it('refuses a browser origin outside CORS_ORIGINS before the upgrade', async () => {
    const owner = await registerAndActivate();
    const err = await refusal({ token: owner.accessToken }, { headers: { Origin: 'https://evil.example' } });
    expect(err.message).not.toBe('unauthorized');
    await connected(owner.accessToken, { headers: { Origin: env.cors.origins[0] } });
  });

  it('holds REALTIME_MAX_CONNECTIONS_PER_USER sockets per account, and refuses the next', async () => {
    env.realtime.maxConnectionsPerUser = 2;
    const owner = await registerAndActivate();
    await connected(owner.accessToken);
    await connected(owner.accessToken);
    expect((await refusal({ token: owner.accessToken })).message).toBe('too_many_connections');
    // Another account is not counted against it.
    const other = await registerAndActivate();
    await connected(other.accessToken);
  });

  it('a burst of CONNECT packets on one websocket runs one handshake, then the websocket is ended', async () => {
    const owner = await registerAndActivate();
    const findAll = jest.spyOn(db.User, 'findAll');
    try {
      const raw = await rawSocket();
      for (let i = 0; i < 50; i += 1) raw.ws.send(`40${JSON.stringify({ token: owner.accessToken })}`);
      await waitFor(raw.isClosed, 'the server to end the websocket');
      // The second CONNECT was refused as such (a socket.io CONNECT_ERROR, "44"), before the database.
      expect(raw.frames.some((f) => f.startsWith('44') && f.includes('too_many_attempts'))).toBe(true);
      // Only the first CONNECT reached the database (rooms.js reads the account with User.findAll).
      expect(findAll.mock.calls.length).toBeLessThanOrEqual(1);
      await waitFor(() => realtime.slotsHeld(owner.userId) === 0, 'the place to be given back');
      expect(realtime.io.of('/').adapter.rooms.get(`u:${owner.userId}`)).toBeUndefined();
    } finally {
      findAll.mockRestore();
    }
  });

  it('the per-account limit holds against handshakes in flight together', async () => {
    env.realtime.maxConnectionsPerUser = 2;
    const owner = await registerAndActivate();
    const attempts = Array.from({ length: 6 }, () => open({ token: owner.accessToken }));
    const results = await Promise.allSettled(attempts.map((c) => c.ready));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected').map((r) => r.reason.message)).toEqual(Array(4).fill('too_many_connections'));
  });

  it('limits connection attempts per IP (REALTIME_HANDSHAKES_PER_MINUTE)', async () => {
    env.realtime.handshakesPerMinute = 2;
    const owner = await registerAndActivate();
    await connected(owner.accessToken);
    await connected(owner.accessToken);
    const err = await refusal({ token: owner.accessToken });
    expect(err.message).not.toBe('too_many_connections');
  });
});

describe('store isolation', () => {
  it("one store's order reaches its own team and never another store, whatever the other asks for", async () => {
    const A = await store('Store A');
    const B = await store('Store B');
    // A asks for B's rooms in its handshake: the server never reads that.
    const a = await connected(A.auth.accessToken);
    const aAsking = open({ token: A.auth.accessToken, workspaceId: B.workspace.id, rooms: [`w:${B.workspace.id}:orders.view`] });
    await aAsking.ready;
    const b = await connected(B.auth.accessToken);

    const order = await placeOrder(B.auth.accessToken, B.workspace.id, B.variant.id);
    const got = await waitFor(named(b, 'order.created'), 'B order.created');
    expect(got.message.workspaceId).toBe(B.workspace.id);
    expect(got.message.entity).toEqual({ type: 'order', id: order.id });
    expectIdsOnly(got.message);

    await sleep(300);
    expect(a.received).toEqual([]);
    expect(aAsking.received).toEqual([]);
  });

  it('an event sent by the client ends its connection and joins nothing', async () => {
    const A = await store('Store A');
    const B = await store('Store B');
    const a = await connected(A.auth.accessToken);
    a.socket.emit('join', `w:${B.workspace.id}:orders.view`);
    await waitFor(() => a.closed.length > 0, 'the server to end the connection');

    const a2 = await connected(A.auth.accessToken);
    a2.socket.emit('subscribe', { workspaceId: B.workspace.id });
    await waitFor(() => a2.closed.length > 0, 'the server to end the second connection');

    const b = await connected(B.auth.accessToken);
    await placeOrder(B.auth.accessToken, B.workspace.id, B.variant.id);
    await waitFor(named(b, 'order.created'), 'B order.created');
    await sleep(300);
    expect(a.received).toEqual([]);
    expect(a2.received).toEqual([]);
  });

  it('a member of two stores hears both, each under its own store id', async () => {
    const A = await store('Store A');
    const B = await store('Store B');
    const both = await addMemberWithRole(A.auth.accessToken, A.workspace.id, 'order_operator', 'Two Stores');
    const roleB = await db.Role.findOne({ where: { workspaceId: B.workspace.id, key: 'order_operator' } });
    await request(app)
      .post(`/api/v1/workspaces/${B.workspace.id}/members`)
      .set(bearer(B.auth.accessToken))
      .send({ email: both.email, roleId: roleB.id })
      .expect(201);
    const member = await connected(both.accessToken);

    const orderA = await placeOrder(A.auth.accessToken, A.workspace.id, A.variant.id);
    const orderB = await placeOrder(B.auth.accessToken, B.workspace.id, B.variant.id);
    const gotA = await waitFor(named(member, 'order.created', (m) => m.entity.id === orderA.id), 'order A');
    const gotB = await waitFor(named(member, 'order.created', (m) => m.entity.id === orderB.id), 'order B');
    expect(gotA.message.workspaceId).toBe(A.workspace.id);
    expect(gotB.message.workspaceId).toBe(B.workspace.id);
  });

  it('a teammate without orders.view hears no order; with inventory.view it still hears stock.low', async () => {
    const A = await store('Store A', { stock: 5 });
    await db.ProductVariant.update({ lowStockThreshold: 3 }, { where: { id: A.variant.id } });
    const editor = await addMemberWithRole(A.auth.accessToken, A.workspace.id, 'editor', 'Editor');
    const ed = await connected(editor.accessToken);
    const owner = await connected(A.auth.accessToken);

    await placeOrder(A.auth.accessToken, A.workspace.id, A.variant.id, { quantity: 3 });
    await waitFor(named(owner, 'order.created'), 'owner order.created');
    const low = await waitFor(named(ed, 'stock.low'), 'editor stock.low');
    expect(low.message.entity).toEqual({ type: 'product', id: A.product.id });
    expectIdsOnly(low.message);
    await waitFor(named(owner, 'stock.low'), 'owner stock.low');
    await sleep(300);
    expect(names(ed)).toEqual(['stock.low']);
  });

  it('a move between stages is order.status_changed, ids only', async () => {
    const A = await store('Store A');
    const B = await store('Store B');
    const order = await placeOrder(A.auth.accessToken, A.workspace.id, A.variant.id);
    const a = await connected(A.auth.accessToken);
    const b = await connected(B.auth.accessToken);
    await confirmCodOrder(A.auth.accessToken, A.workspace.id, order.id);
    const moved = await waitFor(named(a, 'order.status_changed'), 'order.status_changed');
    expect(moved.message.entity).toEqual({ type: 'order', id: order.id });
    expect(moved.message.workspaceId).toBe(A.workspace.id);
    expectIdsOnly(moved.message);
    // Its outbox row names only the store and the order.
    const row = await db.DomainEvent.findOne({ where: { type: 'order.stage_changed' } });
    expect(row.payload).toEqual({ orderId: order.id });
    await sleep(300);
    expect(b.received).toEqual([]);
  });

  it('the periodic checks still catch a change no model hook saw (the safety net)', async () => {
    const A = await store('Store A');
    const operator = await addMemberWithRole(A.auth.accessToken, A.workspace.id, 'order_operator', 'Leaving');
    const op = await connected(operator.accessToken);
    const owner = await connected(A.auth.accessToken);

    // Plain SQL: no hook runs, so only the 60-second rooms check (called here) sees it.
    await db.sequelize.query('DELETE FROM memberships WHERE workspace_id = :w AND user_id = :u', { replacements: { w: A.workspace.id, u: operator.userId } });
    await realtime.syncRooms();
    await placeOrder(A.auth.accessToken, A.workspace.id, A.variant.id);
    await waitFor(named(owner, 'order.created'), 'owner order.created');
    await sleep(300);
    expect(op.received).toEqual([]);

    await db.sequelize.query('UPDATE sessions SET revoked_at = now() WHERE user_id = :u', { replacements: { u: A.auth.userId } });
    await realtime.checkSessions({ fresh: true });
    await waitFor(() => owner.closed.length > 0, 'the owner socket to close');
  });
});

describe('the moment access changes', () => {
  // Far below the periodic checks (sessions 15 s, rooms 60 s): only the cut on commit can be this quick.
  const QUICK_MS = 3000;
  const bearerOf = (auth) => bearer(auth.accessToken);
  const membershipOf = (workspaceId, userId) => db.Membership.findOne({ where: { workspaceId, userId } });

  async function closesQuickly(client, change) {
    const t0 = Date.now();
    await change();
    await waitFor(() => client.closed.length > 0, 'the socket to be closed', QUICK_MS);
    return Date.now() - t0;
  }

  it('a teammate removed from the store: closed on commit, and back in without the store', async () => {
    const A = await store('Store A');
    const operator = await addMemberWithRole(A.auth.accessToken, A.workspace.id, 'order_operator', 'Leaving');
    const op = await connected(operator.accessToken);
    const owner = await connected(A.auth.accessToken);
    const membership = await membershipOf(A.workspace.id, operator.userId);

    const took = await closesQuickly(op, () =>
      request(app).delete(`/api/v1/workspaces/${A.workspace.id}/members/${membership.id}`).set(bearerOf(A.auth)).expect(200)
    );
    expect(took).toBeLessThan(QUICK_MS);
    expect(owner.closed).toEqual([]);

    const again = await connected(operator.accessToken);
    await placeOrder(A.auth.accessToken, A.workspace.id, A.variant.id);
    await waitFor(named(owner, 'order.created'), 'owner order.created');
    await sleep(300);
    expect(again.received).toEqual([]);
  });

  it("a teammate's role changed: closed on commit, and back in with the new role's rooms only", async () => {
    const A = await store('Store A');
    const operator = await addMemberWithRole(A.auth.accessToken, A.workspace.id, 'order_operator', 'Moved');
    const op = await connected(operator.accessToken);
    const owner = await connected(A.auth.accessToken);
    const membership = await membershipOf(A.workspace.id, operator.userId);
    const editor = await db.Role.findOne({ where: { workspaceId: A.workspace.id, key: 'editor' } });

    await closesQuickly(op, () =>
      request(app).patch(`/api/v1/workspaces/${A.workspace.id}/members/${membership.id}`).set(bearerOf(A.auth)).send({ roleId: editor.id }).expect(200)
    );

    const again = await connected(operator.accessToken);
    await placeOrder(A.auth.accessToken, A.workspace.id, A.variant.id);
    await waitFor(named(owner, 'order.created'), 'owner order.created');
    await sleep(300);
    expect(names(again).filter((n) => n.startsWith('order.'))).toEqual([]);
  });

  it('a sign-out: closed on commit, and refused when it tries again', async () => {
    const owner = await registerAndActivate();
    const socket = await connected(owner.accessToken);
    await closesQuickly(socket, () => request(app).post('/api/v1/auth/logout').send({ refreshToken: owner.refreshToken }).expect(200));
    expect((await refusal({ token: owner.accessToken })).message).toBe('session_ended');
  });

  it('an account suspended: closed on commit', async () => {
    const owner = await registerAndActivate();
    const socket = await connected(owner.accessToken);
    await closesQuickly(socket, () => db.User.update({ status: 'suspended' }, { where: { id: owner.userId } }));
    expect((await refusal({ token: owner.accessToken })).message).toBe('unauthorized');
  });

  it("a change that names no account: every server checks its sockets at once", async () => {
    const A = await store('Store A');
    const operator = await addMemberWithRole(A.auth.accessToken, A.workspace.id, 'order_operator', 'Paused');
    const op = await connected(operator.accessToken);
    const owner = await connected(A.auth.accessToken);
    // Every membership of the store but the owner's, by role: the where names no user.
    const ownerRole = await db.Role.findOne({ where: { workspaceId: A.workspace.id, key: 'owner' } });
    await db.Membership.update({ status: 'suspended' }, { where: { workspaceId: A.workspace.id, roleId: { [Op.ne]: ownerRole.id } } });
    await waitFor(() => !realtime.io.of('/').adapter.rooms.get(`w:${A.workspace.id}:orders.view`)?.has(op.socket.id), 'the rooms to be worked out again', QUICK_MS);
    await placeOrder(A.auth.accessToken, A.workspace.id, A.variant.id);
    await waitFor(named(owner, 'order.created'), 'owner order.created');
    await sleep(300);
    expect(names(op).filter((n) => n.startsWith('order.'))).toEqual([]);
  });

  it('a refresh, which only rotates the session, does not end the socket', async () => {
    const owner = await registerAndActivate();
    const socket = await connected(owner.accessToken);
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: owner.refreshToken }).expect(200);
    await sleep(1500);
    expect(socket.closed).toEqual([]);
  });
});

describe('console room', () => {
  it('only console accounts with the page permission hear console events; a merchant never does', async () => {
    await billingService.seedDefaultPlans();
    const admin = await makePlatformUser('admin');
    const agent = await makePlatformUser('agent');
    const A = await store('Store A');
    const adminSocket = await connected(admin.accessToken);
    const agentSocket = await connected(agent.accessToken);
    const merchant = await connected(A.auth.accessToken);

    // merchant.created: a sign-up.
    const newcomer = await registerAndActivate({ fullName: 'Newcomer' });
    const signup = await waitFor(named(adminSocket, 'merchant.created', (m) => m.entity.id === newcomer.userId), 'merchant.created');
    expect(signup.message.workspaceId).toBe(null);
    expectIdsOnly(signup.message);

    // ticket.created: a support ticket.
    const ticket = await request(app)
      .post(`/api/v1/workspaces/${A.workspace.id}/support/tickets`)
      .set(bearer(A.auth.accessToken))
      .send({ subject: 'Help', body: 'Something is wrong.', category: 'technical' })
      .expect(201);
    const opened = await waitFor(named(adminSocket, 'ticket.created'), 'ticket.created');
    expect(opened.message.entity).toEqual({ type: 'support_ticket', id: ticket.body.ticket.id });
    expect(opened.message.workspaceId).toBe(A.workspace.id);

    // subscription.paid: a charge recorded as paid.
    const starter = await db.Plan.findOne({ where: { key: 'starter' } });
    await db.Subscription.update({ planId: starter.id }, { where: { workspaceId: A.workspace.id } });
    await request(app).post(`/api/v1/admin/workspaces/${A.workspace.id}/charges`).set(admin.H).expect(201);
    const charge = (await request(app).get(`/api/v1/admin/workspaces/${A.workspace.id}/charges`).set(admin.H)).body.charges[0];
    await request(app).post(`/api/v1/admin/charges/${charge.id}/record-payment`).set(admin.H).send({ amountReceived: Number((await db.BillingInvoice.findByPk(charge.id)).amount) }).expect(200);
    const paid = await waitFor(named(adminSocket, 'subscription.paid'), 'subscription.paid');
    expect(paid.message.entity).toEqual({ type: 'billing_invoice', id: charge.id });
    expectIdsOnly(paid.message);

    await sleep(300);
    expect(agentSocket.received).toEqual([]);
    expect(names(merchant).filter((n) => ['merchant.created', 'ticket.created', 'subscription.paid'].includes(n))).toEqual([]);
  });
});

describe('across API processes', () => {
  it('one message published once reaches the sockets of two servers through the database', async () => {
    const connections2 = pgPool.createConnections({ name: 'zimos-realtime-test-2' });
    const server2 = http.createServer(app);
    const realtime2 = createRealtimeServer(server2, { app, connections: connections2 });
    const base2 = await listen(server2);
    try {
      const A = await store('Store A');
      const on1 = await connected(A.auth.accessToken);
      const on2 = await connected(A.auth.accessToken, { url: base2 });
      const order = await placeOrder(A.auth.accessToken, A.workspace.id, A.variant.id);
      await waitFor(named(on1, 'order.created', (m) => m.entity.id === order.id), 'server 1');
      await waitFor(named(on2, 'order.created', (m) => m.entity.id === order.id), 'server 2');
      expect(names(on1).filter((n) => n === 'order.created')).toHaveLength(1);
      expect(names(on2).filter((n) => n === 'order.created')).toHaveLength(1);
    } finally {
      await realtime2.stop();
      await connections2.end();
      await new Promise((resolve) => server2.close(resolve));
    }
  });
});

describe('the LISTEN connection', () => {
  it('dropping does not end the process, and messages flow again once it is back', async () => {
    const A = await store('Store A');
    const a = await connected(A.auth.accessToken);
    const [listening] = pgPool.get().listeners();
    expect(listening).toBeTruthy();
    // What a database restart or a network reset does to it.
    await db.sequelize.query('SELECT pg_terminate_backend(:pid)', { replacements: { pid: listening.processID } });
    await waitFor(() => !pgPool.get().listeners().includes(listening), 'the dead LISTEN connection to go');
    // An unhandled 'error' from it would have thrown here and failed the test.
    await waitFor(() => pgPool.get().listeners().length === 1, 'a new LISTEN connection', 15000);

    // Its LISTEN runs right after it connects: probe until a message gets through.
    const probeId = '33333333-3333-4333-8333-333333333333';
    const got = await (async () => {
      for (let i = 0; i < 20; i += 1) {
        await publisher.publish({ id: probeId, type: 'order.created', workspaceId: A.workspace.id, payload: { orderId: probeId } }).catch(() => {});
        await sleep(500);
        const found = named(a, 'order.created', (m) => m.entity.id === probeId)();
        if (found) return found;
      }
      return null;
    })();
    expect(got).toBeTruthy();
  });

  it('waits longer after each failed attempt, with jitter, up to a cap', () => {
    expect(pgPool.listenBackoffMs(0)).toBe(0);
    for (let i = 0; i < 50; i += 1) {
      const first = pgPool.listenBackoffMs(1);
      expect(first).toBeGreaterThanOrEqual(500);
      expect(first).toBeLessThanOrEqual(1500);
      const late = pgPool.listenBackoffMs(20);
      expect(late).toBeGreaterThanOrEqual(pgPool.LISTEN_BACKOFF_MAX_MS / 2);
      expect(late).toBeLessThanOrEqual(pgPool.LISTEN_BACKOFF_MAX_MS * 1.5);
    }
  });
});

describe('catalog', () => {
  it('routes every store event to its store room and every console event to its permission room, ids only', () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const id = '22222222-2222-4222-8222-222222222222';
    const at = new Date('2026-10-24T10:00:00Z');
    const cases = [
      ['order.created', { orderId: id }, 'order.created', `w:${workspaceId}:orders.view`],
      ['order.paid', { orderId: id, financialState: 'paid' }, 'order.paid', `w:${workspaceId}:orders.view`],
      ['order.stage_changed', { orderId: id }, 'order.status_changed', `w:${workspaceId}:orders.view`],
      ['shipment.status_changed', { shipmentId: 'x', orderId: id, oldStatus: 'a', newStatus: 'b' }, 'shipment.status', `w:${workspaceId}:orders.view`],
      ['product.low_stock', { productId: id, variantId: 'v', sku: 'SKU', available: 1, threshold: 2 }, 'stock.low', `w:${workspaceId}:inventory.view`],
      ['merchant.created', { userId: id }, 'merchant.created', 'p:workspaces.view'],
      ['subscription.paid', { billingInvoiceId: id }, 'subscription.paid', 'p:subscriptions.view'],
      ['ticket.created', { ticketId: id }, 'ticket.created', 'p:support.view'],
    ];
    for (const [type, payload, name, room] of cases) {
      const routed = route({ id, type, workspaceId, payload, occurredAt: at });
      expect(routed.name).toBe(name);
      expect(routed.room).toBe(room);
      expectIdsOnly(routed.message);
      // Nothing of the payload but the one id travels.
      expect(JSON.stringify(routed.message)).not.toMatch(/SKU|financialState|available|threshold|oldStatus/);
    }
    expect(route({ id, type: 'order.created', workspaceId: null, payload: { orderId: id } })).toBe(null);
    expect(route({ id, type: 'customer.updated', workspaceId, payload: { customerId: id } })).toBe(null);
  });
});

describe('the publisher', () => {
  const ROOM = 'w:11111111-1111-4111-8111-111111111111:orders.view';

  /** A real postgres adapter on a namespace of its own, fed by hand: the format this file publishes must be what it reads. */
  function adapterOnItsOwn() {
    const io = new Server();
    const nsp = io.of('/');
    const adapter = new PostgresAdapter(nsp, {}, { publish: async () => {} });
    return { io, nsp, adapter };
  }

  it("is read by the pinned adapter: a broadcast to a room, a disconnect of a room, an event for the servers", () => {
    const { nsp, adapter } = adapterOnItsOwn();
    const broadcast = jest.spyOn(Adapter.prototype, 'broadcast').mockImplementation(() => {});
    const disconnect = jest.spyOn(Adapter.prototype, 'disconnectSockets').mockImplementation(() => {});
    const serverEvent = jest.spyOn(nsp, '_onServerSideEmit').mockImplementation(() => {});
    try {
      const body = { v: 1, id: 'e1', type: 'order.created', workspaceId: 'w1', entity: { type: 'order', id: 'o1' }, at: 'now' };
      const wire = (message) => JSON.parse(JSON.stringify(message));
      adapter.onMessage(wire(publisher.messages.broadcast(ROOM, 'order.created', body)));
      expect(broadcast).toHaveBeenCalledTimes(1);
      const [packet, opts] = broadcast.mock.calls[0];
      expect(packet).toEqual({ type: 2, data: ['order.created', body], nsp: '/' });
      expect([...opts.rooms]).toEqual([ROOM]);
      expect([...opts.except]).toEqual([]);

      adapter.onMessage(wire(publisher.messages.disconnect('u:42')));
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect([...disconnect.mock.calls[0][0].rooms]).toEqual(['u:42']);
      expect(disconnect.mock.calls[0][1]).toBe(true);

      adapter.onMessage(wire(publisher.messages.serverEvent(publisher.RESYNC_EVENT)));
      expect(serverEvent).toHaveBeenCalledWith([publisher.RESYNC_EVENT]);
    } finally {
      broadcast.mockRestore();
      disconnect.mockRestore();
      serverEvent.mockRestore();
      adapter.close();
    }
  });

  it('is pinned: an upgrade of the adapter or its cluster protocol must come through this file and the test above', () => {
    const pkg = require('../../package.json');
    const installed = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '../../node_modules', name, 'package.json'), 'utf8')).version;
    expect(pkg.dependencies['@socket.io/postgres-adapter']).toBe('0.5.0');
    expect(pkg.dependencies['socket.io-adapter']).toBe('2.5.8');
    expect(pkg.dependencies['socket.io']).toBe('4.8.4');
    expect(installed('@socket.io/postgres-adapter')).toBe('0.5.0');
    expect(installed('socket.io-adapter')).toBe('2.5.8');
    expect(installed('socket.io')).toBe('4.8.4');
    expect(pkg.dependencies['@socket.io/postgres-emitter']).toBeUndefined();
  });

  it('never sends a message too big for a NOTIFY', async () => {
    const query = jest.spyOn(pgPool.get().pool, 'query');
    try {
      const sent = await publisher.send(publisher.messages.broadcast(ROOM, 'order.created', { padding: 'x'.repeat(publisher.MAX_PAYLOAD_BYTES) }));
      expect(sent).toBe(false);
      expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
    }
  });

  it('a failed NOTIFY reaches no browser, says nothing about the database, and pauses publishing', async () => {
    const A = await store('Store A');
    const a = await connected(A.auth.accessToken);
    const failure = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED', address: '10.0.0.5', port: 5432 });
    const query = jest.spyOn(pgPool.get().pool, 'query').mockRejectedValueOnce(failure);
    try {
      const event = { id: '44444444-4444-4444-8444-444444444444', type: 'order.created', workspaceId: A.workspace.id, payload: { orderId: '55555555-5555-4555-8555-555555555555' } };
      const first = await publisher.publish(event).catch((err) => err);
      expect(first.message).toBe('live updates: publish failed');
      expect(JSON.stringify(first)).not.toMatch(/10\.0\.0\.5|5432|ECONNREFUSED/);
      // Paused: the next one does not even ask the database.
      const second = await publisher.publish(event).catch((err) => err);
      expect(second.message).toBe('live updates: publishing paused after a failure');
      expect(query).toHaveBeenCalledTimes(1);
      await sleep(500);
      expect(a.received).toEqual([]);
    } finally {
      query.mockRestore();
      publisher.reset();
    }
  });
});
