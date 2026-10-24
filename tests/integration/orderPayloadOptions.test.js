'use strict';

// ORDER_PAYLOAD_OPTIONS_ENABLED (publicApi/publicOrderOptions.js): an order
// line in the public API and the webhooks carries its menu options, each
// choice with its external code (migration 715), and its custom-field
// answers. Off: the order exactly as before. The code is never shown to
// shoppers, and a client that does not send it never clears it.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const menuOptions = require('../../src/modules/catalog/menuOptions');
const { itemExtras } = require('../../src/modules/publicApi/publicOrderOptions');

const saved = env.publicApi.orderOptions;
afterEach(() => {
  env.publicApi.orderOptions = saved;
});

const key = () => `po-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function setup() {
  const { auth, workspace, variant, product } = await setupWorkspaceWithProduct({ price: 10000, stock: 100 });
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const api = (method, path) => request(app)[method](`/api/v1/workspaces/${workspace.id}${path}`).set(H);
  const productId = product ? product.id : variant.productId;
  const menu = await api('put', `/product-options/${productId}`).send({
    groups: [
      { name: 'الحجم', required: true, minSelect: 1, maxSelect: 1, choices: [{ name: 'صغير', priceDeltaAmount: 0 }, { name: 'كبير', priceDeltaAmount: 3000, externalCode: 'SZ-L' }] },
      { name: 'إضافات', maxSelect: 2, choices: [{ name: 'جبنة', priceDeltaAmount: 1000, externalCode: ' MOD-CHEESE ' }, { name: 'زيتون', priceDeltaAmount: 500 }] },
    ],
  });
  if (menu.status !== 200) throw new Error(`menu ${menu.status} ${JSON.stringify(menu.body)}`);
  const [size, extras] = menu.body.groups;
  const minted = await api('post', '/api-keys').send({ name: 'Till', scopes: ['orders:read'] });
  if (minted.status !== 201) throw new Error(`key ${minted.status}`);
  return { ws: workspace.id, api, variant, productId, size, extras, H, keyH: { Authorization: `Bearer ${minted.body.secret}` } };
}

async function buyBurger(ctx) {
  const res = await request(app)
    .post(`/api/v1/store/${ctx.ws}/checkout`)
    .set('Idempotency-Key', key())
    .send({
      contact: { fullName: 'Menu Buyer', phone: '01069000001' },
      shippingAddress: { country: 'EG', province: 'Cairo', city: 'Nasr City', addressLine: '5 Abbas El Akkad' },
      paymentMethod: 'cod',
      item: {
        variantId: ctx.variant.id,
        quantity: 2,
        options: [
          { groupId: ctx.size.id, choiceIds: [ctx.size.choices[1].id] },
          { groupId: ctx.extras.id, choiceIds: [ctx.extras.choices[0].id, ctx.extras.choices[1].id] },
        ],
      },
    });
  if (res.status !== 201) throw new Error(`checkout ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

describe('menu choices: the external code', () => {
  it('is saved trimmed, listed for the merchant, kept when a client leaves it out, and never shown to shoppers', async () => {
    const ctx = await setup();
    expect(ctx.size.choices.map((c) => c.externalCode)).toEqual([null, 'SZ-L']);
    expect(ctx.extras.choices[0].externalCode).toBe('MOD-CHEESE');

    // A client that does not know the field (the dashboard before this change) saves the menu again.
    const resaved = await ctx.api('put', `/product-options/${ctx.productId}`).send({
      groups: [
        { id: ctx.size.id, name: 'الحجم', required: true, minSelect: 1, maxSelect: 1, choices: ctx.size.choices.map(({ id, name, priceDeltaAmount }) => ({ id, name, priceDeltaAmount })) },
        { id: ctx.extras.id, name: 'إضافات', maxSelect: 2, choices: ctx.extras.choices.map(({ id, name, priceDeltaAmount }) => ({ id, name, priceDeltaAmount })) },
      ],
    });
    expect(resaved.status).toBe(200);
    expect(resaved.body.groups[0].choices[1].externalCode).toBe('SZ-L');

    const cleared = await ctx.api('put', `/product-options/${ctx.productId}`).send({
      groups: [{ id: ctx.size.id, name: 'الحجم', required: true, minSelect: 1, maxSelect: 1, choices: [{ id: ctx.size.choices[1].id, name: 'كبير', priceDeltaAmount: 3000, externalCode: '' }] }],
    });
    expect(cleared.body.groups[0].choices[0].externalCode).toBeNull();

    const shopper = await menuOptions.publicGroups(ctx.ws, ctx.productId);
    expect(JSON.stringify(shopper)).not.toContain('externalCode');
  });
});

describe('order lines in the public API and webhooks', () => {
  it('off: the order exactly as before', async () => {
    const ctx = await setup();
    const order = await buyBurger(ctx);
    const res = await request(app).get(`/api/v1/public/orders/${order.id}`).set(ctx.keyH);
    expect(res.status).toBe(200);
    expect(res.body.order.items[0]).not.toHaveProperty('options');
    expect(res.body.order.items[0]).not.toHaveProperty('customizations');
    expect(res.body.order).not.toHaveProperty('pos');
  });

  it('on: options as charged with each choice’s current code, in the single read, the list and a webhook', async () => {
    const ctx = await setup();
    const order = await buyBurger(ctx);
    env.publicApi.orderOptions = true;

    const one = await request(app).get(`/api/v1/public/orders/${order.id}`).set(ctx.keyH);
    expect(one.body.order.items[0].options).toEqual([
      { groupId: ctx.size.id, group: 'الحجم', choices: [{ choiceId: ctx.size.choices[1].id, name: 'كبير', priceDelta: 3000, externalCode: 'SZ-L' }] },
      {
        groupId: ctx.extras.id,
        group: 'إضافات',
        choices: [
          { choiceId: ctx.extras.choices[0].id, name: 'جبنة', priceDelta: 1000, externalCode: 'MOD-CHEESE' },
          { choiceId: ctx.extras.choices[1].id, name: 'زيتون', priceDelta: 500, externalCode: null },
        ],
      },
    ]);
    expect(one.body.order.items[0].customizations).toEqual([]);

    const list = await request(app).get('/api/v1/public/orders').set(ctx.keyH);
    expect(list.body.orders[0].items[0].options[0].choices[0].externalCode).toBe('SZ-L');

    await ctx.api('post', '/webhooks').send({ url: 'https://hooks.example.com/zimos', events: ['order.created'] });
    const resent = await ctx.api('post', '/webhooks/resend-orders').send({ orderIds: [order.id] });
    expect(resent.body.deliveries).toBe(1);
    const delivery = await db.WebhookDelivery.findOne({ where: { workspaceId: ctx.ws } });
    expect(delivery.payload.data.order.items[0].options[1].choices[0].externalCode).toBe('MOD-CHEESE');
  });

  it('a choice of another store is never read for its code', async () => {
    const a = await setup();
    const b = await setup();
    const order = await buyBurger(a);
    env.publicApi.orderOptions = true;
    // B's key cannot read A's order at all; and A's codes come from A's choices only.
    expect((await request(app).get(`/api/v1/public/orders/${order.id}`).set(b.keyH)).status).toBe(404);
    const codes = await require('../../src/modules/publicApi/publicOrderOptions').optionCodes(b.ws, [await db.Order.findByPk(order.id, { include: [{ model: db.OrderItem, as: 'items' }] })]);
    expect(codes.size).toBe(0);
  });
});

describe('custom-field answers', () => {
  it('carry the label, the value and the price; a photo is named, never its upload id', () => {
    const uploadId = '6f0c2a8e-1d7b-4a55-9b1e-3f5a2c7d9e10';
    const extras = itemExtras(
      {
        optionsSnapshot: null,
        customizations: [
          { fieldId: 'engrave', type: 'text', label: { ar: 'الاسم', en: 'Name' }, value: 'Ziad', priceDeltaAmount: 2000 },
          { fieldId: 'photo', type: 'image', label: { ar: 'صورتك' }, uploadId },
        ],
      },
      new Map()
    );
    expect(extras.options).toEqual([]);
    expect(extras.customizations).toEqual([
      { fieldId: 'engrave', type: 'text', label: { ar: 'الاسم', en: 'Name' }, value: 'Ziad', priceDelta: 2000 },
      { fieldId: 'photo', type: 'image', label: { ar: 'صورتك', en: '' }, value: null, photo: true, priceDelta: 0 },
    ]);
    expect(JSON.stringify(extras)).not.toContain(uploadId);
  });
});
