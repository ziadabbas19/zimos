'use strict';

// The texts of the merchant's device notifications (notifications/push/pushPayload.js
// TEXTS) and what a gathered notification keeps (pushDigest.refsOf): every type that
// can be pushed has its sentences in both languages, they take only their params,
// and nothing about a customer can reach them.

const pushPayload = require('../../src/modules/notifications/push/pushPayload');
const pushDigest = require('../../src/modules/notifications/push/pushDigest');
const { TYPES } = require('../../src/modules/notifications/merchantNotificationService');

const build = (type, opts) => JSON.parse(pushPayload.build(type, opts));
const customer = { customerName: 'Mona Adel', phone: '01012345678', address: '12 Tahrir St', email: 'mona@example.com', message: 'Where is my order?' };

describe('the texts of every type create() can push', () => {
  // Announcements reach the bell by syncAnnouncements, never through create().
  const pushable = Object.keys(TYPES).filter((type) => type !== 'announcement');

  it.each(pushable)('%s: one, bare and many, in Arabic and English', (type) => {
    for (const locale of ['ar', 'en']) {
      const words = pushPayload.TEXTS[type][locale];
      expect([type, locale, typeof words.title, typeof words.body, typeof words.bare, typeof words.many]).toEqual([type, locale, 'string', 'string', 'string', 'string']);
      expect(build(type, { locale, params: { storeName: 'Nile Store' }, count: 3 }).body).toMatch(/3/);
    }
  });
});

describe('an order', () => {
  const params = { storeName: 'Nile Store', orderNumber: '1043', amount: { minor: 45000, currency: 'EGP' }, ...customer };

  it("one: the store's name, the order's number and amount; nothing else it was given", () => {
    const en = build('order.new', { locale: 'en', params, url: '/orders/abc?workspace=ws', tag: 'order.new:ws' });
    expect(en).toEqual({ v: 1, type: 'order.new', title: 'Nile Store', body: 'New order 1043 for 450.00 EGP', url: '/orders/abc?workspace=ws', tag: 'order.new:ws', count: 1 });
    expect(build('order.new', { locale: 'ar', params }).body).toBe('طلب جديد 1043 بقيمة 450.00 EGP');
    const json = pushPayload.build('order.paid', { locale: 'en', params });
    for (const value of Object.values(customer)) expect(json).not.toContain(value);
  });

  it('many: a count, without any one order', () => {
    expect(build('order.new', { locale: 'en', params, count: 5 }).body).toBe('5 new orders');
    expect(build('order.new', { locale: 'ar', params, count: 5 }).body).toBe('طلبات جديدة: 5');
    expect(build('order.paid', { locale: 'en', params, count: 2 }).body).toBe('2 orders were paid');
  });

  it('without its details (the order is gone, an odd number or currency): the bare sentence, and Zimos for a missing store name', () => {
    expect(build('order.new', { locale: 'en', params: {} })).toMatchObject({ title: 'Zimos', body: 'A new order' });
    expect(build('order.new', { locale: 'en', params: { ...params, orderNumber: '<script>' } }).body).toBe('A new order');
    expect(build('order.paid', { locale: 'en', params: { ...params, amount: { minor: 100, currency: 'egp' } } }).body).toBe('An order was paid');
  });

  it("the store's name: one line of at most 60 characters", () => {
    const title = build('order.new', { locale: 'en', params: { ...params, storeName: `Nile\nStore${'x'.repeat(80)}` } }).title;
    expect(title).not.toMatch(/\n/);
    expect(title.length).toBeLessThanOrEqual(60);
  });
});

describe('what a gathered notification keeps', () => {
  it('only the ids its type names, and only when they look like ids', () => {
    expect(pushDigest.refsOf('order.new', { orderId: 'a1b2c3', orderNumber: '1043', customerName: 'Mona', total: '450 EGP' })).toEqual({ orderId: 'a1b2c3' });
    expect(pushDigest.refsOf('order.new', { orderId: 'Mona Adel, 12 Tahrir St' })).toEqual({});
    expect(pushDigest.refsOf('whatsapp.message', { conversationId: 'c-1', text: 'hello', phone: '0101' })).toEqual({ conversationId: 'c-1' });
    expect(pushDigest.refsOf('lost_order.new', { checkoutSessionId: 's-1', phone: '0101' })).toEqual({});
  });

  it('a WhatsApp conversation is a window of its own; other types one per kind', () => {
    expect(pushDigest.groupKeyOf('whatsapp.message', { conversationId: 'c-1' })).toBe('whatsapp.message:c-1');
    expect(pushDigest.groupKeyOf('order.new', { orderId: 'o-1' })).toBe('order.new');
  });

  it('windows: 20 seconds for orders, 5 minutes per conversation, an hour for lost orders', () => {
    expect(pushDigest.kindOf('order.new').windowMs).toBe(20000);
    expect(pushDigest.kindOf('order.paid').windowMs).toBe(20000);
    expect(pushDigest.kindOf('whatsapp.message').windowMs).toBe(5 * 60 * 1000);
    expect(pushDigest.kindOf('lost_order.new').windowMs).toBe(60 * 60 * 1000);
  });
});
