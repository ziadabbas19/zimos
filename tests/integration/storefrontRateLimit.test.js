'use strict';

// Limiters are skipped app-wide under NODE_ENV=test (see rateLimiters.js), so
// these tests mount a fresh storefront limiter with small limits on a bare app.
// `trust proxy` = 1 as in src/app.js, so X-Forwarded-For stands in for the
// connecting address. scripts/verify-storefront-rate-limit.js checks the real
// wiring against a running server.

const express = require('express');
const request = require('supertest');
const { createStorefrontLimiter } = require('../../src/core/middleware/rateLimiters');
const { errorHandler } = require('../../src/core/middleware/errorHandler');

const SECRET = 'f'.repeat(64);
const STOREFRONT_SERVER = '198.51.100.10';
const LIMITS = { windowMs: 60000, visitorMax: 3, ipMax: 6, serverMax: 10 };

function buildApp(options = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/store', createStorefrontLimiter({ ...LIMITS, secret: SECRET, ...options }));
  app.get('/store/:workspaceId', (req, res) => res.json({ visitorKey: req.storefrontClient.visitorKey }));
  app.use(errorHandler);
  return app;
}

function hit(app, from, headers = {}) {
  return request(app).get('/store/ws').set('X-Forwarded-For', from).set(headers);
}

const viaStorefront = (shopperIp) => ({ 'X-Storefront-Secret': SECRET, 'X-Storefront-Client-IP': shopperIp });
const cartToken = (n) => n.toString(16).padStart(48, '0');

async function statuses(count, send) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push((await send(i)).status);
  return out;
}

describe('storefront rate limiter', () => {
  it('counts shoppers forwarded by the storefront server separately', async () => {
    const app = buildApp();
    // 4 shoppers x 2 requests from one server IP: over visitorMax and ipMax,
    // within serverMax.
    const results = await statuses(8, (i) => hit(app, STOREFRONT_SERVER, viaStorefront(`203.0.113.${Math.floor(i / 2) + 1}`)));
    expect(results).toEqual(Array(8).fill(200));

    const res = await hit(app, STOREFRONT_SERVER, viaStorefront('203.0.113.99'));
    expect(res.body.visitorKey).toBe('ip:203.0.113.99');
  });

  it('still stops a single shopper who goes over the limit through the storefront, and only them', async () => {
    const app = buildApp();
    const abuser = await statuses(3, () => hit(app, STOREFRONT_SERVER, viaStorefront('203.0.113.1')));
    expect(abuser).toEqual([200, 200, 200]);

    const blocked = await hit(app, STOREFRONT_SERVER, viaStorefront('203.0.113.1'));
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');

    const other = await hit(app, STOREFRONT_SERVER, viaStorefront('203.0.113.2'));
    expect(other.status).toBe(200);
    expect(other.headers['ratelimit-limit']).toBe('3');
  });

  it("doesn't let one shopper's rejected requests use up the storefront server's ceiling", async () => {
    const app = buildApp();
    await statuses(20, () => hit(app, STOREFRONT_SERVER, viaStorefront('203.0.113.1')));
    // 3 accepted above + 7 here = serverMax.
    const others = await statuses(7, (i) => hit(app, STOREFRONT_SERVER, viaStorefront(`203.0.113.${i + 2}`)));
    expect(others).toEqual(Array(7).fill(200));
  });

  it('ignores a forwarded shopper IP that comes without the right secret', async () => {
    const app = buildApp();
    const noSecret = await statuses(4, (i) => hit(app, '192.0.2.1', { 'X-Storefront-Client-IP': `203.0.113.${i + 1}` }));
    expect(noSecret).toEqual([200, 200, 200, 429]);

    const wrongSecret = await statuses(4, (i) =>
      hit(app, '192.0.2.2', { 'X-Storefront-Secret': 'e'.repeat(64), 'X-Storefront-Client-IP': `203.0.113.${i + 1}` })
    );
    expect(wrongSecret).toEqual([200, 200, 200, 429]);
  });

  it('never trusts the secret header when no secret is configured', async () => {
    const app = buildApp({ secret: '' });
    const results = await statuses(4, (i) => hit(app, '192.0.2.3', viaStorefront(`203.0.113.${i + 1}`)));
    expect(results).toEqual([200, 200, 200, 429]);
  });

  it('splits shoppers behind one IP by cart token, with a per-IP ceiling on token rotation', async () => {
    const app = buildApp();
    // 3 carts x 2 requests: over visitorMax, exactly ipMax.
    const shared = await statuses(6, (i) => hit(app, '192.0.2.10', { 'X-Cart-Token': cartToken(Math.floor(i / 2) + 1) }));
    expect(shared).toEqual(Array(6).fill(200));

    // A new token has a fresh visitor bucket, but the IP has used its ceiling.
    const rotated = await hit(app, '192.0.2.10', { 'X-Cart-Token': cartToken(99) });
    expect(rotated.status).toBe(429);
  });

  it('keys a malformed cart token by IP alone', async () => {
    const app = buildApp();
    const tokens = ['abc', 'z'.repeat(48), 'A'.repeat(48), `${cartToken(1)}0`];
    const results = await statuses(4, (i) => hit(app, '192.0.2.20', { 'X-Cart-Token': tokens[i] }));
    expect(results).toEqual([200, 200, 200, 429]);
  });

  it("bounds the storefront server's own calls (no shopper IP) by the server ceiling alone", async () => {
    const app = buildApp();
    const results = await statuses(11, () => hit(app, STOREFRONT_SERVER, { 'X-Storefront-Secret': SECRET }));
    expect(results).toEqual([...Array(10).fill(200), 429]);
  });

  it('STOREFRONT_SERVER_IP raises that IP to the server ceiling without trusting its forwarded IP', async () => {
    const app = buildApp({ serverIps: ['198.51.100.0/24'] });
    const listed = await statuses(11, (i) => hit(app, '198.51.100.77', { 'X-Storefront-Client-IP': `203.0.113.${i + 1}` }));
    expect(listed).toEqual([...Array(10).fill(200), 429]);

    const forwarded = await hit(app, '::ffff:198.51.100.78', { 'X-Storefront-Client-IP': '203.0.113.5' });
    expect(forwarded.status).toBe(200);
    expect(forwarded.body.visitorKey).toBeNull();

    const unlisted = await statuses(4, () => hit(app, '198.51.101.1'));
    expect(unlisted).toEqual([200, 200, 200, 429]);
  });

  it('rejects a malformed STOREFRONT_SERVER_IP entry at startup', () => {
    for (const entry of ['1.2.3.4/', '1.2.3.4/33', 'not-an-ip', '10.0.0.0/8/1']) {
      expect(() => createStorefrontLimiter({ ...LIMITS, secret: SECRET, serverIps: [entry] })).toThrow(/STOREFRONT_SERVER_IP/);
    }
  });
});
