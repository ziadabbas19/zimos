'use strict';

// The public account and review endpoints: a per-IP limit on the account
// endpoints that a new email doesn't get round, and two public endpoints kept
// closed behind flags until their identity checks are stronger — review
// submission (a phone number alone) and password reset by SMS.

const express = require('express');
const {
  app,
  request,
  setupWorkspaceWithProduct,
  registerAndActivate,
  confirmCodOrder,
} = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const { createAuthIpLimiter } = require('../../src/core/middleware/rateLimiters');
const { errorHandler } = require('../../src/core/middleware/errorHandler');

afterEach(() => {
  env.reviews.publicSubmissionEnabled = false;
  env.passwordReset.smsEnabled = false;
  jest.restoreAllMocks();
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

describe('the per-IP limit on the account endpoints', () => {
  // Every limiter is skipped under NODE_ENV=test (rateLimiters' `skip`), so
  // these build a small one from the same factory, without that skip.
  function limitedApp(options) {
    const small = express();
    small.set('trust proxy', 1);
    small.use(express.json());
    small.post('/auth', createAuthIpLimiter({ windowMs: 60 * 1000, prefix: 'test-auth-ip', ...options }), (req, res) =>
      req.body.password === 'right' ? res.json({ ok: true }) : res.status(401).json({ ok: false })
    );
    small.use(errorHandler);
    return small;
  }
  const from = (target, ip, body) => request(target).post('/auth').set('X-Forwarded-For', ip).send(body);

  it('counts the IP whatever email each request sends, and not other IPs', async () => {
    const small = limitedApp({ max: 3 });
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push((await from(small, '198.51.100.20', { email: `new${i}@example.com`, password: 'right' })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect((await from(small, '198.51.100.21', { email: 'other@example.com', password: 'right' })).status).toBe(200);
  });

  it('for sign-in, counts failed attempts only', async () => {
    const small = limitedApp({ max: 2, failedOnly: true });
    const ip = '198.51.100.22';
    for (let i = 0; i < 5; i += 1) {
      expect((await from(small, ip, { email: `ok${i}@example.com`, password: 'right' })).status).toBe(200);
    }
    const failures = [];
    for (let i = 0; i < 3; i += 1) {
      failures.push((await from(small, ip, { email: `guess${i}@example.com`, password: 'wrong' })).status);
    }
    expect(failures).toEqual([401, 401, 429]);
  });
});

describe('public review submission (REVIEWS_PUBLIC_SUBMISSION_ENABLED)', () => {
  const PHONE = '01000008888';

  async function deliveredPurchase() {
    const s = await setupWorkspaceWithProduct();
    const order = await request(app)
      .post(`/api/v1/workspaces/${s.workspace.id}/orders`)
      .set(bearer(s.auth.accessToken))
      .set('Idempotency-Key', `hard-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .send({
        items: [{ variantId: s.variant.id, quantity: 1 }],
        contact: { fullName: 'Buyer', phone: PHONE },
        shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 St' },
        paymentMethod: 'cod',
      });
    if (order.status !== 201) throw new Error(`order failed: ${order.status} ${JSON.stringify(order.body)}`);
    const orderId = order.body.order.id;
    await confirmCodOrder(s.auth.accessToken, s.workspace.id, orderId);
    const ship = await request(app)
      .post(`/api/v1/workspaces/${s.workspace.id}/orders/${orderId}/shipments`)
      .set(bearer(s.auth.accessToken))
      .send({ carrierCode: 'local-courier' });
    await request(app)
      .patch(`/api/v1/workspaces/${s.workspace.id}/orders/${orderId}/shipments/${ship.body.shipment.id}`)
      .set(bearer(s.auth.accessToken))
      .send({ status: 'delivered' })
      .expect(200);
    return s;
  }
  const submit = (workspaceId, productId, body) =>
    request(app).post(`/api/v1/store/${workspaceId}/products/${productId}/reviews`).send(body);

  it('closed: the same 404 for a buyer, a stranger, an unknown product and a malformed body, naming none of them', async () => {
    const s = await deliveredPurchase();
    const answers = await Promise.all([
      submit(s.workspace.id, s.product.id, { phone: PHONE, rating: 5 }),
      submit(s.workspace.id, s.product.id, { phone: '01000007777', rating: 5 }),
      submit(s.workspace.id, '00000000-0000-4000-8000-000000000000', { phone: PHONE, rating: 5 }),
      submit(s.workspace.id, s.product.id, { nonsense: true }),
    ]);
    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Not found' });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(s.product.id);
      expect(text).not.toContain(PHONE);
    }
    expect(await db.Review.count()).toBe(0);
  });

  it('open: anyone may send (each waits for the merchant), and reading reviews never depended on the flag', async () => {
    const s = await deliveredPurchase();
    env.reviews.publicSubmissionEnabled = true;
    // A phone with no purchase is taken too; it never counts in the stars (reviews.test.js).
    expect((await submit(s.workspace.id, s.product.id, { phone: '01000007777', rating: 5 })).status).toBe(201);
    const ok = await submit(s.workspace.id, s.product.id, { phone: PHONE, rating: 5 });
    expect(ok.status).toBe(201);

    env.reviews.publicSubmissionEnabled = false;
    const list = await request(app).get(`/api/v1/workspaces/${s.workspace.id}/reviews`).set(bearer(s.auth.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.reviews).toHaveLength(2);
  });
});

describe('password reset by SMS (PASSWORD_RESET_SMS_ENABLED)', () => {
  it('closed: the request answers the same for a verified number and an unknown one, and sends nothing', async () => {
    const sms = jest.spyOn(notify, 'sms');
    const { userId } = await registerAndActivate();
    await db.User.update({ phone: '201010101011', phoneVerifiedAt: new Date() }, { where: { id: userId } });

    const answers = [];
    for (const phone of ['01010101011', '01099999999', '01010101011', '01010101011', '01010101011']) {
      answers.push(await request(app).post('/api/v1/auth/password-reset/sms/request').send({ phone }));
    }
    for (const res of answers) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    }
    expect(sms).not.toHaveBeenCalled();
    expect(await db.OtpCode.count()).toBe(0);
  });

  it('closed: the confirmation answers as a wrong code does, whatever is sent', async () => {
    for (const body of [{ phone: '01010101011', code: '123456', newPassword: 'NewPassw0rd!1' }, {}]) {
      const res = await request(app).post('/api/v1/auth/password-reset/sms/confirm').send(body);
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'INVALID_CODE', message: 'That code is not valid' });
    }
  });

  it('open: a verified number gets its code', async () => {
    env.passwordReset.smsEnabled = true;
    const sms = jest.spyOn(notify, 'sms');
    const { userId } = await registerAndActivate();
    await db.User.update({ phone: '201010101012', phoneVerifiedAt: new Date() }, { where: { id: userId } });
    const res = await request(app).post('/api/v1/auth/password-reset/sms/request').send({ phone: '01010101012' });
    expect(res.body).toEqual({ success: true });
    expect(sms).toHaveBeenCalledTimes(1);
  });
});
