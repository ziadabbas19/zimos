'use strict';

// Every console route, read from the routers themselves so a new one is
// covered the day it is added: it has to name its permission (the guard comes
// before validation and the handler), and it answers 403 to anyone without it.

const fs = require('fs');
const path = require('path');
const { app, request, registerAndActivate, setPlatformRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const { ALL_PLATFORM_PERMISSIONS } = require('../../src/core/security/platformPermissions');

const MOUNTS = [
  ['/api/v1/admin', require('../../src/modules/billing/adminRoutes')],
  ['/api/v1/admin', require('../../src/modules/billing/paymentAdminRoutes')],
  ['/api/v1/admin', require('../../src/modules/platformAdmin/platformAdminRoutes')],
  ['/api/v1/admin/service-listings', require('../../src/modules/serviceListings/serviceListingRoutes').admin],
];

// Console actions that live outside /admin.
const ELSEWHERE = [['post', '/api/v1/billing/run-trial-check']];

// Allowed through the guard, these fire real requests at third parties, so the
// third check below stops at the guard's own answer.
const CALLS_THIRD_PARTIES = new Set(['POST /api/v1/admin/system/services/check']);

const SOME_ID = '00000000-0000-4000-8000-000000000000';

function routesOf(router, prefix) {
  return router.stack.flatMap((layer) => {
    if (layer.route) {
      const guards = layer.route.stack.map((s) => s.handle.platformPermissions).filter(Boolean);
      return Object.keys(layer.route.methods).map((method) => ({
        method,
        pattern: `${prefix}${layer.route.path === '/' ? '' : layer.route.path}`,
        permissions: guards[0] || null,
        guardIndex: layer.route.stack.findIndex((s) => s.handle.platformPermissions),
      }));
    }
    return layer.handle && layer.handle.stack ? routesOf(layer.handle, prefix) : [];
  });
}

const urlOf = (pattern) => pattern.replace(/:[A-Za-z]+/g, SOME_ID);
const consoleRoutes = () => MOUNTS.flatMap(([prefix, router]) => routesOf(router, prefix));

async function accountHolding(permissions) {
  const auth = await registerAndActivate();
  await setPlatformRole(auth.userId, 'admin');
  await db.User.update({ platformPermissions: permissions }, { where: { id: auth.userId } });
  return { ...auth, H: { Authorization: `Bearer ${auth.accessToken}` } };
}

const hit = (who, { method, url }) => request(app)[method](url).set(who.H).send({});

describe('every console route', () => {
  it('is covered: a new /admin mount has to be added to this file', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/app.js'), 'utf8');
    const mounted = source.match(/\.use\('\/admin[^']*'/g) || [];
    expect(mounted).toHaveLength(MOUNTS.length);
    expect(consoleRoutes().length).toBeGreaterThan(140);
  });

  it('names one known permission, before anything else that can answer', () => {
    const problems = [];
    for (const route of consoleRoutes()) {
      const name = `${route.method.toUpperCase()} ${route.pattern}`;
      if (!route.permissions) problems.push(`${name}: no permission`);
      else if (!route.permissions.every((key) => ALL_PLATFORM_PERMISSIONS.includes(key))) problems.push(`${name}: unknown ${route.permissions}`);
    }
    expect(problems).toEqual([]);
  });

  it('answers 403 to an account with no permissions, whatever the id or body', async () => {
    const nobody = await accountHolding([]);
    const plain = await registerAndActivate();
    const stranger = { H: { Authorization: `Bearer ${plain.accessToken}` } };
    const wrong = [];
    for (const route of [...consoleRoutes(), ...ELSEWHERE.map(([method, pattern]) => ({ method, pattern }))]) {
      const target = { method: route.method, url: urlOf(route.pattern) };
      for (const who of [nobody, stranger]) {
        const res = await hit(who, target);
        if (res.status !== 403) wrong.push(`${route.method.toUpperCase()} ${route.pattern}: ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120000);

  it('answers 401 without a session', async () => {
    const wrong = [];
    for (const route of consoleRoutes()) {
      const res = await request(app)[route.method](urlOf(route.pattern)).send({});
      if (res.status !== 401) wrong.push(`${route.method.toUpperCase()} ${route.pattern}: ${res.status}`);
    }
    expect(wrong).toEqual([]);
  }, 120000);

  it('takes effect on the next request: 403 without its own key, past the guard with it', async () => {
    const account = await accountHolding([]);
    const wrong = [];
    for (const route of consoleRoutes()) {
      const name = `${route.method.toUpperCase()} ${route.pattern}`;
      const target = { method: route.method, url: urlOf(route.pattern) };
      const others = ALL_PLATFORM_PERMISSIONS.filter((key) => !route.permissions.includes(key));
      await db.User.update({ platformPermissions: others }, { where: { id: account.userId } });
      const without = await hit(account, target);
      if (without.status !== 403) wrong.push(`${name}: ${without.status} without its key`);

      if (CALLS_THIRD_PARTIES.has(name)) continue;
      await db.User.update({ platformPermissions: route.permissions }, { where: { id: account.userId } });
      const held = await hit(account, target);
      if (held.status === 401 || (held.status === 403 && /platform permission/.test(JSON.stringify(held.body)))) {
        wrong.push(`${name}: ${held.status} with its key`);
      }
    }
    expect(wrong).toEqual([]);
  }, 240000);
});
