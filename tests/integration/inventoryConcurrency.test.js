'use strict';

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const inventoryService = require('../../src/modules/inventory/inventoryService');
const db = require('../../src/db/models');

describe('Inventory concurrency', () => {
  it('does not oversell when many concurrent reservations race for the last units', async () => {
    const { workspace, variant } = await setupWorkspaceWithProduct({ stock: 5 });

    const attempts = Array.from({ length: 10 }, (_, i) =>
      inventoryService
        .reserve({
          workspaceId: workspace.id,
          variantId: variant.id,
          quantity: 1,
          referenceType: 'test',
          referenceId: `attempt-${i}`,
        })
        .then(() => ({ ok: true }))
        .catch((err) => ({ ok: false, code: err.code }))
    );

    const results = await Promise.all(attempts);
    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);

    expect(succeeded.length).toBe(5);
    expect(failed.length).toBe(5);
    expect(failed.every((f) => f.code === 'INSUFFICIENT_STOCK')).toBe(true);

    const finalVariant = await db.ProductVariant.findByPk(variant.id);
    expect(finalVariant.stockOnHand).toBe(5);
    expect(finalVariant.reservedStock).toBe(5);
    expect(finalVariant.availableStock()).toBe(0);
  });

  it('does not oversell when many concurrent ORDER creations race for the last units (end-to-end, via HTTP)', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 3 });

    const attempts = Array.from({ length: 8 }, (_, i) =>
      request(app)
        .post(`/api/v1/workspaces/${workspace.id}/orders`)
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .set('Idempotency-Key', `concurrent-order-${i}`)
        .send({
          items: [{ variantId: variant.id, quantity: 1 }],
          contact: { fullName: `Customer ${i}`, phone: `0101234${1000 + i}` },
          paymentMethod: 'cod',
        })
    );

    const results = await Promise.all(attempts);
    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status !== 201);

    expect(created.length).toBe(3);
    expect(rejected.length).toBe(5);
    expect(rejected.every((r) => r.body.error.code === 'INSUFFICIENT_STOCK')).toBe(true);

    const finalVariant = await db.ProductVariant.findByPk(variant.id);
    expect(finalVariant.reservedStock).toBe(3);
    expect(finalVariant.availableStock()).toBe(0);

    const orderCount = await db.Order.count({ where: { workspaceId: workspace.id } });
    expect(orderCount).toBe(3);
  });

  it('allows overselling only when explicitly enabled on the variant', async () => {
    const { workspace, variant } = await setupWorkspaceWithProduct({ stock: 1 });
    await db.ProductVariant.update({ allowOverselling: true }, { where: { id: variant.id } });

    const attempts = Array.from({ length: 5 }, (_, i) =>
      inventoryService.reserve({
        workspaceId: workspace.id,
        variantId: variant.id,
        quantity: 1,
        referenceType: 'test',
        referenceId: `oversell-${i}`,
      })
    );
    const results = await Promise.allSettled(attempts);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const finalVariant = await db.ProductVariant.findByPk(variant.id);
    expect(finalVariant.reservedStock).toBe(5);
  });

  it('release correctly returns reserved stock to available', async () => {
    const { workspace, variant } = await setupWorkspaceWithProduct({ stock: 5 });
    await inventoryService.reserve({ workspaceId: workspace.id, variantId: variant.id, quantity: 3, referenceType: 'test', referenceId: 'r1' });

    let v = await db.ProductVariant.findByPk(variant.id);
    expect(v.availableStock()).toBe(2);

    await inventoryService.release({ workspaceId: workspace.id, variantId: variant.id, quantity: 3, referenceType: 'test', referenceId: 'r1' });
    v = await db.ProductVariant.findByPk(variant.id);
    expect(v.availableStock()).toBe(5);
    expect(v.stockOnHand).toBe(5);
  });

  it('commit permanently deducts stock and clears the reservation', async () => {
    const { workspace, variant } = await setupWorkspaceWithProduct({ stock: 5 });
    await inventoryService.reserve({ workspaceId: workspace.id, variantId: variant.id, quantity: 2, referenceType: 'test', referenceId: 'c1' });
    await inventoryService.commit({ workspaceId: workspace.id, variantId: variant.id, quantity: 2, referenceType: 'test', referenceId: 'c1' });

    const v = await db.ProductVariant.findByPk(variant.id);
    expect(v.stockOnHand).toBe(3);
    expect(v.reservedStock).toBe(0);
  });

  it('every stock mutation is recorded in the inventory movement ledger', async () => {
    const { workspace, variant } = await setupWorkspaceWithProduct({ stock: 5 });
    await inventoryService.reserve({ workspaceId: workspace.id, variantId: variant.id, quantity: 2, referenceType: 'order', referenceId: 'order-1' });
    await inventoryService.release({ workspaceId: workspace.id, variantId: variant.id, quantity: 2, referenceType: 'order', referenceId: 'order-1' });

    const movements = await db.InventoryMovement.findAll({ where: { variantId: variant.id }, order: [['createdAt', 'ASC']] });
    const types = movements.map((m) => m.type);
    expect(types).toEqual(expect.arrayContaining(['restock', 'reserve', 'release']));
  });
});
