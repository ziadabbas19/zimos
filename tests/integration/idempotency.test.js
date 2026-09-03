'use strict';

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

describe('Idempotent order creation', () => {
  it('requires an Idempotency-Key header', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({
        items: [{ variantId: variant.id, quantity: 1 }],
        contact: { fullName: 'No Key Customer', phone: '01099998888' },
        paymentMethod: 'cod',
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('a sequential retry with the same key and body returns the same order, not a duplicate', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const payload = {
      items: [{ variantId: variant.id, quantity: 2 }],
      contact: { fullName: 'Retry Customer', phone: '01055556666' },
      paymentMethod: 'cod',
    };

    const first = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('Idempotency-Key', 'retry-key-1')
      .send(payload);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('Idempotency-Key', 'retry-key-1')
      .send(payload);
    expect(second.status).toBe(201);
    expect(second.body.order.id).toBe(first.body.order.id);

    const count = await db.Order.count({ where: { workspaceId: workspace.id } });
    expect(count).toBe(1);
  });

  it('N concurrent requests with the same key produce exactly ONE order (double-click / retry storm)', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const payload = {
      items: [{ variantId: variant.id, quantity: 1 }],
      contact: { fullName: 'Double Click Customer', phone: '01077778888' },
      paymentMethod: 'cod',
    };

    const attempts = Array.from({ length: 6 }, () =>
      request(app)
        .post(`/api/v1/workspaces/${workspace.id}/orders`)
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .set('Idempotency-Key', 'double-click-key')
        .send(payload)
    );
    const results = await Promise.all(attempts);

    // Every response should succeed (either the winner or a replay), and every
    // one should carry the SAME order id.
    const orderIds = new Set(results.map((r) => r.body.order && r.body.order.id).filter(Boolean));
    expect(orderIds.size).toBe(1);

    const count = await db.Order.count({ where: { workspaceId: workspace.id } });
    expect(count).toBe(1);

    // Inventory should reflect exactly one reservation of 1 unit, not six.
    const v = await db.ProductVariant.findByPk(variant.id);
    expect(v.reservedStock).toBe(1);
  });

  it('reusing the same key with a DIFFERENT payload is rejected rather than silently replayed', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });

    const first = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('Idempotency-Key', 'mismatched-key')
      .send({
        items: [{ variantId: variant.id, quantity: 1 }],
        contact: { fullName: 'Customer A', phone: '01011112222' },
        paymentMethod: 'cod',
      });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('Idempotency-Key', 'mismatched-key')
      .send({
        items: [{ variantId: variant.id, quantity: 5 }], // different quantity — different intent
        contact: { fullName: 'Customer A', phone: '01011112222' },
        paymentMethod: 'cod',
      });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('different keys for otherwise-identical requests create separate orders', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const payload = {
      items: [{ variantId: variant.id, quantity: 1 }],
      contact: { fullName: 'Repeat Customer', phone: '01033334444' },
      paymentMethod: 'cod',
    };

    const first = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('Idempotency-Key', 'key-A')
      .send(payload);
    const second = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('Idempotency-Key', 'key-B')
      .send(payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.order.id).not.toBe(second.body.order.id);

    const count = await db.Order.count({ where: { workspaceId: workspace.id } });
    expect(count).toBe(2);
  });
});
