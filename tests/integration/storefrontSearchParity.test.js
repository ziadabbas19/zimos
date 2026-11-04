'use strict';

// STOREFRONT_SEARCH_FAST_ENABLED changes how the listing and search are read,
// never what they answer: every query here runs with it off and on, against the
// same products, and the two answers must be the same to the last byte.

const { registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { generateProductCode } = require('../../src/modules/catalog/catalogService');
const { searchProducts, suggest } = require('../../src/modules/storefront/productSearch');
const { listProducts } = require('../../src/modules/storefront/storefrontService');

let seq = 0;

async function product(workspaceId, { name, tags = [], description = null, status = 'active', priority = 0, hidden = false, variants = [{}], minutesAgo = 0 }) {
  seq += 1;
  const row = await db.Product.create({
    workspaceId,
    name,
    slug: `p-${seq}-${Date.now()}`,
    productCode: generateProductCode(),
    status,
    tags,
    description,
    priority,
    ...(hidden ? { pageSettings: { hidden: true } } : {}),
    createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - minutesAgo * 60000),
  });
  for (const [i, v] of variants.entries()) {
    await db.ProductVariant.create({
      workspaceId,
      productId: row.id,
      sku: v.sku === undefined ? `PAR-${seq}-${i}` : v.sku,
      priceAmount: v.price ?? 10000 + seq * 100,
      optionValues: v.options || {},
      stockOnHand: 5,
      status: v.status || 'active',
    });
  }
  return row;
}

async function seed() {
  const owner = await registerAndActivate();
  const workspace = await createWorkspace(owner.accessToken, 'Parity Store');
  const other = await createWorkspace(owner.accessToken, 'Other Store');
  const id = workspace.id;
  const shirts = await db.Collection.create({ workspaceId: id, name: 'Shirts', slug: 'shirts', position: 1 });
  const summer = await db.Collection.create({ workspaceId: id, name: 'Summer', slug: 'summer', parentId: shirts.id, position: 2 });

  const rows = [];
  rows.push(await product(id, { name: 'Classic Mug', tags: ['kitchen', 'gift'], minutesAgo: 1 }));
  rows.push(await product(id, { name: 'Mug', tags: ['kitchen'], priority: 5, minutesAgo: 2 }));
  rows.push(await product(id, { name: 'Mugs gift box', tags: ['gift'], minutesAgo: 3, variants: [{ options: { Size: 'L', Color: 'Red' } }, { options: { Size: 'M', Color: 'Blue' }, price: 500 }] }));
  rows.push(await product(id, { name: 'Teapot', description: 'Pairs well with any mug on a cold morning', tags: ['kitchen'], minutesAgo: 4 }));
  rows.push(await product(id, { name: 'ساعة أحمد الذهبية', description: 'ساعه فاخره من الذهب', tags: ['هدايا'], minutesAgo: 5 }));
  rows.push(await product(id, { name: 'مَكتبة خشب', description: 'مكتبة كبيرة للمنزل', minutesAgo: 6 }));
  rows.push(await product(id, { name: 'مستشفى الحيوان', minutesAgo: 7 }));
  rows.push(await product(id, { name: 'سماعة بلوتوث لاسلكية', description: 'صوت نقي', minutesAgo: 8, variants: [{ sku: 'BT-99-X' }] }));
  rows.push(await product(id, { name: 'iPhone 15 Pro', description: 'هاتف ذكي', minutesAgo: 9, variants: [{ sku: 'IP15PRO' }, { sku: 'IP15PRO-MAX' }] }));
  rows.push(await product(id, { name: 'Summer 50%_off pack', minutesAgo: 10 }));
  rows.push(await product(id, { name: 'Summer 500 pack', minutesAgo: 11 }));
  rows.push(await product(id, { name: 'Blue cotton shirt', description: 'A shirt in soft blue cotton', tags: ['blue', 'cotton'], minutesAgo: 12 }));
  rows.push(await product(id, { name: 'Red linen shirt', description: `Long text ${'filler '.repeat(400)} hiddenword past the limit`, tags: ['red'], minutesAgo: 13 }));
  rows.push(await product(id, { name: 'Watch', description: 'blue strap', minutesAgo: 14 }));
  rows.push(await product(id, { name: 'Blue watch', minutesAgo: 15 }));
  rows.push(await product(id, { name: 'Tatweel ـــ name', description: 'ـــ', minutesAgo: 16 }));
  rows.push(await product(id, { name: 'No description or tags', minutesAgo: 17 }));
  // Never in any answer.
  await product(id, { name: 'Draft Mug', status: 'draft', description: 'mug', minutesAgo: 18 });
  await product(id, { name: 'Hidden Mug', hidden: true, description: 'mug', minutesAgo: 19 });
  await product(id, { name: 'Mug with a retired SKU', minutesAgo: 20, variants: [{ sku: 'RETIRED-1', status: 'archived' }, { sku: 'LIVE-1' }] });
  await product(other.id, { name: 'Mug from another store', description: 'mug', variants: [{ sku: 'IP15PRO-OTHER' }] });
  // The same moment, so only the id can decide their order.
  rows.push(await product(id, { name: 'Twin A', minutesAgo: 30 }));
  rows.push(await product(id, { name: 'Twin B', minutesAgo: 30 }));

  await db.ProductCollection.create({ productId: rows[11].id, collectionId: shirts.id, position: 2 });
  await db.ProductCollection.create({ productId: rows[12].id, collectionId: summer.id, position: 1 });
  await db.ProductCollection.create({ productId: rows[0].id, collectionId: shirts.id, position: 3 });
  return { id, shirts };
}

const QUERIES = (shirts) => [
  // The listing, no search.
  { sort: 'newest' },
  { sort: 'newest', page: 2, limit: 5 },
  { sort: 'newest', page: 99, limit: 5 },
  { sort: 'name', limit: 5 },
  { sort: 'price_asc', limit: 7 },
  { sort: 'price_desc', page: 2, limit: 7 },
  { sort: 'newest', facets: true },
  { collection: 'shirts' },
  { collection: 'shirts', sort: 'position', facets: true },
  { collection: shirts.id, sort: 'position' },
  { tag: ['kitchen', 'gift'], sort: 'newest' },
  { minPrice: 11000, maxPrice: 11500, sort: 'newest' },
  { options: { Size: ['M'] }, sort: 'newest' },
  { options: { Size: ['L'], Color: ['Red'] }, facets: true },
  // Search, in every way it can match.
  { search: 'mug' },
  { search: 'MUG', facets: true },
  { search: 'mug', sort: 'newest' },
  { search: 'mug', sort: 'price_asc', limit: 2 },
  { search: 'mug', page: 2, limit: 2 },
  { search: 'mug', page: 9, limit: 2 },
  { search: 'mug', tag: ['gift', 'kitchen'] },
  { search: 'mug', collection: 'shirts' },
  { search: 'ساعه احمد' },
  { search: 'اَحْمَد' },
  { search: 'الذهبيه' },
  { search: 'فاخره' },
  { search: 'مكتبه' },
  { search: 'مستشفي' },
  { search: 'سماعه بلوتوت' },
  { search: 'iphnoe' },
  { search: '50%_off' },
  { search: '%' },
  { search: '_' },
  { search: 'ـــ' },
  { search: 'IP15PRO' },
  { search: 'ip15' },
  { search: 'bt-99' },
  { search: 'RETIRED' },
  { search: 'blue watch' },
  { search: 'watch blue' },
  { search: 'blue strap' },
  { search: 'soft cotton' },
  { search: 'cotton' },
  { search: 'blue', sort: 'name' },
  { search: 'kitchen' },
  { search: 'هدايا' },
  // Past DESCRIPTION_CHARS: not searched, either way.
  { search: 'hiddenword' },
  { search: 'zzzznothing' },
  { search: 'a' },
  { search: 'ab' },
  { search: 'a b c d e f g h' },
  { search: 'mg' },
];

const stable = (value) => JSON.parse(JSON.stringify(value));

async function both(fn) {
  env.storefrontPerf.searchFast = false;
  const off = stable(await fn());
  env.storefrontPerf.searchFast = true;
  const on = stable(await fn());
  env.storefrontPerf.searchFast = false;
  return { off, on };
}

afterEach(() => {
  env.storefrontPerf.searchFast = false;
});

describe('STOREFRONT_SEARCH_FAST_ENABLED', () => {
  it('is off unless the variable says exactly "true"', () => {
    // The suite runs with no such variable: everything else in it is the old queries.
    expect(process.env.STOREFRONT_SEARCH_FAST_ENABLED === undefined || process.env.STOREFRONT_SEARCH_FAST_ENABLED !== 'true').toBe(true);
    expect(env.storefrontPerf.searchFast).toBe(false);
  });

  it('answers every listing and search exactly as the old queries do', async () => {
    const { id, shirts } = await seed();
    let matched = 0;
    for (const query of QUERIES(shirts)) {
      const { off, on } = await both(() => searchProducts(id, { ...query }));
      expect({ query, answer: on }).toEqual({ query, answer: off });
      if (off.products.length > 0) matched += 1;
    }
    // The cases above really exercised something.
    expect(matched).toBeGreaterThan(30);
  });

  it('gives every suggestion exactly as the old query does', async () => {
    const { id } = await seed();
    for (const q of ['mug', 'MUG', 'ساعه', 'iphnoe', 'IP15', '%', 'a', 'blue watch', 'zzzznothing', 'shirts']) {
      const { off, on } = await both(() => suggest(id, q));
      expect({ q, answer: on }).toEqual({ q, answer: off });
    }
  });

  it('leaves the plain cursor list alone', async () => {
    const { id } = await seed();
    const { off, on } = await both(() => listProducts(id, { limit: 5 }));
    expect(on).toEqual(off);
    expect(off.products).toHaveLength(5);
  });

  it('does not count beside the page, off the search path as well', async () => {
    const { id } = await seed();
    const sql = [];
    const original = db.sequelize.options.logging;
    db.sequelize.options.logging = (text) => sql.push(String(text));
    try {
      env.storefrontPerf.searchFast = false;
      await searchProducts(id, { sort: 'newest' });
      expect(sql.some((s) => s.includes('COUNT(*) OVER'))).toBe(true);
      sql.length = 0;
      env.storefrontPerf.searchFast = true;
      await searchProducts(id, { sort: 'newest' });
      expect(sql.some((s) => s.includes('COUNT(*) OVER'))).toBe(false);
      expect(sql.some((s) => s.includes('COUNT(*)::int AS n'))).toBe(true);
    } finally {
      db.sequelize.options.logging = original;
    }
  });
});
