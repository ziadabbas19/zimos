'use strict';

// orders/orderService.priceLines: a list priced at once answers exactly what
// priceLine answers line by line, in fewer reads. The shipping quote, the
// checkout autosave and the coupon preview price their lines through it.

const { registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const { generateProductCode } = require('../../src/modules/catalog/catalogService');
const { priceLine, priceLines } = require('../../src/modules/orders/orderService');
const { quote } = require('../../src/modules/shipping/shippingQuoteService');

let seq = 0;

async function product(workspaceId, { status = 'active', variantStatus = 'active', price = 5000, compareAt = null, pageSettings = undefined } = {}) {
  seq += 1;
  const row = await db.Product.create({ workspaceId, name: `P${seq}`, slug: `p-${seq}-${Date.now()}`, productCode: generateProductCode(), status, ...(pageSettings ? { pageSettings } : {}) });
  const variant = await db.ProductVariant.create({ workspaceId, productId: row.id, sku: `S-${seq}-${Date.now()}`, priceAmount: price, compareAtAmount: compareAt, stockOnHand: 9, status: variantStatus, weightGrams: 250 });
  return { row, variant };
}

async function menu(workspaceId, productId, { required = false, minSelect, maxSelect = 2 } = {}) {
  const group = await db.ProductOptionGroup.create({ workspaceId, productId, name: 'Extras', required, ...(minSelect !== undefined ? { minSelect } : {}), maxSelect, active: true, sortOrder: 0 });
  const small = await db.ProductOptionChoice.create({ workspaceId, groupId: group.id, name: 'Small', priceDeltaAmount: 100, active: true, sortOrder: 2 });
  const big = await db.ProductOptionChoice.create({ workspaceId, groupId: group.id, name: 'Big', priceDeltaAmount: 300, active: true, sortOrder: 1 });
  return { group, small, big };
}

async function offer(workspaceId, { row, variant }, { status = 'active', priceAmount = 4000 } = {}) {
  const created = await db.Offer.create({ workspaceId, productId: row.id, name: 'Two', pricingMode: 'fixed', priceAmount, currency: 'EGP', status, shippingOverride: null });
  await db.OfferVariant.create({ offerId: created.id, variantId: variant.id, quantity: 2 });
  return created;
}

async function store() {
  const owner = await registerAndActivate();
  const workspace = await createWorkspace(owner.accessToken, 'Priced Store');
  return workspace.id;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

/** One by one, as before, and all at once. */
async function both(workspaceId, lines) {
  const one = [];
  for (const line of lines) one.push(await priceLine(workspaceId, line));
  const all = await priceLines(workspaceId, lines);
  return { one: plain(one), all: plain(all) };
}

/** The refusal each way answers, as code and name. */
async function refusalOf(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return { name: err.name, code: err.code, status: err.statusCode || err.status, message: err.message };
  }
}

async function countQueries(fn) {
  let n = 0;
  const original = db.sequelize.options.logging;
  db.sequelize.options.logging = () => {
    n += 1;
  };
  try {
    await fn();
  } finally {
    db.sequelize.options.logging = original;
  }
  return n;
}

describe('priceLines', () => {
  it('prices a mixed list exactly as line by line', async () => {
    const id = await store();
    const plainOne = await product(id, { price: 5000 });
    const onSale = await product(id, { price: 3000, compareAt: 4500 });
    const ended = await product(id, { price: 3000, compareAt: 4500, pageSettings: { countdown: { ends_at: '2020-01-01T00:00:00.000Z' } } });
    const withOffer = await product(id, { price: 7000 });
    const anOffer = await offer(id, withOffer);
    const withMenu = await product(id, { price: 1000 });
    const { small, big, group } = await menu(id, withMenu.row.id);

    const { one, all } = await both(id, [
      { variantId: plainOne.variant.id, quantity: 1 },
      { variantId: onSale.variant.id, quantity: 3 },
      { variantId: ended.variant.id, quantity: 1 },
      { variantId: withOffer.variant.id, offerId: anOffer.id, quantity: 2 },
      { variantId: withMenu.variant.id, quantity: 2, options: [{ groupId: group.id, choiceIds: [small.id, big.id] }] },
      // The same variant twice, each with its own answer.
      { variantId: plainOne.variant.id, quantity: 4 },
    ]);
    expect(all).toEqual(one);
    expect(all[4].optionsSnapshot[0].choices.map((c) => c.name)).toEqual(['Big', 'Small']);
    expect(all[3].offerId).toBe(anOffer.id);
  });

  it('refuses in the list\'s order, the same refusal', async () => {
    const id = await store();
    const good = await product(id);
    const draft = await product(id, { status: 'draft' });
    const retired = await product(id, { variantStatus: 'archived' });
    const withOffer = await product(id);
    const pausedOffer = await offer(id, withOffer, { status: 'archived' });
    const otherProduct = await product(id);
    const othersOffer = await offer(id, otherProduct);
    const needsChoice = await product(id);
    await menu(id, needsChoice.row.id, { required: true, minSelect: 1 });
    const foreignStore = await store();
    const foreign = await product(foreignStore);

    const cases = [
      [{ variantId: draft.variant.id, quantity: 1 }],
      [{ variantId: retired.variant.id, quantity: 1 }],
      [{ variantId: foreign.variant.id, quantity: 1 }],
      [{ variantId: '00000000-0000-4000-8000-000000000000', quantity: 1 }],
      [{ variantId: withOffer.variant.id, offerId: pausedOffer.id, quantity: 1 }],
      [{ variantId: good.variant.id, offerId: othersOffer.id, quantity: 1 }],
      [{ variantId: good.variant.id, quantity: 1, options: [{ groupId: '00000000-0000-4000-8000-000000000001', choiceIds: [] }] }],
      [{ variantId: needsChoice.variant.id, quantity: 1, enforceRequiredOptions: true }],
    ];
    for (const lines of cases) {
      const before = await refusalOf(async () => {
        for (const line of lines) await priceLine(id, line);
      });
      const after = await refusalOf(() => priceLines(id, lines));
      expect(before).not.toBeNull();
      expect(after).toEqual(before);
    }
  });

  it('is empty for an empty list, with no read', async () => {
    const id = await store();
    let result;
    const n = await countQueries(async () => {
      result = await priceLines(id, []);
    });
    expect(result).toEqual([]);
    expect(n).toBe(0);
  });

  it('reads per kind, not per line', async () => {
    const id = await store();
    const lines = [];
    for (let i = 0; i < 6; i++) lines.push({ variantId: (await product(id)).variant.id, quantity: 1 });
    const oneByOne = await countQueries(async () => {
      for (const line of lines) await priceLine(id, line);
    });
    const atOnce = await countQueries(() => priceLines(id, lines));
    expect(oneByOne).toBe(12);
    expect(atOnce).toBe(2);
  });
});

describe('the shipping quote', () => {
  it('reads the cart in the same few reads however long it is', async () => {
    const id = await store();
    const items = [];
    for (let i = 0; i < 2; i++) items.push({ variantId: (await product(id)).variant.id, quantity: 1 });
    const short = await countQueries(() => quote(id, { country: 'EG', items }));
    for (let i = 0; i < 4; i++) items.push({ variantId: (await product(id)).variant.id, quantity: 1 });
    let answer;
    const long = await countQueries(async () => {
      answer = await quote(id, { country: 'EG', items });
    });
    expect(long).toBe(short);
    expect(answer.subtotal).toBe(30000);
    expect(answer.currency).toBeTruthy();
  });
});
