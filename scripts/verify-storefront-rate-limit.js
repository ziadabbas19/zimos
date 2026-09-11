'use strict';

/**
 * Live check of the storefront rate limiter against a running API. Limiters
 * are switched off under NODE_ENV=test, so this is how the real wiring (mount
 * order in app.js, the general limiter skipping storefront traffic) is tested.
 *
 *   API_URL=http://localhost:4000 WORKSPACE=<workspace id or slug> \
 *   ACCESS_TOKEN=<staff access token, optional> \
 *   node scripts/verify-storefront-rate-limit.js
 *
 * Give it the same RATE_LIMIT_* / STOREFRONT_* environment as the server — it
 * reads the limits through src/config/env. Distinct connecting IPs are
 * simulated with X-Forwarded-For, which the API accepts from one proxy hop
 * (`trust proxy` = 1), so run it against a server you reach directly. Each run
 * picks a random IP range, except the STOREFRONT_SERVER_IP check, which has to
 * use that address: wait RATE_LIMIT_WINDOW_MS before repeating it. The run
 * creates a few dozen guest carts in the workspace.
 */

const crypto = require('crypto');
const env = require('../src/config/env');

const API_URL = (process.env.API_URL || `http://localhost:${env.port}`).replace(/\/+$/, '');
const BASE = `${API_URL}/api/${env.apiVersion}`;
const { WORKSPACE, ACCESS_TOKEN } = process.env;

const VISITOR_MAX = env.rateLimit.max;
const IP_MAX = env.rateLimit.storefrontIpMax;
const SERVER_MAX = env.rateLimit.storefrontServerMax;
const SECRET = env.storefrontProxy.secret;
const SERVER_IP = env.storefrontProxy.serverIps.find((entry) => !entry.includes('/'));

const RUN = crypto.randomInt(1, 255);
const ip = (group, n) => `10.${RUN}.${group}.${n}`;

async function send(path, { method = 'GET', from, headers = {}, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'X-Forwarded-For': from,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, headers: res.headers, json };
}

/** Runs the request thunks a few at a time; resolves to responses in order. */
async function run(thunks, concurrency = 20) {
  const responses = new Array(thunks.length);
  let next = 0;
  const worker = async () => {
    while (next < thunks.length) {
      const i = next++;
      responses[i] = await thunks[i]();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return responses;
}

const times = (n, thunk) => Array.from({ length: n }, (_, i) => () => thunk(i));
const count = (responses, status) => responses.filter((r) => r.status === status).length;

function describe(responses) {
  const byStatus = {};
  for (const r of responses) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  return `${responses.length} requests: ${Object.entries(byStatus).map(([s, n]) => `${n} x ${s}`).join(', ')}`;
}

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
}

async function main() {
  if (!WORKSPACE) throw new Error('Set WORKSPACE to the id or slug of an active workspace');
  const store = `/store/${encodeURIComponent(WORKSPACE)}`;
  const viaStorefront = (shopperIp) => ({ 'X-Storefront-Secret': SECRET, 'X-Storefront-Client-IP': shopperIp });

  const probe = await send(store, { from: ip(0, 1) });
  if (probe.status !== 200) throw new Error(`GET ${store} returned ${probe.status}: ${JSON.stringify(probe.json)}`);
  if (!probe.headers.get('ratelimit-limit')) {
    throw new Error('No RateLimit headers on the storefront API — is the server running with NODE_ENV=test?');
  }
  console.log(`API ${BASE}, workspace ${WORKSPACE}; per shopper ${VISITOR_MAX}, per IP ${IP_MAX}, storefront server ${SERVER_MAX}\n`);

  if (SECRET) {
    const server = ip(101, 1);
    const shoppers = 150;
    const browsing = await run(
      Array.from({ length: shoppers }, (_, n) => [
        () => send(store, { from: server, headers: viaStorefront(ip(1, n + 1)) }),
        () => send(`${store}/products`, { from: server, headers: viaStorefront(ip(1, n + 1)) }),
      ]).flat()
    );
    check(
      `${shoppers} shoppers x 2 requests through the storefront server (one IP) don't block each other`,
      count(browsing, 200) === browsing.length && browsing.length > VISITOR_MAX,
      describe(browsing)
    );

    const abuser = await run(times(VISITOR_MAX + 10, () => send(`${store}/products`, { from: server, headers: viaStorefront(ip(2, 1)) })));
    const bystander = await send(`${store}/products`, { from: server, headers: viaStorefront(ip(2, 2)) });
    check(
      `one shopper sending ${VISITOR_MAX + 10} requests through the storefront is stopped after ${VISITOR_MAX}, nobody else is`,
      count(abuser, 200) === VISITOR_MAX && count(abuser, 429) === 10 && bystander.status === 200,
      `${describe(abuser)}; another shopper afterwards: ${bystander.status}`
    );
  } else {
    console.log('SKIP  storefront server checks: STOREFRONT_PROXY_SECRET is not set');
  }

  const forged = await run(
    times(VISITOR_MAX + 5, (n) => send(`${store}/products`, { from: ip(103, 1), headers: { 'X-Storefront-Client-IP': ip(3, n + 1) } }))
  );
  check(
    'a made-up X-Storefront-Client-IP without the secret is ignored (limited by the connecting IP)',
    count(forged, 200) === VISITOR_MAX && count(forged, 429) === 5,
    describe(forged)
  );

  const carts = Math.min(60, VISITOR_MAX - 10, Math.floor(IP_MAX / 3));
  const cartIp = ip(104, 1);
  const created = await run(times(carts, () => send(`${store}/cart`, { method: 'POST', from: cartIp, body: {} })));
  const tokens = created.map((r) => r.json && r.json.guestToken).filter(Boolean);
  const cartReads = await run(
    tokens.flatMap((token) => [
      () => send(`${store}/cart`, { from: cartIp, headers: { 'X-Cart-Token': token } }),
      () => send(`${store}/products`, { from: cartIp, headers: { 'X-Cart-Token': token } }),
    ])
  );
  const cartTraffic = [...created, ...cartReads];
  check(
    `${carts} shoppers with their own carts behind one IP don't block each other`,
    tokens.length === carts && cartTraffic.every((r) => r.status < 400) && cartTraffic.length > VISITOR_MAX,
    describe(cartTraffic)
  );

  const rotating = await run(
    times(IP_MAX + 5, () =>
      send(`${store}/products`, { from: ip(105, 1), headers: { 'X-Cart-Token': crypto.randomBytes(24).toString('hex') } })
    )
  );
  check(
    `made-up cart tokens from one IP are capped at STOREFRONT_IP_RATE_LIMIT_MAX (${IP_MAX})`,
    count(rotating, 200) === IP_MAX && count(rotating, 429) === 5,
    describe(rotating)
  );

  if (ACCESS_TOKEN) {
    const auth = { Authorization: `Bearer ${ACCESS_TOKEN}` };
    const dashboard = await send('/workspaces', { from: ip(105, 1), headers: auth });
    check(
      'dashboard requests from an IP that used up its storefront ceiling still work',
      dashboard.status === 200,
      `GET /workspaces: ${dashboard.status}`
    );

    const admin = await run(times(VISITOR_MAX + 1, () => send('/workspaces', { from: ip(106, 1), headers: auth })));
    const storefrontAfter = await send(`${store}/products`, { from: ip(106, 1) });
    check(
      `the general limiter still stops dashboard traffic at ${VISITOR_MAX} per IP, separately from the storefront`,
      count(admin, 200) === VISITOR_MAX && count(admin, 429) === 1 && storefrontAfter.status === 200,
      `${describe(admin)}; storefront request from the same IP afterwards: ${storefrontAfter.status}`
    );
  } else {
    console.log('SKIP  dashboard checks: ACCESS_TOKEN is not set');
  }

  if (SERVER_IP) {
    const n = Math.min(VISITOR_MAX + 20, SERVER_MAX);
    const fromServer = await run(times(n, () => send(`${store}/products`, { from: SERVER_IP })));
    check(
      `STOREFRONT_SERVER_IP (${SERVER_IP}) without the secret gets the server ceiling, not the per-shopper limit`,
      count(fromServer, 200) === n && n > VISITOR_MAX,
      describe(fromServer)
    );
  } else {
    console.log('SKIP  STOREFRONT_SERVER_IP check: no single IP configured');
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
