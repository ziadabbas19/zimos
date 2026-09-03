'use strict';

const { app, request, registerAndActivate, createWorkspace, createProductWithVariant } = require('../helpers/factories');

/**
 * These tests build two completely separate workspaces (A and B), each
 * owned by a different user, and then have User B attempt every kind of
 * access against Workspace A's resources using A's *real, valid* resource
 * IDs — reads, updates, nested resources, and orders. Every attempt must
 * fail. This is the concrete proof for the spec's tenant-isolation
 * requirement, not just a design claim in a comment somewhere.
 */
describe('Tenant isolation', () => {
  let A; // { auth, workspace, product, variant }
  let B; // { auth, workspace, product, variant }

  beforeEach(async () => {
    const authA = await registerAndActivate({ fullName: 'Workspace A Owner' });
    const workspaceA = await createWorkspace(authA.accessToken, 'Workspace A');
    const { product: productA, variant: variantA } = await createProductWithVariant(authA.accessToken, workspaceA.id, {
      price: 15000,
      stock: 20,
    });
    A = { auth: authA, workspace: workspaceA, product: productA, variant: variantA };

    const authB = await registerAndActivate({ fullName: 'Workspace B Owner' });
    const workspaceB = await createWorkspace(authB.accessToken, 'Workspace B');
    const { product: productB, variant: variantB } = await createProductWithVariant(authB.accessToken, workspaceB.id, {
      price: 8000,
      stock: 5,
    });
    B = { auth: authB, workspace: workspaceB, product: productB, variant: variantB };
  });

  function asB(method, path) {
    return request(app)[method](path).set('Authorization', `Bearer ${B.auth.accessToken}`);
  }

  it('blocks reading another workspace product by direct ID', async () => {
    const res = await asB('get', `/api/v1/workspaces/${A.workspace.id}/catalog/products/${A.product.id}`);
    expect(res.status).toBe(404);
  });

  it('blocks listing another workspace products', async () => {
    const res = await asB('get', `/api/v1/workspaces/${A.workspace.id}/catalog/products`);
    expect(res.status).toBe(404);
  });

  it('blocks updating another workspace product, and the row is genuinely untouched', async () => {
    const res = await asB('patch', `/api/v1/workspaces/${A.workspace.id}/catalog/products/${A.product.id}`).send({
      name: 'Hijacked Name',
    });
    expect(res.status).toBe(404);

    const db = require('../../src/db/models');
    const product = await db.Product.findByPk(A.product.id);
    expect(product.name).not.toBe('Hijacked Name');
  });

  it('blocks mutating inventory belonging to another workspace, and stock is untouched', async () => {
    const res = await asB('post', `/api/v1/workspaces/${A.workspace.id}/inventory/${A.variant.id}/adjust`).send({
      delta: -1000,
      reason: 'attempted sabotage',
    });
    expect(res.status).toBe(404);

    const db = require('../../src/db/models');
    const variant = await db.ProductVariant.findByPk(A.variant.id);
    expect(variant.stockOnHand).toBe(20); // untouched
  });

  it('blocks creating an order against another workspace', async () => {
    const res = await asB('post', `/api/v1/workspaces/${A.workspace.id}/orders`)
      .set('Idempotency-Key', 'cross-tenant-order-attempt')
      .send({
        items: [{ variantId: A.variant.id, quantity: 1 }],
        contact: { fullName: 'Attacker', phone: '01000000000' },
        paymentMethod: 'cod',
      });
    expect(res.status).toBe(404);
  });

  it('blocks reading another workspace order by direct ID, even for a real order', async () => {
    const orderRes = await request(app)
      .post(`/api/v1/workspaces/${A.workspace.id}/orders`)
      .set('Authorization', `Bearer ${A.auth.accessToken}`)
      .set('Idempotency-Key', 'legit-order-1')
      .send({
        items: [{ variantId: A.variant.id, quantity: 1 }],
        contact: { fullName: 'Real Customer', phone: '01011112222' },
        paymentMethod: 'cod',
      });
    expect(orderRes.status).toBe(201);
    const orderId = orderRes.body.order.id;

    const res = await asB('get', `/api/v1/workspaces/${A.workspace.id}/orders/${orderId}`);
    expect(res.status).toBe(404);
  });

  it('blocks reading another workspace customers', async () => {
    await request(app)
      .post(`/api/v1/workspaces/${A.workspace.id}/orders`)
      .set('Authorization', `Bearer ${A.auth.accessToken}`)
      .set('Idempotency-Key', 'legit-order-2')
      .send({
        items: [{ variantId: A.variant.id, quantity: 1 }],
        contact: { fullName: 'Customer X', phone: '01022223333' },
        paymentMethod: 'cod',
      });

    const res = await asB('get', `/api/v1/workspaces/${A.workspace.id}/customers`);
    expect(res.status).toBe(404);
  });

  it('blocks reading another workspace COD confirmation queue', async () => {
    const res = await asB('get', `/api/v1/workspaces/${A.workspace.id}/confirmation-tasks`);
    expect(res.status).toBe(404);
  });

  it('blocks a membership/RBAC mutation against another workspace', async () => {
    const res = await asB('post', `/api/v1/workspaces/${A.workspace.id}/members`).send({
      email: B.auth.email,
      roleId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.status).toBe(404);
  });

  it('rejects a made-up workspace ID the same way as a real one you are not a member of', async () => {
    const res = await asB('get', `/api/v1/workspaces/11111111-1111-1111-1111-111111111111/catalog/products`);
    expect(res.status).toBe(404);
  });

  it('control case: a legitimate member of workspace A CAN access their own resources', async () => {
    const res = await request(app)
      .get(`/api/v1/workspaces/${A.workspace.id}/catalog/products/${A.product.id}`)
      .set('Authorization', `Bearer ${A.auth.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.product.id).toBe(A.product.id);
  });
});
