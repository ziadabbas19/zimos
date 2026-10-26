'use strict';

const orderLock = require('../../src/modules/orders/orderLock');

// A locked order's lines (orders/orderLock.maskOrder): the customer's answers
// to a product's custom fields are hidden like the rest of their details —
// the text as "••••", a photo without its upload or its link — while the
// line itself (product, quantity, price) and each field's label stay.

const order = () => ({
  id: 'o1',
  contactSnapshot: { fullName: 'Mona Adel', phone: '01001234567' },
  items: [
    {
      id: 'i1',
      productNameSnapshot: 'Cake',
      quantity: 1,
      lineTotalAmount: '25000',
      customizations: [
        { fieldId: 'msg', type: 'text', label: { en: 'Message', ar: 'رسالة' }, value: 'Happy birthday Mona' },
        { fieldId: 'pic', type: 'image', label: { en: 'Photo', ar: 'صورة' }, uploadId: 'u1', url: 'https://cdn.example/u1?sig=x', urlExpiresAt: '2026-10-27T00:00:00Z' },
        { fieldId: 'empty', type: 'text', label: { en: 'Note', ar: 'ملاحظة' }, value: '' },
      ],
    },
    { id: 'i2', productNameSnapshot: 'Candles', quantity: 2, lineTotalAmount: '1000', customizations: null },
  ],
});

describe('a locked order and its lines', () => {
  it("hides the customer's answers on each line and keeps the line and the field's label", () => {
    const masked = orderLock.maskOrder(order(), { enabled: true, mode: 'lapsed' });
    const [cake, candles] = masked.items;
    expect(cake).toMatchObject({ id: 'i1', productNameSnapshot: 'Cake', quantity: 1, lineTotalAmount: '25000' });
    expect(cake.customizations[0]).toEqual({ fieldId: 'msg', type: 'text', label: { en: 'Message', ar: 'رسالة' }, value: orderLock.MASK });
    expect(cake.customizations[1]).toMatchObject({ fieldId: 'pic', type: 'image', uploadId: null, url: null, urlExpiresAt: null });
    expect(cake.customizations[2].value).toBe('');
    expect(candles).toEqual(order().items[1]);
    expect(JSON.stringify(masked)).not.toContain('Happy birthday');
    expect(JSON.stringify(masked)).not.toContain('sig=x');
  });

  it('leaves what is not a list of answers as it is', () => {
    expect(orderLock.maskCustomizations(null)).toBeNull();
    expect(orderLock.maskCustomizations(undefined)).toBeUndefined();
    expect(orderLock.maskOrder({ id: 'o2', items: [] }, { enabled: true, mode: 'lapsed' }).items).toEqual([]);
  });
});
