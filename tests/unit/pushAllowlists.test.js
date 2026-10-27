'use strict';

// Device notifications' allowlists (notifications/push): where a subscription
// may point, what a payload may carry, and when push counts as on at all.

const express = require('express');
const request = require('supertest');
const webpush = require('web-push');
const env = require('../../src/config/env');
const pushConfig = require('../../src/modules/notifications/push/pushConfig');
const pushEndpoints = require('../../src/modules/notifications/push/pushEndpoints');
const pushPayload = require('../../src/modules/notifications/push/pushPayload');
const { createPushTestLimiter, PUSH_TESTS_PER_MINUTE } = require('../../src/core/middleware/accountLimiter');
const { errorHandler } = require('../../src/core/middleware/errorHandler');

const loaded = { ...env.push };
afterEach(() => Object.assign(env.push, loaded));

describe('the endpoints a device may be reached at', () => {
  it.each([
    ['https://fcm.googleapis.com/fcm/send/abc:def', 'fcm'],
    ['https://updates.push.services.mozilla.com/wpush/v2/gAAAA', 'mozilla'],
    ['https://web.push.apple.com/QGv7', 'apple'],
    ['https://wns2-db5p.notify.windows.com/w/?token=BQYAAA', 'windows'],
    ['https://FCM.googleapis.com/fcm/send/abc', 'fcm'],
  ])('accepts %s as %s', (endpoint, service) => {
    expect(pushEndpoints.serviceOf(endpoint)).toBe(service);
  });

  it.each([
    ['plain http', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['another port', 'https://fcm.googleapis.com:8443/fcm/send/abc'],
    ['a user and password', 'https://user:pass@fcm.googleapis.com/fcm/send/abc'],
    ['any other host', 'https://example.com/push'],
    ['the host only in the fragment', 'https://example.com/#fcm.googleapis.com'],
    ['a look-alike host', 'https://web.push.apple.com.example.com/x'],
    ['the bare apple domain', 'https://push.apple.com/x'],
    ['an IP address', 'https://127.0.0.1/x'],
    ['an internal name', 'https://metadata.google.internal/x'],
    ['not a URL', 'fcm.googleapis.com/fcm/send/abc'],
    ['too long', `https://fcm.googleapis.com/${'a'.repeat(2100)}`],
  ])('refuses %s', (what, endpoint) => {
    expect(pushEndpoints.serviceOf(endpoint)).toBeNull();
  });
});

describe('what a device notification carries', () => {
  const customer = { customerName: 'Mona Adel', phone: '01012345678', address: '12 Tahrir St, Giza', email: 'mona@example.com' };

  it('has exactly the allowed fields, whatever the caller passes', () => {
    const json = pushPayload.build('push.test', {
      locale: 'en',
      params: customer,
      title: customer.customerName,
      body: customer.address,
      data: { ...customer },
      ...customer,
    });
    const payload = JSON.parse(json);
    expect(Object.keys(payload).sort()).toEqual([...pushPayload.FIELDS].sort());
    for (const value of Object.values(customer)) expect(json).not.toContain(value);
    expect(payload).toMatchObject({ v: 1, type: 'push.test', title: 'Zimos', count: 1 });
  });

  it('speaks the device language: Arabic unless English was chosen', () => {
    expect(JSON.parse(pushPayload.build('push.test', { locale: 'en' })).body).toMatch(/test notification/);
    expect(JSON.parse(pushPayload.build('push.test', { locale: 'ar' })).body).toMatch(/إشعار تجريبي/);
    expect(JSON.parse(pushPayload.build('push.test', { locale: 'fr' })).body).toMatch(/إشعار تجريبي/);
  });

  it.each([
    ['another site', 'https://example.com/x'],
    ['a protocol-relative link', '//example.com/x'],
    ['a backslash trick', '/\\example.com'],
    ['script', 'javascript:alert(1)'],
    ['a space', '/orders/1 x'],
  ])('opens the app root instead of %s', (what, url) => {
    expect(JSON.parse(pushPayload.build('push.test', { url })).url).toBe('/');
  });

  it('keeps a path inside the app, a safe tag and a sane count', () => {
    const payload = JSON.parse(pushPayload.build('push.test', { url: '/settings?tab=notifications', tag: 'order.new:ws-1', count: 3 }));
    expect(payload).toMatchObject({ url: '/settings?tab=notifications', tag: 'order.new:ws-1', count: 3 });
    const odd = JSON.parse(pushPayload.build('push.test', { tag: '<b>', count: 5000 }));
    expect(odd).toMatchObject({ tag: 'push.test', count: 1 });
  });

  it('refuses a type it has no text for', () => {
    expect(() => pushPayload.build('order.new', {})).toThrow(/Unknown push type/);
  });
});

describe('when push counts as on', () => {
  const pair = () => webpush.generateVAPIDKeys();

  it('is off under the suite unless a test turns it on, keys or not', () => {
    expect(env.push.enabled).toBe(false);
    expect(pushConfig.isOn()).toBe(false);
    const keys = pair();
    Object.assign(env.push, { enabled: false, vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, vapidSubject: 'mailto:ops@zimos.test' });
    expect(pushConfig.isOn()).toBe(false);
  });

  it('is on with PUSH_ENABLED and a whole, matching pair', () => {
    const keys = pair();
    Object.assign(env.push, { enabled: true, vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, vapidSubject: 'https://zimos.test' });
    expect(pushConfig.isOn()).toBe(true);
  });

  it.each([
    ['no keys', () => ({ vapidPublicKey: '', vapidPrivateKey: '', vapidSubject: 'mailto:ops@zimos.test' })],
    ['no subject', (k) => ({ vapidPublicKey: k.publicKey, vapidPrivateKey: k.privateKey, vapidSubject: '' })],
    ['a subject that is neither mailto: nor https:', (k) => ({ vapidPublicKey: k.publicKey, vapidPrivateKey: k.privateKey, vapidSubject: 'http://zimos.test' })],
    ['halves of two pairs', (k) => ({ vapidPublicKey: k.publicKey, vapidPrivateKey: pair().privateKey, vapidSubject: 'mailto:ops@zimos.test' })],
    ['a truncated public key', (k) => ({ vapidPublicKey: k.publicKey.slice(0, 40), vapidPrivateKey: k.privateKey, vapidSubject: 'mailto:ops@zimos.test' })],
    ['a private key that is not base64url', (k) => ({ vapidPublicKey: k.publicKey, vapidPrivateKey: `${k.privateKey.slice(0, -2)}!!`, vapidSubject: 'mailto:ops@zimos.test' })],
  ])('stays off with PUSH_ENABLED and %s', (what, make) => {
    Object.assign(env.push, { enabled: true, ...make(pair()) });
    expect(pushConfig.isOn()).toBe(false);
  });

  it('never writes a key into the warning it logs', () => {
    const logger = require('../../src/core/utils/logger');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const keys = pair();
    Object.assign(env.push, { enabled: true, vapidPublicKey: keys.publicKey, vapidPrivateKey: pair().privateKey, vapidSubject: 'mailto:ops@zimos.test' });
    expect(pushConfig.isOn()).toBe(false);
    expect(pushConfig.isOn()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(env.push.vapidPrivateKey);
    expect(logged).not.toContain(env.push.vapidPublicKey);
    warn.mockRestore();
  });
});

describe('the test notification limit', () => {
  it(`lets ${PUSH_TESTS_PER_MINUTE} a minute through per account, then answers 429`, async () => {
    const app = express();
    app.use((req, res, next) => {
      req.user = { id: req.get('x-user') };
      next();
    });
    app.post('/test', createPushTestLimiter({ skip: () => false }), (req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    for (let i = 0; i < PUSH_TESTS_PER_MINUTE; i += 1) {
      expect((await request(app).post('/test').set('x-user', 'a')).status).toBe(200);
    }
    expect((await request(app).post('/test').set('x-user', 'a')).status).toBe(429);
    expect((await request(app).post('/test').set('x-user', 'b')).status).toBe(200);
  });
});
