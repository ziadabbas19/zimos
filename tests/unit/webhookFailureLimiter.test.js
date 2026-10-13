'use strict';

const express = require('express');
const request = require('supertest');
const {
  createWebhookFailureLimiter,
  carrierWebhookLimiter,
  paymentWebhookLimiter,
  carrierWebhookKey,
} = require('../../src/core/middleware/rateLimiters');
const { errorHandler } = require('../../src/core/middleware/errorHandler');

// Courier and gateway webhooks (core/middleware/rateLimiters): limited per
// webhook token, a token the caller writes in the path. The failure bucket
// bounds, per IP, the requests that name tokens which do not exist.
describe('webhook failure limiter', () => {
  // Every limiter is skipped under NODE_ENV=test, so this builds one without that skip.
  function appWith(max) {
    const small = express();
    small.set('trust proxy', 1);
    small.use('/webhooks/carriers', createWebhookFailureLimiter({ prefix: 'test-carrier-failed', max, windowMs: 60000 }));
    small.post('/webhooks/carriers/:code/:token', (req, res) => (req.params.token === 'real-token' ? res.json({ ok: true }) : res.status(404).json({ error: { code: 'NOT_FOUND' } })));
    small.use(errorHandler);
    return small;
  }
  const push = (small, token, ip = '198.51.100.60') => request(small).post(`/webhooks/carriers/bosta/${token}`).set('X-Forwarded-For', ip).send({});
  const statuses = async (small, tokens, ip) => {
    const out = [];
    for (const token of tokens) out.push((await push(small, token, ip)).status);
    return out;
  };

  it('a new token in each request no longer buys a new allowance', async () => {
    const small = appWith(2);
    // Each of these names a different per-token bucket.
    expect(carrierWebhookKey({ path: '/bosta/guess-1' })).not.toBe(carrierWebhookKey({ path: '/bosta/guess-2' }));
    expect(await statuses(small, ['guess-1', 'guess-2', 'guess-3', 'guess-4'])).toEqual([404, 404, 429, 429]);
    // Another address is counted on its own.
    expect((await push(small, 'guess-5', '198.51.100.61')).status).toBe(404);
  });

  it('never counts a push that was answered', async () => {
    const small = appWith(3);
    expect(await statuses(small, ['real-token', 'real-token', 'real-token', 'real-token', 'real-token'])).toEqual([200, 200, 200, 200, 200]);
    // Two failures among them are two, however many pushes surround them.
    expect(await statuses(small, ['guess-1', 'real-token', 'real-token', 'guess-2', 'real-token', 'real-token'])).toEqual([404, 200, 200, 404, 200, 200]);
  });

  it('once that many have failed the address is refused, answered pushes included, until the window ends', async () => {
    const small = appWith(2);
    expect(await statuses(small, ['guess-1', 'guess-2', 'guess-3'])).toEqual([404, 404, 429]);
    expect((await push(small, 'real-token')).status).toBe(429);
  });

  it('is off while its limit is 0', async () => {
    const small = appWith(0);
    expect(await statuses(small, ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'])).toEqual([404, 404, 404, 404, 404, 404]);
  });

  it('sits before the per-token bucket on both webhook routes', () => {
    // [mark the scope, failures per IP, requests per token]
    expect(carrierWebhookLimiter).toHaveLength(3);
    expect(paymentWebhookLimiter).toHaveLength(3);
    expect(carrierWebhookLimiter.every((m) => typeof m === 'function')).toBe(true);
    expect(paymentWebhookLimiter.every((m) => typeof m === 'function')).toBe(true);
  });
});
