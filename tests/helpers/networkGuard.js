'use strict';

/**
 * Keeps the suite off the internet. Installed for every test file by
 * tests/helpers/setup.js.
 *
 *   - fetch, raw sockets (net/tls, so http/https and SDK clients too) and DNS
 *     queries may only reach loopback and the test database host
 *   - Brevo gets a canned fake instead of a block: a test that switches the
 *     email provider to brevo without stubbing anything still sends nothing
 *   - anything else throws NetworkBlockedError AND fails the running test
 *     in afterEach, even when the code under test swallowed the error (as
 *     notify and the waybill logo fetch do)
 *
 * A test that stubs fetch itself (jest.spyOn(global, 'fetch')) replaces this
 * wrapper for as long as the spy lives, exactly as before.
 */

const net = require('net');
const dns = require('dns');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1', '0.0.0.0', '::']);
const allowedHosts = new Set([...LOOPBACK, (process.env.DB_HOST || 'localhost').toLowerCase()]);

const BREVO_HOST = 'api.brevo.com';

const blocked = [];

class NetworkBlockedError extends Error {
  constructor(what) {
    super(`Network access is blocked in tests: ${what}`);
    this.name = 'NetworkBlockedError';
    this.code = 'ENETBLOCKED';
  }
}

function isAllowed(host) {
  if (host == null || host === '') return true;
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return allowedHosts.has(h) || /^127\./.test(h);
}

function block(what) {
  const err = new NetworkBlockedError(what);
  blocked.push(err.message);
  return err;
}

// --- Brevo ---------------------------------------------------------------------

function fakeBrevo(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const json = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (method === 'POST' && url.pathname === '/v3/smtp/email') return json(201, { messageId: '<network-guard@brevo.test>' });
  if (method === 'GET' && url.pathname === '/v3/account') return json(200, { email: 'guard@brevo.test', plan: [] });
  return json(404, { code: 'not_found', message: 'network guard: no fake for this Brevo route' });
}

// --- fetch ------------------------------------------------------------------------

const realFetch = global.fetch;

async function guardedFetch(input, init) {
  const raw = typeof input === 'string' || input instanceof URL ? String(input) : input && input.url;
  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    return realFetch(input, init);
  }
  if (url.hostname === BREVO_HOST) return fakeBrevo(url, init);
  if (!isAllowed(url.hostname)) throw block(`fetch ${url.origin}`);
  return realFetch(input, init);
}

// --- sockets and DNS queries ---------------------------------------------------------
//
// Core modules are shared by every test file in the process (--runInBand), so
// these are patched once; each file's install() only points them at its own
// `blocked` list.

const STATE = Symbol.for('zimos.tests.networkGuard');
const RESOLVERS = ['resolve', 'resolve4', 'resolve6', 'resolveTxt', 'resolveMx', 'resolveCname', 'resolveNs', 'resolveSrv', 'resolveAny'];

function targetOf(args) {
  let first = args[0];
  // net.connect() hands the socket its already-normalised [options, cb].
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === 'object') return first.path ? null : first.host || 'localhost';
  if (typeof first === 'number' || /^\d+$/.test(String(first))) return typeof args[1] === 'string' ? args[1] : 'localhost';
  return null; // an IPC path
}

function patchCoreModules(state) {
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const host = targetOf(args);
    if (!isAllowed(host)) {
      const err = state.block(`socket to ${host}`);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return realConnect.apply(this, args);
  };

  for (const name of RESOLVERS) {
    const realResolve = dns[name];
    dns[name] = function guardedResolve(hostname, ...rest) {
      if (isAllowed(hostname)) return realResolve.call(this, hostname, ...rest);
      const cb = rest[rest.length - 1];
      const err = state.block(`DNS ${name} ${hostname}`);
      if (typeof cb === 'function') process.nextTick(() => cb(err));
      return undefined;
    };
    const realPromise = dns.promises[name];
    dns.promises[name] = async function guardedResolvePromise(hostname, ...rest) {
      if (isAllowed(hostname)) return realPromise.call(this, hostname, ...rest);
      throw state.block(`DNS ${name} ${hostname}`);
    };
  }
}

function install() {
  global.fetch = guardedFetch;
  const state = net[STATE] || (net[STATE] = {});
  state.block = block;
  if (!state.patched) {
    state.patched = true;
    patchCoreModules(state);
  }
}

/** What was blocked since the last call, cleared. */
function takeBlocked() {
  return blocked.splice(0, blocked.length);
}

module.exports = { install, takeBlocked, NetworkBlockedError, isAllowed };
