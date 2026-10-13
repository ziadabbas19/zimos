'use strict';

const express = require('express');
const request = require('supertest');
const {
  createPhoneVerificationLimiter,
  phoneVerificationLimiter,
  PHONE_VERIFICATION_CODES_PER_DAY,
} = require('../../src/core/middleware/accountLimiter');
const { errorHandler } = require('../../src/core/middleware/errorHandler');

// Phone-verification codes (core/middleware/accountLimiter): the budget is
// the account's, so naming a different number each time buys nothing.
describe('phone verification limiter', () => {
  // Every limiter is skipped under NODE_ENV=test, so this builds one without that skip.
  function appWith(max) {
    const small = express();
    small.use(express.json());
    small.use((req, res, next) => {
      req.user = { id: req.get('X-Test-User') };
      next();
    });
    small.post('/verify-phone/request', createPhoneVerificationLimiter({ max, skip: () => false }), (req, res) =>
      req.body.phone === 'bad' ? res.status(422).json({ error: { code: 'INVALID_PHONE' } }) : res.json({ sent: true })
    );
    small.use(errorHandler);
    return small;
  }
  const ask = (small, user, phone) => request(small).post('/verify-phone/request').set('X-Test-User', user).send({ phone });

  it('is built with a budget of five codes a day', () => {
    expect(PHONE_VERIFICATION_CODES_PER_DAY).toBe(5);
    expect(typeof phoneVerificationLimiter).toBe('function');
  });

  it('counts per account, whatever number each request names', async () => {
    const small = appWith(2);
    const statuses = [];
    for (const phone of ['01000000001', '01000000002', '01000000003']) {
      statuses.push((await ask(small, 'account-a', phone)).status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    // Another account has its own budget.
    expect((await ask(small, 'account-b', '01000000004')).status).toBe(200);
  });

  it('does not count a request that sent nothing', async () => {
    const small = appWith(2);
    expect((await ask(small, 'account-c', 'bad')).status).toBe(422);
    expect((await ask(small, 'account-c', 'bad')).status).toBe(422);
    expect((await ask(small, 'account-c', 'bad')).status).toBe(422);
    expect([(await ask(small, 'account-c', '01000000005')).status, (await ask(small, 'account-c', '01000000006')).status]).toEqual([200, 200]);
    expect((await ask(small, 'account-c', '01000000007')).status).toBe(429);
  });
});
