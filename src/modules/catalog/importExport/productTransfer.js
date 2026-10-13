'use strict';

const https = require('https');
const db = require('../../../db/models');
const queue = require('../../../core/queue');
const logger = require('../../../core/utils/logger');
const { AppError, ValidationError, NotFoundError } = require('../../../core/errors/AppError');
const { checkUrl, guardedLookup } = require('../../webhooks/webhookUrlGuard');
const inventoryService = require('../../inventory/inventoryService');
const catalogService = require('../catalogService');
const schemas = require('../catalogValidation');

/*
 * Moving products in and out of a store (SPEC §7.5):
 *
 *   export   one JSON document of every product that is not archived;
 *   import   that same JSON (moving between stores), a CSV/xlsx sheet, or a
 *            Shopify product link.
 *
 * Every source is first turned into the same list of "transfer products"
 * (TRANSFER_VERSION below). The request stores that list on a catalog_imports
 * row and queues an `io` job; the job creates the products one by one — each
 * in its own transaction, through the same service the dashboard uses — and
 * writes which ones failed and why. Money is integer minor units everywhere
 * in the JSON; the sheet is in major units, as a merchant types them.
 */

const TRANSFER_VERSION = 1;
const MAX_PRODUCTS = 2000;
const MAX_VARIANTS = 100;

const SHEET_COLUMNS = [
  'name',
  'description',
  'type',
  'status',
  'tags',
  'images',
  'collections',
  'sku',
  'option1_name',
  'option1_value',
  'option2_name',
  'option2_value',
  'price',
  'compare_at_price',
  'cost',
  'stock',
  'weight_kg',
];

const PRODUCT_FIELDS = [
  'name',
  'slug',
  'description',
  'productType',
  'status',
  'options',
  'media',
  'tags',
  'seo',
  'shippingMode',
  'shippingExtraAmount',
  'customFields',
  'priority',
  'specialOfferText',
  'externalRefs',
  'pageSettings',
  'cms',
];
const VARIANT_FIELDS = [
  'sku',
  'barcode',
  'optionValues',
  'priceAmount',
  'compareAtAmount',
  'costAmount',
  'lowStockThreshold',
  'currency',
  'allowOverselling',
  'weightGrams',
  'dimensions',
  'stockOnHand',
];

const pick = (source, keys) =>
  Object.fromEntries(keys.filter((key) => source[key] !== undefined && source[key] !== null).map((key) => [key, source[key]]));
const num = (value) => (value === null || value === undefined ? null : Number(value));

// ----------------------------------------------------------------- export --

async function exportProducts(workspaceId) {
  const products = await db.Product.findAll({
    where: { workspaceId, status: ['draft', 'active'] },
    include: [
      { model: db.ProductVariant, as: 'variants', where: { status: 'active' }, required: false },
      { model: db.Offer, as: 'offers', where: { status: 'active' }, required: false, include: [{ model: db.OfferVariant, as: 'lines' }] },
      { model: db.Collection, as: 'collections', attributes: ['name'] },
    ],
    order: [
      ['createdAt', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return {
    format: 'zimos.products',
    version: TRANSFER_VERSION,
    exportedAt: new Date().toISOString(),
    products: products.map((product) => {
      const variants = [...product.variants].sort((a, b) => a.createdAt - b.createdAt);
      const indexOf = new Map(variants.map((v, i) => [v.id, i]));
      return {
        ...pick(product.toJSON(), PRODUCT_FIELDS),
        shippingExtraAmount: num(product.shippingExtraAmount),
        collections: product.collections.map((c) => c.name),
        variants: variants.map((v) => ({
          sku: v.sku,
          barcode: v.barcode,
          optionValues: v.optionValues,
          priceAmount: num(v.priceAmount),
          compareAtAmount: num(v.compareAtAmount),
          costAmount: num(v.costAmount),
          currency: v.currency,
          stockOnHand: v.stockOnHand,
          allowOverselling: v.allowOverselling,
          lowStockThreshold: v.lowStockThreshold,
          weightGrams: v.weightGrams,
          dimensions: v.dimensions,
        })),
        offers: product.offers
          .filter((offer) => offer.lines.every((line) => indexOf.has(line.variantId)))
          .map((offer) => ({
            name: offer.name,
            pricingMode: offer.pricingMode,
            priceAmount: num(offer.priceAmount),
            currency: offer.currency,
            badge: offer.badge,
            isDefault: offer.isDefault,
            lines: offer.lines.map((line) => ({ variantIndex: indexOf.get(line.variantId), quantity: line.quantity })),
          })),
      };
    }),
  };
}

function templateCsv() {
  const example = [
    ['Cotton T-Shirt', 'Soft 100% cotton', 'physical', 'draft', 'apparel|summer', 'https://example.com/tshirt.jpg', 'Men', 'TSHIRT-RED-M', 'Color', 'Red', 'Size', 'M', '250', '300', '120', '10', '0.2'],
    ['Cotton T-Shirt', '', '', '', '', '', '', 'TSHIRT-RED-L', 'Color', 'Red', 'Size', 'L', '250', '300', '120', '5', '0.2'],
  ];
  const line = (cells) => cells.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(',');
  // The BOM makes Excel read the Arabic a merchant types into it as UTF-8.
  return `﻿${[SHEET_COLUMNS, ...example].map(line).join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------- sources --

function fromJson(body) {
  const list = Array.isArray(body) ? body : body && body.products;
  if (!Array.isArray(list) || list.length === 0) {
    throw new ValidationError([{ field: 'file', message: 'The file has no products. Use a file exported from ZIMOS.' }]);
  }
  return list.map((product, index) => ({ ...product, __row: index + 1 }));
}

const splitList = (value) =>
  String(value || '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * Major units as typed ("250", "249.99") → minor units; null when blank. An
 * unreadable cell becomes the text "invalid" (NaN would not survive the JSON
 * column), which the variant schema then reports by field name.
 */
function sheetMoney(value) {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 'invalid';
}

/** Sheet rows → transfer products. Consecutive rows with the same name are one product's variants. */
function fromSheet({ header, rows }) {
  if (!header.includes('name') || !header.includes('price')) {
    throw new ValidationError([
      { field: 'file', message: 'The sheet needs at least the columns "name" and "price". Download the template to see them all.' },
    ]);
  }
  const products = [];
  const byName = new Map();
  for (const row of rows) {
    const name = row.name || '';
    let product = name ? byName.get(name.toLowerCase()) : products[products.length - 1];
    if (!product) {
      product = {
        __row: row.__row,
        name,
        description: row.description || '',
        productType: row.type || 'physical',
        status: row.status || 'draft',
        tags: splitList(row.tags),
        media: splitList(row.images).map((url) => ({ url })),
        collections: splitList(row.collections),
        variants: [],
      };
      products.push(product);
      if (name) byName.set(name.toLowerCase(), product);
    }
    const optionValues = {};
    for (const n of [1, 2, 3]) {
      const optionName = row[`option${n}_name`];
      const optionValue = row[`option${n}_value`];
      if (optionName && optionValue) optionValues[optionName] = optionValue;
    }
    const weight = String(row.weight_kg ?? '').trim();
    product.variants.push({
      __row: row.__row,
      sku: row.sku || null,
      optionValues,
      priceAmount: sheetMoney(row.price),
      compareAtAmount: sheetMoney(row.compare_at_price),
      costAmount: sheetMoney(row.cost),
      stockOnHand: row.stock === undefined || row.stock === '' ? 0 : Number.isInteger(Number(row.stock)) ? Number(row.stock) : 'invalid',
      // eslint-disable-next-line no-nested-ternary
      weightGrams: weight === '' ? null : Number.isFinite(Number(weight)) ? Math.round(Number(weight) * 1000) : 'invalid',
    });
  }
  return products;
}

/** GET of a small public JSON document: https only, public addresses only, no redirects. */
function fetchPublicJson(url, { timeoutMs = 10000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { lookup: guardedLookup, timeout: timeoutMs, headers: { accept: 'application/json', 'user-agent': 'ZimosImporter/1.0' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`The store answered ${res.statusCode}`));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) req.destroy(new Error('The answer is too large'));
          else chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(new Error('The store did not answer with product data'));
          }
        });
        res.on('error', reject);
        return undefined;
      }
    );
    req.on('timeout', () => req.destroy(new Error('The store took too long to answer')));
    req.on('error', reject);
  });
}

const stripHtml = (html) =>
  String(html || '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Shopify's public `/products/<handle>.json` → one transfer product, as a draft. */
function mapShopifyProduct(shopify) {
  const options = (shopify.options || []).filter((o) => o && o.name && o.name !== 'Title');
  const images = (shopify.images || []).map((image) => image && image.src).filter(Boolean);
  if (images.length === 0 && shopify.image && shopify.image.src) images.push(shopify.image.src);
  const tags = Array.isArray(shopify.tags) ? shopify.tags : splitList(String(shopify.tags || '').replace(/,/g, '|'));
  return {
    __row: 1,
    name: String(shopify.title || '').slice(0, 300),
    description: stripHtml(shopify.body_html).slice(0, 20000),
    productType: 'physical',
    status: 'draft',
    tags: tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 50),
    media: images.slice(0, 20).map((url) => ({ url })),
    options: options.map((o) => ({ name: o.name, values: o.values || [] })),
    collections: [],
    variants: (shopify.variants || []).slice(0, MAX_VARIANTS).map((variant) => {
      const optionValues = {};
      options.forEach((option, i) => {
        const value = variant[`option${option.position || i + 1}`];
        if (value) optionValues[option.name] = value;
      });
      return {
        // SKUs are unique per store here; the merchant sets them after import.
        sku: null,
        optionValues,
        priceAmount: sheetMoney(variant.price),
        compareAtAmount: sheetMoney(variant.compare_at_price),
        stockOnHand: 0,
        weightGrams: Number.isFinite(Number(variant.grams)) && Number(variant.grams) > 0 ? Math.round(Number(variant.grams)) : null,
      };
    }),
  };
}

/** A Shopify product page link → the address of its public JSON, or a 422 saying what is wrong. */
function shopifyJsonUrl(link) {
  const invalid = (message) => new ValidationError([{ field: 'url', message }]);
  let url;
  try {
    url = new URL(String(link).trim());
  } catch (err) {
    throw invalid('Paste the full product link, like https://store.com/products/my-product');
  }
  if (url.protocol !== 'https:') throw invalid('The link must start with https://');
  if (url.username || url.password) throw invalid('The link must not contain a username or password');
  const match = url.pathname.match(/\/products\/([^/?#]+?)(?:\.json)?\/?$/);
  if (!match) throw invalid('This is not a Shopify product link: it must contain /products/<name>');
  // Checked like any URL this server fetches for a merchant: no private
  // address, no internal hostname.
  return checkUrl(`${url.origin}/products/${match[1]}.json`, 'url', { label: 'product link' });
}

async function fromShopifyLink(link) {
  const jsonUrl = shopifyJsonUrl(link);
  let body;
  try {
    body = await fetchPublicJson(jsonUrl);
  } catch (err) {
    throw new AppError('IMPORT_SOURCE_UNREACHABLE', `Could not read the product from that link: ${err.message}`, 422, [
      { field: 'url', message: err.message },
    ]);
  }
  if (!body || !body.product || !body.product.title) {
    throw new AppError('IMPORT_SOURCE_UNREACHABLE', 'That link did not return a Shopify product', 422, [
      { field: 'url', message: 'Not a Shopify product' },
    ]);
  }
  return [mapShopifyProduct(body.product)];
}

// ----------------------------------------------------------------- import --

async function createImport(workspaceId, { kind, sourceName, products }, userId) {
  if (products.length > MAX_PRODUCTS) {
    throw new ValidationError([{ field: 'file', message: `At most ${MAX_PRODUCTS} products per import` }]);
  }
  const row = await db.sequelize.transaction(async (transaction) => {
    const created = await db.CatalogImport.create(
      { workspaceId, kind, sourceName: sourceName ? String(sourceName).slice(0, 300) : null, payload: products, total: products.length, createdBy: userId },
      { transaction }
    );
    await queue.add('io', 'catalog.import', { importId: created.id }, { transaction, workspaceId, dedupeKey: `catalog-import:${created.id}` });
    return created;
  });
  return publicImport(row);
}

function publicImport(row) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    sourceName: row.sourceName,
    total: row.total,
    createdCount: row.createdCount,
    failedCount: row.failedCount,
    errors: row.errors,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

async function listImports(workspaceId) {
  const rows = await db.CatalogImport.findAll({
    where: { workspaceId },
    attributes: { exclude: ['payload'] },
    order: [['createdAt', 'DESC']],
    limit: 20,
  });
  return rows.map(publicImport);
}

async function getImport(workspaceId, importId) {
  const row = await db.CatalogImport.findOne({ where: { id: importId, workspaceId }, attributes: { exclude: ['payload'] } });
  if (!row) throw new NotFoundError('Import');
  return publicImport(row);
}

/** Runs `schema` on `value`; throws one readable Error naming the fields that are wrong. */
function check(schema, value, what) {
  const { value: clean, error } = schema.validate(value, { abortEarly: false, stripUnknown: true, convert: true });
  if (error) {
    throw new Error(`${what}: ${error.details.map((d) => d.message.replace(/"/g, '')).join('; ')}`);
  }
  return clean;
}

async function ensureCollection(workspaceId, name, req, cache) {
  const key = name.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const existing = await db.Collection.findOne({ where: { workspaceId, name: { [db.Sequelize.Op.iLike]: name } } });
  const collection = existing || (await catalogService.createCollection(workspaceId, { name, seo: {} }, req));
  cache.set(key, collection.id);
  return collection.id;
}

/** Creates one transfer product with its variants, offers and collections. Throws with a readable message. */
async function importOne(workspaceId, source, req, collectionCache) {
  const variants = Array.isArray(source.variants) ? source.variants : [];
  if (variants.length === 0) throw new Error('The product has no variant with a price');
  if (variants.length > MAX_VARIANTS) throw new Error(`A product can have at most ${MAX_VARIANTS} variants`);

  const cleanVariants = variants.map((variant, i) => {
    if (Number.isNaN(variant.priceAmount) || variant.priceAmount === null || variant.priceAmount === undefined) {
      throw new Error(`Variant ${i + 1}: the price is missing or not a number`);
    }
    for (const field of ['compareAtAmount', 'costAmount', 'stockOnHand', 'weightGrams']) {
      if (Number.isNaN(variant[field])) throw new Error(`Variant ${i + 1}: ${field} is not a number`);
    }
    return check(schemas.variant.body, pick(variant, VARIANT_FIELDS), `Variant ${i + 1}`);
  });

  const [first, ...rest] = cleanVariants;
  const body = check(
    schemas.product.body,
    {
      ...pick(source, PRODUCT_FIELDS),
      variant: pick(first, ['priceAmount', 'compareAtAmount', 'sku', 'stockOnHand', 'allowOverselling', 'weightGrams', 'dimensions']),
    },
    'Product'
  );

  let created;
  try {
    created = await catalogService.createProduct(workspaceId, body, req);
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') throw new Error(`SKU "${first.sku}" is already used by another product`);
    throw err;
  }
  const product = created.product;
  // What createProduct's first variant does not take.
  const firstExtras = pick(first, ['barcode', 'optionValues', 'costAmount', 'lowStockThreshold', 'currency']);
  if (Object.keys(firstExtras).length > 0) await created.variant.update(firstExtras);
  const variantIds = [created.variant.id];

  try {
    for (const variant of rest) {
      const row = await catalogService.createVariant(workspaceId, product.id, variant, req);
      if (variant.stockOnHand) {
        await inventoryService.restock({
          workspaceId,
          variantId: row.id,
          quantity: variant.stockOnHand,
          reason: 'Initial stock at import',
          actorUserId: req.user.id,
        });
      }
      variantIds.push(row.id);
    }

    for (const offer of Array.isArray(source.offers) ? source.offers : []) {
      const lines = (offer.lines || []).map((line) => ({ variantId: variantIds[line.variantIndex], quantity: line.quantity }));
      if (lines.length === 0 || lines.some((line) => !line.variantId)) continue;
      const data = check(schemas.offer.body, { ...pick(offer, ['name', 'pricingMode', 'priceAmount', 'currency', 'badge', 'isDefault']), lines }, `Offer "${offer.name}"`);
      await catalogService.createOffer(workspaceId, product.id, data, req);
    }

    for (const name of Array.isArray(source.collections) ? source.collections : []) {
      const trimmed = String(name || '').trim().slice(0, 200);
      if (!trimmed) continue;
      const collectionId = await ensureCollection(workspaceId, trimmed, req, collectionCache);
      await catalogService.addProductToCollection(workspaceId, product.id, collectionId, req);
    }
  } catch (err) {
    // Half a product is worse than none: take it back out and report the row.
    await catalogService.deleteProduct(workspaceId, product.id, req).catch(() => {});
    await catalogService.deleteProductPermanently(workspaceId, product.id, req).catch(() => {});
    if (err.name === 'SequelizeUniqueConstraintError') throw new Error('A SKU in this product is already used by another variant');
    throw err;
  }
  return product;
}

/** The `io` job: creates the products of one import and writes its report. Safe to run twice. */
async function runImport(importId) {
  const [claimed] = await db.CatalogImport.update({ status: 'running' }, { where: { id: importId, status: 'queued' } });
  if (!claimed) return;
  const row = await db.CatalogImport.findByPk(importId);
  const req = { user: { id: row.createdBy }, ip: null, headers: {} };
  const errors = [];
  let createdCount = 0;
  const collectionCache = new Map();
  try {
    for (const source of row.payload) {
      try {
        await importOne(row.workspaceId, source, req, collectionCache);
        createdCount += 1;
      } catch (err) {
        errors.push({
          row: source.__row || null,
          name: String(source.name || '').slice(0, 120),
          message: String(err.message || 'Could not be imported').slice(0, 500),
        });
      }
    }
    await row.update({ status: 'done', createdCount, failedCount: errors.length, errors, payload: [], finishedAt: new Date() });
  } catch (err) {
    logger.error('Catalog import failed', { importId, error: err.message });
    await row.update({
      status: 'failed',
      createdCount,
      failedCount: row.total - createdCount,
      errors: [...errors, { row: null, name: '', message: 'The import stopped unexpectedly. Products created so far were kept.' }],
      payload: [],
      finishedAt: new Date(),
    });
  }
}

module.exports = {
  SHEET_COLUMNS,
  MAX_PRODUCTS,
  exportProducts,
  templateCsv,
  fromJson,
  fromSheet,
  fromShopifyLink,
  mapShopifyProduct,
  shopifyJsonUrl,
  createImport,
  listImports,
  getImport,
  runImport,
};
