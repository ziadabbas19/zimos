'use strict';

// Limiters are skipped app-wide under NODE_ENV=test (see rateLimiters.js), so
// this mounts a fresh tracking limiter with small limits on a bare app, the
// same way storefrontRateLimit.test.js does.

const express = require('express');
const request = require('supertest');
const { createTrackingLimiter } = require('../../src/core/middleware/rateLimiters');
const { errorHandler } = require('../../src/core/middleware/errorHandler');

const LIMITS = { windowMs: 60000, comboMax: 3, phoneMax: 5 };

function buildApp() {
  const app = express();
  app.get('/track', createTrackingLimiter(LIMITS), (req, res) => res.json({ keys: req.orderTracking }));
  app.use(errorHandler);
  return app;
}

const hit = (app, query) => request(app).get('/track').query(query);

async function statuses(count, send) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push((await send(i)).status);
  return out;
}

const PHONE = '201055551234';

describe('order tracking rate limiter', () => {
  it('stops one phone + order number after comboMax attempts', async () => {
    const app = buildApp();
    const query = { phone: PHONE, number: 'ORD-ABC123' };

    expect(await statuses(3, () => hit(app, query))).toEqual([200, 200, 200]);

    const blocked = await hit(app, query);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['ratelimit-limit']).toBe('3');
  });

  it('keeps a different shopper unaffected', async () => {
    const app = buildApp();
    await statuses(5, () => hit(app, { phone: PHONE, number: 'ORD-ABC123' }));

    const other = await hit(app, { phone: '201122223333', number: 'ORD-ABC123' });
    expect(other.status).toBe(200);
  });

  it('bounds enumeration across order numbers with the per-phone ceiling', async () => {
    const app = buildApp();
    // A fresh order number each time, so the combo bucket never fills; only
    // the phone bucket (phoneMax = 5) stops this.
    const results = await statuses(7, (i) => hit(app, { phone: PHONE, number: `ORD-GUESS${i}` }));
    expect(results).toEqual([200, 200, 200, 200, 200, 429, 429]);
  });

  it('does not let a blocked combo eat the phone budget', async () => {
    const app = buildApp();
    // 3 accepted, then 10 rejected by the combo bucket — none of which should
    // count against the phone ceiling.
    await statuses(13, () => hit(app, { phone: PHONE, number: 'ORD-ABC123' }));

    const others = await statuses(2, (i) => hit(app, { phone: PHONE, number: `ORD-OTHER${i}` }));
    expect(others).toEqual([200, 200]);
  });

  it('counts the same phone in different spellings as one shopper', async () => {
    const app = buildApp();
    const number = 'ORD-ABC123';

    // 01055551234 and 201055551234 normalize to the same number, and the
    // order number is keyed case-insensitively.
    expect((await hit(app, { phone: '01055551234', number })).body.keys).toEqual({ phone: PHONE, number });
    await hit(app, { phone: PHONE, number: 'ord-abc123' });
    await hit(app, { phone: '01055551234', number });

    expect((await hit(app, { phone: PHONE, number })).status).toBe(429);
  });

  it('skips a request it cannot key instead of rejecting it', async () => {
    const app = buildApp();

    // Missing, malformed and over-long values all fall through to the route
    // (in the real app, to `validate`, which answers 400) without counting.
    for (const query of [{}, { phone: PHONE }, { number: 'ORD-ABC123' }, { phone: 'nope', number: 'ORD-ABC123' }]) {
      const res = await hit(app, query);
      expect(res.status).toBe(200);
      expect(res.body.keys).toBeNull();
    }

    // …and none of that used up the real budget.
    expect(await statuses(3, () => hit(app, { phone: PHONE, number: 'ORD-ABC123' }))).toEqual([200, 200, 200]);
  });
});
