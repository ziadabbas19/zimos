'use strict';

const { capPayload } = require('../../src/modules/webhooks/webhookPayloadCap');

// The webhook body cap (webhooks/webhookPayloadCap.js): small events pass as
// they are; big ones keep their envelope and ids, marked truncated.

const envelope = { id: 'order.created:o1', type: 'order.created', createdAt: '2026-10-24T10:00:00.000Z', workspaceId: 'w1' };
const bigOrder = { id: 'o1', orderNumber: '1042', notes: 'x'.repeat(5000), items: Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, name: 'Burger' })) };

describe('capPayload', () => {
  it('leaves an event under the cap exactly as it is', () => {
    const payload = { ...envelope, data: { order: { id: 'o1', orderNumber: '1042' }, current: { stage: 'ready_to_ship' } } };
    expect(capPayload(payload, 10000)).toBe(payload);
  });

  it('cuts an event over the cap to ids, keeping the envelope and the plain values', () => {
    const payload = { ...envelope, data: { order: bigOrder, resent: true, changed: ['stage'] } };
    const capped = capPayload(payload, 2000);
    expect(capped).toMatchObject({ ...envelope, truncated: true, data: { order: { id: 'o1', orderNumber: '1042' }, resent: true, changed: ['stage'] } });
    expect(capped.originalBytes).toBe(Buffer.byteLength(JSON.stringify(payload)));
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(2000);
  });

  it('keeps only plain values and ids when the ids form is still too big', () => {
    const payload = { ...envelope, data: { order: bigOrder, changed: Array.from({ length: 400 }, () => 'financialState') } };
    const capped = capPayload(payload, 600);
    expect(capped.truncated).toBe(true);
    expect(capped.data).toEqual({ order: { id: 'o1' } });
  });

  it('0 turns the cap off', () => {
    const payload = { ...envelope, data: { order: bigOrder } };
    expect(capPayload(payload, 0)).toBe(payload);
  });
});
