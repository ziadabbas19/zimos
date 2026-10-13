'use strict';

const express = require('express');
const request = require('supertest');
const { createAuthLimiter, authLimiter } = require('../../src/core/middleware/rateLimiters');
const { errorHandler } = require('../../src/core/middleware/errorHandler');

// The auth limiter's bucket (core/middleware/rateLimiters): per IP, and per
// IP + account where the body names one. The body is read before validation,
// so what it says about the account is bounded and normalised first.
describe('auth limiter key', () => {
  // Every limiter is skipped under NODE_ENV=test, so this builds one without that skip.
  function appWith(max) {
    const small = express();
    small.set('trust proxy', 1);
    small.use(express.json({ limit: '1mb' }));
    small.post('/login', createAuthLimiter({ windowMs: 60000, max, skip: () => false }), (req, res) => res.json({ ok: true }));
    small.use(errorHandler);
    return small;
  }
  const send = (small, body, ip = '198.51.100.40') => request(small).post('/login').set('X-Forwarded-For', ip).send(body);
  const statuses = async (small, bodies, ip) => {
    const out = [];
    for (const body of bodies) out.push((await send(small, body, ip)).status);
    return out;
  };

  it('is exported as a limiter and as its factory', () => {
    expect(typeof authLimiter).toBe('function');
    expect(typeof createAuthLimiter).toBe('function');
  });

  it('one account is one bucket however its address is spelled', async () => {
    const small = appWith(2);
    expect(await statuses(small, [{ email: 'owner@example.com' }, { email: 'OWNER@Example.com' }, { email: '  owner@example.com ' }])).toEqual([200, 200, 429]);
  });

  it('follows `identifier` before `email`, as the sign-in lookup does', async () => {
    const small = appWith(2);
    expect(
      await statuses(small, [
        { identifier: 'victim@example.com', email: 'throwaway1@example.com' },
        { identifier: 'victim@example.com', email: 'throwaway2@example.com' },
        { identifier: 'victim@example.com', email: 'throwaway3@example.com' },
      ])
    ).toEqual([200, 200, 429]);
  });

  it('a value that is not a string names no bucket of its own', async () => {
    const small = appWith(2);
    // Each of these was a fresh bucket; all of them, and a body naming nobody, are the IP's.
    expect(await statuses(small, [{ email: ['a@example.com'] }, { email: { $ne: 'x' } }, { email: 12345 }, {}])).toEqual([200, 200, 429, 429]);
  });

  it('only the first 320 characters of a long value count, so its size buys nothing', async () => {
    const small = appWith(2);
    const head = 'a'.repeat(320);
    const bodies = [1, 2, 3].map((n) => ({ email: head + String(n).repeat(400 * 1024 - 320) }));
    expect(await statuses(small, bodies)).toEqual([200, 200, 429]);
  });

  it('still counts another IP, and another account from the same IP, on their own', async () => {
    const small = appWith(2);
    expect(await statuses(small, [{ email: 'a@example.com' }, { email: 'a@example.com' }, { email: 'a@example.com' }])).toEqual([200, 200, 429]);
    expect((await send(small, { email: 'a@example.com' }, '198.51.100.41')).status).toBe(200);
    // Naming a different account is a different bucket: the routes that must
    // bound that per IP mount an IP-only limiter as well.
    expect((await send(small, { email: 'b@example.com' })).status).toBe(200);
  });
});
