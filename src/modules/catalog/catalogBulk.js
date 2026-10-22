'use strict';

const db = require('../../db/models');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const inventoryService = require('../inventory/inventoryService');

const { Op } = db.Sequelize;

/*
 * Working on many catalog rows at once (SPEC §7.2, §7.5, §7.10):
 *   - the product list's extra filters (name, SKU, type, stock);
 *   - bulk edit of selected products (status, shipping, collection, price);
 *   - bulk delete (archive, or for good) of selected products, or of every
 *     product the list's filters match, a chunk per request;
 *   - the variant table of one product, saved in one request;
 *   - duplicating a product with its variants, offers and collections.
 * Every write is one transaction and one audit row per product touched.
 */

const escapeLike = (value) => String(value).replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Extra WHERE conditions for the staff product list. `q` matches the name,
 * `sku` any of the product's variants, `stock` whether an active variant can
 * still be sold ('in') or none can ('out').
 */
function listConditions({ q, sku, productType, stock } = {}) {
  const and = [];
  if (q) and.push({ name: { [Op.iLike]: `%${escapeLike(q)}%` } });
  if (productType) and.push({ productType });
  if (sku) {
    and.push(
      db.sequelize.literal(
        `EXISTS (SELECT 1 FROM product_variants sv WHERE sv.product_id = "Product"."id" AND sv.sku ILIKE ${db.sequelize.escape(
          `%${escapeLike(sku)}%`
        )})`
      )
    );
  }
  if (stock) {
    const sellable =
      'EXISTS (SELECT 1 FROM product_variants iv WHERE iv.product_id = "Product"."id" AND iv.status = \'active\' AND (iv.allow_overselling OR iv.stock_on_hand - iv.reserved_stock > 0))';
    and.push(db.sequelize.literal(stock === 'in' ? sellable : `NOT ${sellable}`));
  }
  return and;
}

/** The new price for `mode` ('set' | 'increase_percent' | 'decrease_percent'), never below 0. */
function applyPrice(current, { mode, value }) {
  const now = Number(current);
  if (mode === 'set') return value;
  const factor = mode === 'increase_percent' ? 1 + value / 100 : 1 - value / 100;
  return Math.max(0, Math.round(now * factor));
}

/**
 * Applies `changes` to every listed product. A product id that is not in this
 * store fails the whole request, so the merchant never gets a half-applied
 * edit they cannot see.
 */
async function bulkEditProducts(workspaceId, { productIds, changes }, req) {
  return db.sequelize.transaction(async (t) => {
    const products = await db.Product.findAll({
      where: { id: productIds, workspaceId },
      order: [['id', 'ASC']],
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (products.length !== productIds.length) {
      const found = new Set(products.map((p) => p.id));
      throw new AppError('PRODUCT_NOT_FOUND', 'Some products do not exist in this store', 422, [
        { field: 'productIds', message: 'Unknown product', ids: productIds.filter((id) => !found.has(id)) },
      ]);
    }

    let collection = null;
    if (changes.collection) {
      collection = await db.Collection.findOne({ where: { id: changes.collection.id, workspaceId }, transaction: t });
      if (!collection) throw new NotFoundError('Collection');
    }

    let variantsRepriced = 0;
    for (const product of products) {
      const before = product.toJSON();
      const patch = {};
      if (changes.status && changes.status !== product.status) patch.status = changes.status;
      if (changes.shippingMode && changes.shippingMode !== product.shippingMode) {
        patch.shippingMode = changes.shippingMode;
        patch.shippingExtraAmount = null;
      }
      if (Object.keys(patch).length > 0) {
        await product.update(patch, { transaction: t });
        // The same cascade as a single product's archive/restore.
        const where = { productId: product.id, workspaceId };
        if (before.status !== 'archived' && product.status === 'archived') {
          const off = { status: 'archived', archivedWithProduct: true };
          await db.ProductVariant.update(off, { where: { ...where, status: 'active' }, transaction: t });
          await db.Offer.update(off, { where: { ...where, status: 'active' }, transaction: t });
        } else if (before.status === 'archived' && product.status !== 'archived') {
          const on = { status: 'active', archivedWithProduct: false };
          await db.ProductVariant.update(on, { where: { ...where, archivedWithProduct: true }, transaction: t });
          await db.Offer.update(on, { where: { ...where, archivedWithProduct: true }, transaction: t });
        }
      }

      if (collection) {
        if (changes.collection.action === 'remove') {
          await db.ProductCollection.destroy({ where: { productId: product.id, collectionId: collection.id }, transaction: t });
        } else {
          const last = await db.ProductCollection.max('position', { where: { collectionId: collection.id }, transaction: t });
          await db.ProductCollection.findOrCreate({
            where: { productId: product.id, collectionId: collection.id },
            defaults: { position: Number.isFinite(last) ? last + 1 : 0 },
            transaction: t,
          });
        }
      }

      const prices = [];
      if (changes.price) {
        const variants = await db.ProductVariant.findAll({
          where: { productId: product.id, workspaceId, status: 'active' },
          order: [['id', 'ASC']],
          lock: t.LOCK.UPDATE,
          transaction: t,
        });
        for (const variant of variants) {
          const next = applyPrice(variant.priceAmount, changes.price);
          if (Number(variant.priceAmount) === next) continue;
          prices.push({ variantId: variant.id, from: Number(variant.priceAmount), to: next });
          await variant.update({ priceAmount: next }, { transaction: t });
        }
        variantsRepriced += prices.length;
      }

      await recordAudit({
        workspaceId,
        actorUserId: req.user.id,
        action: 'product.bulk_update',
        entityType: 'Product',
        entityId: product.id,
        before,
        after: product.toJSON(),
        metadata: {
          ...(collection ? { collection: { id: collection.id, action: changes.collection.action } } : {}),
          ...(prices.length > 0 ? { prices, priceChanged: true } : {}),
        },
        req,
        transaction: t,
      });
    }

    return { updated: products.length, variantsRepriced };
  });
}

/** Products one bulk-delete request handles; the dashboard sends the next chunk after it. */
const BULK_DELETE_CHUNK = 100;

// The single delete's refusals, as the bulk delete reports them per product.
const SKIP_REASONS = {
  PRODUCT_HAS_ORDERS: 'has_orders',
  PRODUCT_IN_FUNNEL: 'in_funnel',
  NOT_FOUND: 'not_found',
};

/**
 * Archives (`mode: 'archive'`) or deletes for good (`'permanent'`) one chunk
 * of products: the `productIds` given, or the next ones the product list's
 * `filter` matches after `cursor`, among those that existed at
 * `filter.createdBefore` (the count's `asOf`), so a product added since the
 * merchant chose "all" is never taken with them.
 *
 * Each product goes through the single delete (catalogService) in a savepoint
 * of this request's one transaction: a product it refuses — it has orders, a
 * funnel sells it, it is gone already — is skipped with the reason and the
 * others go on. Any other error undoes the whole chunk.
 *
 * Returns `deleted` (archived, or removed for good), `skipped` [{ id, name,
 * reason, funnelIds? }] and the `nextCursor` to send for the next chunk.
 */
async function bulkDeleteProducts(workspaceId, { mode, productIds, filter, cursor }, req) {
  // eslint-disable-next-line global-require
  const catalogService = require('./catalogService');
  const attributes = ['id', 'name', 'status'];
  const skipped = [];
  let products;
  let nextCursor = null;

  if (productIds) {
    products = await db.Product.findAll({ where: { id: productIds, workspaceId }, attributes, order: [['id', 'ASC']] });
    const found = new Set(products.map((p) => p.id));
    for (const id of productIds) if (!found.has(id)) skipped.push({ id, name: null, reason: 'not_found' });
  } else {
    const { createdBefore, ...listFilters } = filter;
    const { where, include } = catalogService.productListQuery(workspaceId, listFilters);
    where.createdAt = { [Op.lte]: createdBefore };
    if (cursor) where.id = { [Op.gt]: cursor };
    const rows = await db.Product.findAll({ where, include, attributes, order: [['id', 'ASC']], limit: BULK_DELETE_CHUNK + 1 });
    products = rows.slice(0, BULK_DELETE_CHUNK);
    if (rows.length > BULK_DELETE_CHUNK) nextCursor = products[products.length - 1].id;
  }

  let deleted = 0;
  if (products.length > 0) {
    await db.sequelize.transaction(async (t) => {
      for (const product of products) {
        if (mode === 'archive' && product.status === 'archived') {
          skipped.push({ id: product.id, name: product.name, reason: 'already_archived' });
          continue;
        }
        try {
          if (mode === 'archive') await catalogService.deleteProduct(workspaceId, product.id, req, { transaction: t });
          else await catalogService.deleteProductPermanently(workspaceId, product.id, req, { transaction: t });
          deleted += 1;
        } catch (err) {
          const reason = SKIP_REASONS[err.code];
          if (!reason) throw err;
          const funnelIds = reason === 'in_funnel' && Array.isArray(err.details) && err.details[0] ? err.details[0].funnelIds : undefined;
          skipped.push({ id: product.id, name: product.name, reason, ...(funnelIds ? { funnelIds } : {}) });
        }
      }

      const reasons = {};
      for (const item of skipped) reasons[item.reason] = (reasons[item.reason] || 0) + 1;
      await recordAudit({
        workspaceId,
        actorUserId: req.user.id,
        action: 'product.bulk_delete',
        entityType: 'Product',
        metadata: { mode, deleted, skipped: skipped.length, reasons, ...(productIds ? { by: 'ids' } : { by: 'filter', filter, cursor: cursor || null }) },
        req,
        transaction: t,
      });
    });
  }

  return { mode, deleted, skipped, nextCursor };
}

const VARIANT_FIELDS = ['sku', 'barcode', 'priceAmount', 'compareAtAmount', 'costAmount', 'allowOverselling', 'status', 'imageUrl'];

/**
 * Saves the variant table of one product. Each row names a variant of this
 * product and the fields to change; `stockOnHand` is the count the merchant
 * typed and becomes an inventory adjustment, like every other stock change.
 */
async function bulkUpdateVariants(workspaceId, productId, rows, req) {
  try {
    return await db.sequelize.transaction(async (t) => {
      const product = await db.Product.findOne({ where: { id: productId, workspaceId }, transaction: t });
      if (!product) throw new NotFoundError('Product');

      const updated = [];
      // Ordered by id so two saves of the same table cannot deadlock.
      for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
        const variant = await inventoryService.lockVariant(row.id, workspaceId, t).catch(() => null);
        if (!variant || variant.productId !== product.id) {
          throw new ValidationError([{ field: 'variants.id', message: 'Variant does not belong to this product', id: row.id }]);
        }
        const before = variant.toJSON();

        const patch = {};
        for (const field of VARIANT_FIELDS) {
          if (row[field] !== undefined) patch[field] = row[field] === '' ? null : row[field];
        }
        if (patch.status) patch.archivedWithProduct = false;

        if (row.stockOnHand !== undefined && row.stockOnHand !== variant.stockOnHand) {
          const delta = row.stockOnHand - variant.stockOnHand;
          patch.stockOnHand = row.stockOnHand;
          patch.version = variant.version + 1;
          await db.InventoryMovement.create(
            {
              workspaceId,
              variantId: variant.id,
              type: 'adjustment',
              quantityDelta: delta,
              reason: 'Variant table edit',
              actorUserId: req.user.id,
            },
            { transaction: t }
          );
        }
        if (Object.keys(patch).length === 0) continue;

        await variant.update(patch, { transaction: t });
        await recordAudit({
          workspaceId,
          actorUserId: req.user.id,
          action: 'variant.update',
          entityType: 'ProductVariant',
          entityId: variant.id,
          before,
          after: variant.toJSON(),
          metadata: {
            bulk: true,
            ...(Number(before.priceAmount) !== Number(variant.priceAmount) ? { priceChanged: true } : {}),
          },
          req,
          transaction: t,
        });
        updated.push(variant);
      }
      return { updated: updated.length, variants: updated };
    });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      throw new AppError('DUPLICATE_RESOURCE', 'That SKU is already used by another variant', 409, [
        { field: 'variants.sku', message: 'SKU already in use' },
      ]);
    }
    throw err;
  }
}

/**
 * A copy of a product as a new draft: its fields, variants (no stock, no SKU —
 * a SKU names one variant in the store), offers with their lines, and the
 * collections it is in. Reviews, orders and inventory history stay with the
 * original.
 */
async function duplicateProduct(workspaceId, productId, req, { slugFor, generateProductCode, name } = {}) {
  const source = await db.Product.findOne({
    where: { id: productId, workspaceId },
    include: [
      { model: db.ProductVariant, as: 'variants' },
      { model: db.Offer, as: 'offers', include: [{ model: db.OfferVariant, as: 'lines' }] },
      { model: db.Collection, as: 'collections' },
    ],
  });
  if (!source) throw new NotFoundError('Product');

  const copyName = (name || `${source.name} (copy)`).slice(0, 300);
  const baseSlug = slugFor(`${source.slug}-copy`, 'product');
  let slug = baseSlug;
  let n = 1;
  while (await db.Product.findOne({ where: { workspaceId, slug }, attributes: ['id'] })) slug = `${baseSlug}-${++n}`;

  return db.sequelize.transaction(async (t) => {
    const { id, createdAt, updatedAt, productCode, variants, offers, collections, ...fields } = source.toJSON();
    let product;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        product = await db.sequelize.transaction({ transaction: t }, (sp) =>
          db.Product.create(
            { ...fields, name: copyName, slug, status: 'draft', productCode: generateProductCode() },
            { transaction: sp }
          )
        );
        break;
      } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError' && attempt < 5) continue;
        throw err;
      }
    }

    const variantMap = new Map();
    for (const variant of source.variants) {
      if (variant.status !== 'active') continue;
      const { id: oldId, createdAt: c, updatedAt: u, productId: p, sku, stockOnHand, reservedStock, version, ...rest } = variant.toJSON();
      const created = await db.ProductVariant.create(
        { ...rest, workspaceId, productId: product.id, sku: null, stockOnHand: 0, reservedStock: 0 },
        { transaction: t }
      );
      variantMap.set(oldId, created.id);
    }

    for (const offer of source.offers) {
      if (offer.status !== 'active') continue;
      const lines = offer.lines.filter((l) => variantMap.has(l.variantId));
      if (lines.length !== offer.lines.length) continue;
      const { id: oldId, createdAt: c, updatedAt: u, productId: p, lines: l, ...rest } = offer.toJSON();
      const created = await db.Offer.create({ ...rest, workspaceId, productId: product.id }, { transaction: t });
      for (const line of lines) {
        await db.OfferVariant.create(
          { offerId: created.id, variantId: variantMap.get(line.variantId), quantity: line.quantity },
          { transaction: t }
        );
      }
    }

    for (const collection of source.collections) {
      const last = await db.ProductCollection.max('position', { where: { collectionId: collection.id }, transaction: t });
      await db.ProductCollection.create(
        { productId: product.id, collectionId: collection.id, position: Number.isFinite(last) ? last + 1 : 0 },
        { transaction: t }
      );
    }

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'product.duplicate',
      entityType: 'Product',
      entityId: product.id,
      after: product.toJSON(),
      metadata: { sourceProductId: source.id, variants: variantMap.size },
      req,
      transaction: t,
    });
    return product;
  });
}

module.exports = {
  listConditions,
  applyPrice,
  bulkEditProducts,
  BULK_DELETE_CHUNK,
  bulkDeleteProducts,
  bulkUpdateVariants,
  duplicateProduct,
};
