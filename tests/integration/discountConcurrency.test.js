'use strict';

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

describe('Discount usage limits under concurrency', () => {
  it('a single-use discount code can only be successfully redeemed once, even under concurrent checkouts', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 100 });

    const discount = await db.Discount.create({
      workspaceId: workspace.id,
      code: 'ONCE10',
      type: 'fixed',
      value: 1000,
      usageLimit: 1,
      status: 'active',
    });

    const attempts = Array.from({ length: 5 }, (_, i) =>
      request(app)
        .post(`/api/v1/workspaces/${workspace.id}/orders`)
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .set('Idempotency-Key', `discount-race-${i}`)
        .send({
          items: [{ variantId: variant.id, quantity: 1 }],
          contact: { fullName: `Racer ${i}`, phone: `0109988${1000 + i}` },
          paymentMethod: 'cod',
          discountCode: 'ONCE10',
        })
    );

    const results = await Promise.all(attempts);
    const succeeded = results.filter((r) => r.status === 201);
    const failed = results.filter((r) => r.status !== 201);

    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(4);
    expect(failed.every((r) => r.body.error.code === 'DISCOUNT_USAGE_LIMIT_REACHED')).toBe(true);

    const finalDiscount = await db.Discount.findByPk(discount.id);
    expect(finalDiscount.usageCount).toBe(1);

    const redemptions = await db.DiscountRedemption.count({ where: { discountId: discount.id } });
    expect(redemptions).toBe(1);

    // The 4 failed attempts must not have left behind orphaned orders or
    // orphaned inventory reservations — the whole transaction (including the
    // inventory reserve) must have rolled back with the discount failure.
    const orderCount = await db.Order.count({ where: { workspaceId: workspace.id } });
    expect(orderCount).toBe(1);

    const finalVariant = await db.ProductVariant.findByPk(variant.id);
    expect(finalVariant.reservedStock).toBe(1); // only the one successful order's reservation remains
  });

  it('a per-customer limit blocks the same customer reusing a code across separate orders', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 100 });

    await db.Discount.create({
      workspaceId: workspace.id,
      code: 'ONEPERPERSON',
      type: 'percentage',
      value: 500, // 5%
      perCustomerLimit: 1,
      status: 'active',
    });

    const contact = { fullName: 'Repeat Shopper', phone: '01099990000' };

    const first = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('Idempotency-Key', 'per-customer-1')
      .send({ items: [{ variantId: variant.id, quantity: 1 }], contact, paymentMethod: 'cod', discountCode: 'ONEPERPERSON' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders`)
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('Idempotency-Key', 'per-customer-2')
      .send({ items: [{ variantId: variant.id, quantity: 1 }], contact, paymentMethod: 'cod', discountCode: 'ONEPERPERSON' });
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('DISCOUNT_PER_CUSTOMER_LIMIT_REACHED');
  });
});
