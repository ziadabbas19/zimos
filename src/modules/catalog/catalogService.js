'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const { scoped } = require('../../core/utils/scopedRepository');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const slugify = require('../../core/utils/slugify');
const inventoryService = require('../inventory/inventoryService');
const { resolveProductShipping } = require('../shipping/shippingRules');
const { MAX_COLLECTION_DEPTH, findTreeProblem } = require('./collectionTree');
const { bumpProblem } = require('../checkout/orderBump');
const { escapeLike } = require('../storefront/productSearch');

const { Op } = db.Sequelize;

// Server-assigned 9-digit product code — same random-then-retry-on-collision
// idea as the order number / shipment tracking code.
function generateProductCode() {
  return String(crypto.randomInt(0, 1_000_000_000)).padStart(9, '0');
}

/**
 * Creates a product, and — when `data.variant` is given — its first variant
 * and that variant's initial stock, all in one transaction: a failure at any
 * step (e.g. a duplicate SKU) leaves no half-built product behind. Initial
 * stock goes through inventoryService.restock like every other stock change.
 */
/**
 * The product's shipping fields as the row stores them, or a 422 when the
 * mode and the extra fee don't go together (shippingRules.resolveProductShipping).
 */
function productShippingFields(current, data) {
  const { value, error } = resolveProductShipping(current, data);
  if (error) throw new ValidationError([error]);
  return value || {};
}

/**
 * A URL slug for a new product or collection. slugify keeps ASCII word
 * characters only, so an all-Arabic name comes back as "-" (several words) or
 * the generic "workspace" (one word) — which then shows in the store's URLs.
 * Anything with no Latin letter or digit left gets `fallback` instead.
 */
function slugFor(source, fallback) {
  const slugged = slugify(source);
  if (slugged === 'workspace' && !/workspace/i.test(source)) return fallback;
  const trimmed = slugged.replace(/^-+|-+$/g, '');
  return /[a-z0-9]/i.test(trimmed) ? trimmed : fallback;
}

async function createProduct(workspaceId, data, req) {
  const { variant: variantData, shippingMode, shippingExtraAmount, ...rest } = data;
  const productData = { ...rest, ...productShippingFields(null, { shippingMode, shippingExtraAmount }) };
  const products = scoped(db.Product, workspaceId);
  const baseSlug = slugFor(productData.slug || productData.name, 'product');
  let slug = baseSlug;
  let n = 1;
  while (await products.findOne({ where: { slug } })) {
    slug = `${baseSlug}-${++n}`;
  }

  return db.sequelize.transaction(async (t) => {
    let product;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        // Savepoint per attempt: a failed INSERT would otherwise abort the
        // whole transaction and make the retry impossible.
        product = await db.sequelize.transaction({ transaction: t }, (sp) =>
          products.create({ ...productData, slug, productCode: generateProductCode() }, { transaction: sp })
        );
        break;
      } catch (err) {
        const clashOnCode =
          err.name === 'SequelizeUniqueConstraintError' &&
          /product_code/.test(`${err.message} ${JSON.stringify(err.fields || {})} ${(err.parent && err.parent.constraint) || ''}`);
        if (clashOnCode && attempt < 5) continue;
        throw err;
      }
    }

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'product.create',
      entityType: 'Product',
      entityId: product.id,
      after: product.toJSON(),
      req,
      transaction: t,
    });

    if (!variantData) return { product };

    const { stockOnHand, ...variantFields } = variantData;
    const variant = await db.ProductVariant.create(
      {
        ...variantFields,
        workspaceId,
        productId: product.id,
        stockOnHand: 0,
      },
      { transaction: t }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'variant.create',
      entityType: 'ProductVariant',
      entityId: variant.id,
      after: variant.toJSON(),
      req,
      transaction: t,
    });

    if (stockOnHand) {
      await inventoryService.restock(
        {
          workspaceId,
          variantId: variant.id,
          quantity: stockOnHand,
          reason: 'Initial stock at product creation',
          actorUserId: req.user.id,
        },
        t
      );
      await variant.reload({ transaction: t });
    }

    return { product, variant };
  });
}

/** `status` is one value, a comma-separated list, or an array (already validated). */
function statusFilter(status) {
  const list = [...new Set(Array.isArray(status) ? status : String(status).split(','))];
  return list.length === 1 ? list[0] : { [Op.in]: list };
}

/**
 * The staff product list's WHERE and collection join, shared by the list, its
 * count and the bulk delete of every product it matches (catalogBulk.js).
 */
function productListQuery(workspaceId, { status, collectionId, ...filters } = {}) {
  // Name, SKU, type and stock filters live in catalogBulk.listConditions.
  const where = { workspaceId, [Op.and]: require('./catalogBulk').listConditions(filters) };
  if (status) where.status = statusFilter(status);
  const include = [];
  if (collectionId) {
    include.push({ model: db.Collection, as: 'collections', where: { id: collectionId }, attributes: [] });
  }
  return { where, include };
}

async function listProducts(workspaceId, { limit = 50, cursor, ...filters } = {}) {
  const { where, include: collectionJoin } = productListQuery(workspaceId, filters);
  if (cursor) where.id = { [db.Sequelize.Op.gt]: cursor };

  const include = [
    { model: db.ProductVariant, as: 'variants' },
    { model: db.Offer, as: 'offers' },
    ...collectionJoin,
  ];

  const products = await db.Product.findAll({
    where,
    include,
    order: [['id', 'ASC']],
    limit: limit + 1,
  });

  const hasMore = products.length > limit;
  const page = products.slice(0, limit);
  return { products: page, nextCursor: hasMore ? page[page.length - 1].id : null };
}

/**
 * How many products the list shows for these filters, across every page, and
 * when they were counted: the bulk delete of "all of them" takes `asOf` as its
 * cut-off, so a product added after the count is never removed with them.
 */
async function countProducts(workspaceId, filters = {}) {
  const asOf = new Date();
  const { where, include } = productListQuery(workspaceId, filters);
  const count = await db.Product.count({ where, include, distinct: true, col: 'id' });
  return { count, asOf: asOf.toISOString() };
}

async function getProduct(workspaceId, productId) {
  const product = await db.Product.findOne({
    where: { id: productId, workspaceId },
    include: [
      { model: db.ProductVariant, as: 'variants' },
      { model: db.Offer, as: 'offers', include: [{ model: db.OfferVariant, as: 'lines' }] },
      { model: db.Collection, as: 'collections' },
    ],
  });
  if (!product) throw new NotFoundError('Product');
  return product;
}

/**
 * Archive/restore cascades, shared by DELETE (archive), POST /restore and a
 * PATCH that moves `status` into or out of 'archived'. Archiving tags the
 * variants/offers it takes down with archivedWithProduct; restoring revives
 * only those, so a variant the merchant archived on its own stays archived.
 */
async function archiveProductCascade(product, transaction) {
  const where = { productId: product.id, workspaceId: product.workspaceId, status: 'active' };
  const patch = { status: 'archived', archivedWithProduct: true };
  await db.ProductVariant.update(patch, { where, transaction });
  await db.Offer.update(patch, { where, transaction });
}

async function restoreProductCascade(product, transaction) {
  const where = { productId: product.id, workspaceId: product.workspaceId, archivedWithProduct: true };
  const patch = { status: 'active', archivedWithProduct: false };
  await db.ProductVariant.update(patch, { where, transaction });
  await db.Offer.update(patch, { where, transaction });
}

async function updateProduct(workspaceId, productId, data, req) {
  return db.sequelize.transaction(async (t) => {
    const product = await scoped(db.Product, workspaceId).findByPkOrThrow(productId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const before = product.toJSON();
    const { shippingMode, shippingExtraAmount, ...rest } = data;
    await product.update(
      { ...rest, ...productShippingFields(before, { shippingMode, shippingExtraAmount }) },
      { transaction: t }
    );

    let cascade;
    if (before.status !== 'archived' && product.status === 'archived') {
      await archiveProductCascade(product, t);
      cascade = 'archive';
    } else if (before.status === 'archived' && product.status !== 'archived') {
      await restoreProductCascade(product, t);
      cascade = 'restore';
    }

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'product.update',
      entityType: 'Product',
      entityId: product.id,
      before,
      after: product.toJSON(),
      metadata: cascade ? { cascade } : undefined,
      req,
      transaction: t,
    });
    return product;
  });
}

async function createVariant(workspaceId, productId, data, req) {
  const product = await scoped(db.Product, workspaceId).findByPkOrThrow(productId);
  // Initial stock is always applied afterward through inventoryService.restock
  // (see catalogController), so every stock change — including the very
  // first one — goes through the one code path that writes an
  // InventoryMovement audit row. Never set it directly here.
  const { stockOnHand, ...createData } = data;
  const variant = await db.ProductVariant.create({ ...createData, workspaceId, productId: product.id, stockOnHand: 0 });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'variant.create',
    entityType: 'ProductVariant',
    entityId: variant.id,
    after: variant.toJSON(),
    req,
  });
  return variant;
}

async function updateVariant(workspaceId, variantId, data, req) {
  // Price/cost changes are audited explicitly since they're commercially sensitive.
  const variant = await scoped(db.ProductVariant, workspaceId, 'ProductVariant').findByPkOrThrow(variantId);
  const before = variant.toJSON();

  // Stock is never mutated through this endpoint — only inventoryService can
  // change stockOnHand/reservedStock, so silently strip those fields even if
  // a caller mistakenly includes them.
  const { stockOnHand, reservedStock, ...safeData } = data;
  // A status the merchant sets by hand is theirs, not the product cascade's.
  if (safeData.status) safeData.archivedWithProduct = false;
  await variant.update(safeData);

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'variant.update',
    entityType: 'ProductVariant',
    entityId: variant.id,
    before,
    after: variant.toJSON(),
    metadata: before.priceAmount !== variant.priceAmount ? { priceChanged: true } : undefined,
    req,
  });
  return variant;
}

async function getVariant(workspaceId, variantId) {
  const variant = await db.ProductVariant.findOne({ where: { id: variantId, workspaceId } });
  if (!variant) throw new NotFoundError('ProductVariant');
  return variant;
}

/**
 * DELETE archives: products, variants and offers are kept so past orders,
 * inventory history and funnel references stay intact (OrderItem holds its
 * own snapshot either way). A real delete is deleteProductPermanently, and
 * only for a product that has never been ordered.
 *
 * Both run in their own transaction, or — given `transaction` (the bulk
 * delete, catalogBulk.js) — in a savepoint of it, so one refused product
 * does not undo the others.
 */
const inTransaction = (transaction, fn) =>
  transaction ? db.sequelize.transaction({ transaction }, fn) : db.sequelize.transaction(fn);

async function deleteProduct(workspaceId, productId, req, { transaction } = {}) {
  return inTransaction(transaction, async (t) => {
    const product = await db.Product.findOne({
      where: { id: productId, workspaceId },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!product) throw new NotFoundError('Product');
    const before = product.toJSON();

    await product.update({ status: 'archived' }, { transaction: t });
    await archiveProductCascade(product, t);

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'product.delete',
      entityType: 'Product',
      entityId: product.id,
      before,
      after: { status: 'archived' },
      req,
      transaction: t,
    });

    return { archived: true, id: product.id };
  });
}

/**
 * Brings an archived product back as a draft (so the merchant reviews it
 * before it sells again), with the variants/offers its archive took down.
 */
async function restoreProduct(workspaceId, productId, req) {
  await db.sequelize.transaction(async (t) => {
    const product = await db.Product.findOne({
      where: { id: productId, workspaceId },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!product) throw new NotFoundError('Product');
    if (product.status !== 'archived') {
      throw new AppError('PRODUCT_NOT_ARCHIVED', 'Only an archived product can be restored', 409);
    }
    const before = product.toJSON();

    await product.update({ status: 'draft' }, { transaction: t });
    await restoreProductCascade(product, t);

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'product.restore',
      entityType: 'Product',
      entityId: product.id,
      before,
      after: { status: 'draft' },
      req,
      transaction: t,
    });
  });
  return getProduct(workspaceId, productId);
}

/** Funnels whose draft steps or live (published) revision sell one of these offers. */
async function funnelsUsingOffers(workspaceId, offerIds, transaction) {
  const rows = await db.sequelize.query(
    `SELECT fs.funnel_id AS id
       FROM funnel_steps fs
      WHERE fs.workspace_id = :workspaceId AND fs.offer_id IN (:offerIds)
     UNION
     SELECT f.id
       FROM funnels f
       JOIN funnel_revisions r ON r.id = f.published_revision_id
      WHERE f.workspace_id = :workspaceId
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(r.snapshot->'steps', '[]'::jsonb)) AS step
           WHERE step->>'offerId' IN (:offerIds)
        )
      ORDER BY id`,
    { replacements: { workspaceId, offerIds }, type: db.Sequelize.QueryTypes.SELECT, transaction }
  );
  return rows.map((r) => r.id);
}

/**
 * Hard-deletes a product that has never been ordered and isn't sold by any
 * funnel. Rows are removed explicitly, children first: cart_items and
 * offer_variants RESTRICT on the variant, so leaning on the FK cascades would
 * fail (or depend on cascade order).
 *
 * The variant rows are locked before the order check. An order in flight
 * takes the same locks (inventoryService.reserve) until it commits, so it
 * either commits first — and its order_items make this a 409 — or it runs
 * after the delete and no longer finds the variant.
 */
async function deleteProductPermanently(workspaceId, productId, req, { transaction } = {}) {
  return inTransaction(transaction, async (t) => {
    const product = await db.Product.findOne({
      where: { id: productId, workspaceId },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!product) throw new NotFoundError('Product');

    const variants = await db.ProductVariant.findAll({
      where: { productId: product.id, workspaceId },
      attributes: ['id'],
      order: [['id', 'ASC']],
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    const variantIds = variants.map((v) => v.id);

    const ordered =
      (await db.OrderItem.count({ where: { productId: product.id }, transaction: t })) > 0 ||
      (variantIds.length > 0 &&
        (await db.OrderItem.count({ where: { variantId: { [Op.in]: variantIds } }, transaction: t })) > 0);
    if (ordered) {
      throw new AppError('PRODUCT_HAS_ORDERS', 'This product has orders, so it can only be archived', 409);
    }

    const offers = await db.Offer.findAll({
      where: { productId: product.id, workspaceId },
      attributes: ['id'],
      transaction: t,
    });
    const offerIds = offers.map((o) => o.id);

    if (offerIds.length > 0) {
      const funnelIds = await funnelsUsingOffers(workspaceId, offerIds, t);
      if (funnelIds.length > 0) {
        throw new AppError('PRODUCT_IN_FUNNEL', 'This product is sold in a funnel; remove it from the funnel first', 409, [
          { field: 'funnelIds', message: 'Funnels that use an offer of this product', funnelIds },
        ]);
      }
    }

    const before = product.toJSON();
    if (offerIds.length > 0) {
      await db.OfferVariant.destroy({ where: { offerId: { [Op.in]: offerIds } }, transaction: t });
    }
    let cartItemsRemoved = 0;
    if (variantIds.length > 0) {
      // Offers only bundle their own product's variants, but clear any stray line too.
      await db.OfferVariant.destroy({ where: { variantId: { [Op.in]: variantIds } }, transaction: t });
    }
    if (offerIds.length > 0) {
      await db.Offer.destroy({ where: { id: { [Op.in]: offerIds } }, transaction: t });
    }
    if (variantIds.length > 0) {
      // Only open/abandoned carts can still hold them: a converted cart made an order.
      cartItemsRemoved = await db.CartItem.destroy({ where: { variantId: { [Op.in]: variantIds } }, transaction: t });
      await db.InventoryMovement.destroy({ where: { variantId: { [Op.in]: variantIds } }, transaction: t });
      await db.ProductVariant.destroy({ where: { id: { [Op.in]: variantIds } }, transaction: t });
    }
    await db.ProductCollection.destroy({ where: { productId: product.id }, transaction: t });
    await db.TaxRate.destroy({ where: { productId: product.id, workspaceId }, transaction: t });
    await db.Review.destroy({ where: { productId: product.id, workspaceId }, transaction: t });
    await product.destroy({ transaction: t });

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'product.delete_permanent',
      entityType: 'Product',
      entityId: product.id,
      before,
      metadata: { variantIds, offerIds, cartItemsRemoved },
      req,
      transaction: t,
    });

    return { deleted: true, id: product.id };
  });
}

async function deleteVariant(workspaceId, variantId, req) {
  const variant = await scoped(db.ProductVariant, workspaceId, 'ProductVariant').findByPkOrThrow(variantId);
  const before = variant.toJSON();
  await variant.update({ status: 'archived', archivedWithProduct: false });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'variant.delete',
    entityType: 'ProductVariant',
    entityId: variant.id,
    before,
    after: { status: 'archived' },
    req,
  });
  return { archived: true, id: variant.id };
}

async function listOffers(workspaceId, productId) {
  await scoped(db.Product, workspaceId).findByPkOrThrow(productId);
  return db.Offer.findAll({
    where: { workspaceId, productId },
    include: [{ model: db.OfferVariant, as: 'lines' }],
    order: [['createdAt', 'ASC']],
  });
}

/**
 * Active offers of active products across the store, product name then offer
 * name — for pickers such as the order bump's. Each says whether it can be a
 * bump (`bumpProblem`, see checkout/orderBump.js) so the picker can explain
 * the ones it greys out.
 */
async function listWorkspaceOffers(workspaceId, { q, limit = 50 } = {}) {
  const where = { workspaceId, status: 'active' };
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    where[Op.or] = [{ name: { [Op.iLike]: pattern } }, { '$product.name$': { [Op.iLike]: pattern } }];
  }
  // The page first (offer + its product only, so LIMIT counts offers), then
  // the lines of just those offers.
  const offers = await db.Offer.findAll({
    where,
    include: [
      {
        model: db.Product,
        as: 'product',
        where: { workspaceId, status: 'active' },
        attributes: ['id', 'name', 'status', 'media', 'customFields'],
      },
    ],
    order: [
      [{ model: db.Product, as: 'product' }, 'name', 'ASC'],
      ['name', 'ASC'],
      ['id', 'ASC'],
    ],
    limit,
  });
  const lines = offers.length
    ? await db.OfferVariant.findAll({
        where: { offerId: offers.map((o) => o.id) },
        include: [{ model: db.ProductVariant, as: 'variant', attributes: ['id', 'status'] }],
        order: [
          ['createdAt', 'ASC'],
          ['id', 'ASC'],
        ],
      })
    : [];
  return offers.map((offer) => {
    offer.lines = lines.filter((l) => l.offerId === offer.id);
    const media = Array.isArray(offer.product.media) ? offer.product.media : [];
    const image = media.find((m) => m && typeof m.url === 'string' && m.url);
    return {
      id: offer.id,
      name: offer.name,
      priceAmount: offer.priceAmount,
      currency: offer.currency,
      isDefault: offer.isDefault,
      productId: offer.product.id,
      productName: offer.product.name,
      imageUrl: image ? image.url : null,
      lines: offer.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
      bumpProblem: bumpProblem(offer),
    };
  });
}

async function getOffer(workspaceId, offerId) {
  const offer = await db.Offer.findOne({
    where: { id: offerId, workspaceId },
    include: [{ model: db.OfferVariant, as: 'lines' }],
  });
  if (!offer) throw new NotFoundError('Offer');
  return offer;
}

async function updateOffer(workspaceId, offerId, data, req) {
  return db.sequelize.transaction(async (t) => {
    const offer = await db.Offer.findOne({ where: { id: offerId, workspaceId }, transaction: t });
    if (!offer) throw new NotFoundError('Offer');
    const before = offer.toJSON();

    const { lines, ...offerFields } = data;
    // A status the merchant sets by hand is theirs, not the product cascade's.
    if (offerFields.status) offerFields.archivedWithProduct = false;
    await offer.update(offerFields, { transaction: t });

    // Replacing the bundle composition is all-or-nothing: drop the old lines
    // and re-insert, validating each variant still belongs to this product.
    if (lines) {
      await db.OfferVariant.destroy({ where: { offerId: offer.id }, transaction: t });
      for (const line of lines) {
        const variant = await db.ProductVariant.findOne({
          where: { id: line.variantId, workspaceId, productId: offer.productId },
          transaction: t,
        });
        if (!variant) throw new ValidationError([{ field: 'lines.variantId', message: 'Variant does not belong to this product' }]);
        await db.OfferVariant.create({ offerId: offer.id, variantId: line.variantId, quantity: line.quantity }, { transaction: t });
      }
    }

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'offer.update',
      entityType: 'Offer',
      entityId: offer.id,
      before,
      after: { ...offer.toJSON(), ...(lines ? { lines } : {}) },
      req,
      transaction: t,
    });

    return db.Offer.findByPk(offer.id, { include: [{ model: db.OfferVariant, as: 'lines' }], transaction: t });
  });
}

async function deleteOffer(workspaceId, offerId, req) {
  const offer = await scoped(db.Offer, workspaceId, 'Offer').findByPkOrThrow(offerId);
  const before = offer.toJSON();
  await offer.update({ status: 'archived', archivedWithProduct: false });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'offer.delete',
    entityType: 'Offer',
    entityId: offer.id,
    before,
    after: { status: 'archived' },
    req,
  });
  return { archived: true, id: offer.id };
}

// ---------------------------------------------------------------------------
// Collections: a tree of at most MAX_COLLECTION_DEPTH levels, siblings in the
// merchant's order (position, then name), products inside each in theirs.
// ---------------------------------------------------------------------------

const TREE_MESSAGES = {
  COLLECTION_CYCLE: 'A collection cannot be placed inside itself or inside one of its own sub-collections',
  COLLECTION_TOO_DEEP: `Collections can be nested at most ${MAX_COLLECTION_DEPTH} levels deep`,
};

/**
 * Serialises every change to one workspace's tree. Two moves that are each
 * fine on their own (A under B, B under A) must not both land, so every tree
 * write takes this transaction-scoped lock before reading the tree.
 */
async function lockCollectionTree(workspaceId, transaction) {
  await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext($key))', {
    bind: { key: `collections:${workspaceId}` },
    transaction,
  });
}

async function loadParentMap(workspaceId, transaction) {
  const rows = await db.Collection.findAll({ where: { workspaceId }, attributes: ['id', 'parentId'], transaction });
  return new Map(rows.map((row) => [row.id, row.parentId || null]));
}

function assertValidTree(parentOf, field = 'parentId') {
  const problem = findTreeProblem(parentOf);
  if (problem) {
    const message = TREE_MESSAGES[problem.code];
    throw new AppError(problem.code, message, 422, [{ field, message, collectionId: problem.id }]);
  }
}

function assertParentExists(parentOf, parentId, field = 'parentId') {
  if (parentId && !parentOf.has(parentId)) {
    throw new AppError('COLLECTION_PARENT_NOT_FOUND', 'The parent collection does not exist in this store', 422, [
      { field, message: 'Unknown collection' },
    ]);
  }
}

async function nextSiblingPosition(workspaceId, parentId, transaction) {
  const max = await db.Collection.max('position', { where: { workspaceId, parentId: parentId || null }, transaction });
  return Number.isFinite(max) ? max + 1 : 0;
}

/** Siblings in the merchant's order, each with how many products it holds directly. */
async function listCollections(workspaceId) {
  return db.Collection.findAll({
    where: { workspaceId },
    attributes: {
      include: [
        [
          db.sequelize.literal(
            '(SELECT COUNT(*)::int FROM product_collections pc WHERE pc.collection_id = "Collection"."id")'
          ),
          'productCount',
        ],
      ],
    },
    order: [
      ['position', 'ASC'],
      ['name', 'ASC'],
      ['id', 'ASC'],
    ],
  });
}

/** One collection with its products in the collection's own order. */
async function getCollection(workspaceId, collectionId) {
  const collection = await db.Collection.findOne({
    where: { id: collectionId, workspaceId },
    include: [{ model: db.Product, as: 'products', through: { attributes: ['position'] } }],
  });
  if (!collection) throw new NotFoundError('Collection');
  const json = collection.toJSON();
  json.products = (json.products || [])
    .map(({ ProductCollection: link, ...product }) => ({ ...product, collectionPosition: link ? link.position : 0 }))
    .sort((a, b) => a.collectionPosition - b.collectionPosition || String(a.name).localeCompare(String(b.name)));
  return json;
}

async function updateCollection(workspaceId, collectionId, data, req) {
  return db.sequelize.transaction(async (transaction) => {
    const moving = Object.prototype.hasOwnProperty.call(data, 'parentId');
    if (moving) await lockCollectionTree(workspaceId, transaction);
    const collection = await db.Collection.findOne({ where: { id: collectionId, workspaceId }, transaction });
    if (!collection) throw new NotFoundError('Collection');
    const before = collection.toJSON();

    const patch = { ...data };
    if (moving) {
      const parentId = data.parentId || null;
      const parentOf = await loadParentMap(workspaceId, transaction);
      assertParentExists(parentOf, parentId);
      parentOf.set(collection.id, parentId);
      assertValidTree(parentOf);
      patch.parentId = parentId;
      // A move without a position lands at the end of its new siblings.
      if (patch.position === undefined && parentId !== (collection.parentId || null)) {
        patch.position = await nextSiblingPosition(workspaceId, parentId, transaction);
      }
    }
    if (patch.imageUrl === '') patch.imageUrl = null;

    await collection.update(patch, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'collection.update',
      entityType: 'Collection',
      entityId: collection.id,
      before,
      after: collection.toJSON(),
      req,
      transaction,
    });
    return collection;
  });
}

/**
 * Rearranges the tree in one go — what a drag-and-drop screen sends: each
 * listed collection's parent and position. Collections not listed keep
 * theirs. The result is checked as a whole (no cycles, at most three levels)
 * before anything is written.
 */
async function reorderCollections(workspaceId, items, req) {
  return db.sequelize.transaction(async (transaction) => {
    await lockCollectionTree(workspaceId, transaction);
    const rows = await db.Collection.findAll({ where: { workspaceId }, transaction });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const unknown = items.filter((item) => !byId.has(item.id)).map((item) => item.id);
    if (unknown.length > 0) {
      throw new AppError('COLLECTION_NOT_FOUND', 'Some collections do not exist in this store', 422, [
        { field: 'items', message: 'Unknown collection', ids: unknown },
      ]);
    }

    const parentOf = new Map(rows.map((row) => [row.id, row.parentId || null]));
    for (const item of items) {
      if (item.parentId !== undefined) {
        assertParentExists(parentOf, item.parentId || null, 'items.parentId');
        parentOf.set(item.id, item.parentId || null);
      }
    }
    assertValidTree(parentOf, 'items.parentId');

    let changed = 0;
    for (const item of items) {
      const row = byId.get(item.id);
      const patch = {};
      if (item.parentId !== undefined && (item.parentId || null) !== (row.parentId || null)) patch.parentId = item.parentId || null;
      if (item.position !== undefined && item.position !== row.position) patch.position = item.position;
      if (Object.keys(patch).length === 0) continue;
      await row.update(patch, { transaction });
      changed += 1;
    }

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'collection.reorder',
      entityType: 'Collection',
      entityId: null,
      after: { items: items.length, changed },
      req,
      transaction,
    });
    return { changed };
  });
}

/**
 * Sets the order of products inside one collection. `productIds` lists them
 * first to last; any product of the collection left out keeps its relative
 * order after the listed ones. Every listed id must already be in it.
 */
async function reorderCollectionProducts(workspaceId, collectionId, productIds, req) {
  return db.sequelize.transaction(async (transaction) => {
    const collection = await db.Collection.findOne({ where: { id: collectionId, workspaceId }, transaction });
    if (!collection) throw new NotFoundError('Collection');
    const links = await db.ProductCollection.findAll({
      where: { collectionId: collection.id },
      order: [
        ['position', 'ASC'],
        ['createdAt', 'ASC'],
      ],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const byProduct = new Map(links.map((link) => [link.productId, link]));
    const missing = productIds.filter((id) => !byProduct.has(id));
    if (missing.length > 0) {
      throw new AppError('PRODUCT_NOT_IN_COLLECTION', 'Some products are not in this collection', 422, [
        { field: 'productIds', message: 'Not in this collection', ids: missing },
      ]);
    }
    const listed = new Set(productIds);
    const order = [...productIds, ...links.filter((link) => !listed.has(link.productId)).map((link) => link.productId)];
    for (const [index, productId] of order.entries()) {
      const link = byProduct.get(productId);
      if (link.position !== index) await link.update({ position: index }, { transaction });
    }
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'collection.reorder_products',
      entityType: 'Collection',
      entityId: collection.id,
      after: { productIds: order },
      req,
      transaction,
    });
    return { productIds: order };
  });
}

/**
 * The option names this store's active variants use ("Size", "اللون"…), most
 * used first — what the storefront sidebar can offer as filters.
 */
async function listOptionNames(workspaceId) {
  const rows = await db.sequelize.query(
    `SELECT k.key AS name, COUNT(DISTINCT v.product_id)::int AS "productCount"
       FROM product_variants v
       JOIN products p ON p.id = v.product_id AND p.status = 'active'
       CROSS JOIN LATERAL jsonb_object_keys(v.option_values) AS k(key)
      WHERE v.workspace_id = $workspaceId AND v.status = 'active' AND jsonb_typeof(v.option_values) = 'object'
      GROUP BY k.key
      ORDER BY "productCount" DESC, k.key ASC
      LIMIT 50`,
    { bind: { workspaceId }, type: db.Sequelize.QueryTypes.SELECT }
  );
  return rows;
}

// A collection is only a storefront grouping — nothing in order history
// points at it — so this is a real delete; the join rows go with it.
async function deleteCollection(workspaceId, collectionId, req) {
  return db.sequelize.transaction(async (t) => {
    const collection = await db.Collection.findOne({ where: { id: collectionId, workspaceId }, transaction: t });
    if (!collection) throw new NotFoundError('Collection');
    const before = collection.toJSON();

    await db.ProductCollection.destroy({ where: { collectionId: collection.id }, transaction: t });
    await collection.destroy({ transaction: t });

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'collection.delete',
      entityType: 'Collection',
      entityId: collectionId,
      before,
      req,
      transaction: t,
    });

    return { deleted: true, id: collectionId };
  });
}

async function removeProductFromCollection(workspaceId, productId, collectionId, req) {
  const product = await scoped(db.Product, workspaceId).findByPkOrThrow(productId);
  const collection = await scoped(db.Collection, workspaceId, 'Collection').findByPkOrThrow(collectionId);
  await db.ProductCollection.destroy({ where: { productId: product.id, collectionId: collection.id } });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'collection.remove_product',
    entityType: 'Collection',
    entityId: collection.id,
    after: { productId: product.id },
    req,
  });
  return { success: true };
}

async function createOffer(workspaceId, productId, data, req) {
  const product = await scoped(db.Product, workspaceId).findByPkOrThrow(productId);

  return db.sequelize.transaction(async (t) => {
    const offer = await db.Offer.create(
      {
        workspaceId,
        productId: product.id,
        name: data.name,
        pricingMode: data.pricingMode,
        priceAmount: data.priceAmount,
        currency: data.currency,
        badge: data.badge,
        isDefault: data.isDefault,
        shippingOverride: data.shippingOverride,
        countdownMinutes: data.countdownMinutes ?? null,
      },
      { transaction: t }
    );

    for (const line of data.lines) {
      const variant = await db.ProductVariant.findOne({ where: { id: line.variantId, workspaceId, productId: product.id }, transaction: t });
      if (!variant) throw new ValidationError([{ field: 'lines.variantId', message: 'Variant does not belong to this product' }]);
      await db.OfferVariant.create({ offerId: offer.id, variantId: line.variantId, quantity: line.quantity }, { transaction: t });
    }

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'offer.create',
      entityType: 'Offer',
      entityId: offer.id,
      after: { ...offer.toJSON(), lines: data.lines },
      req,
      transaction: t,
    });

    return db.Offer.findByPk(offer.id, { include: [{ model: db.OfferVariant, as: 'lines' }], transaction: t });
  });
}

async function createCollection(workspaceId, data, req) {
  const collections = scoped(db.Collection, workspaceId);
  const baseSlug = slugFor(data.slug || data.name, 'collection');
  let slug = baseSlug;
  let n = 1;
  while (await collections.findOne({ where: { slug } })) {
    slug = `${baseSlug}-${++n}`;
  }
  return db.sequelize.transaction(async (transaction) => {
    const parentId = data.parentId || null;
    if (parentId) {
      await lockCollectionTree(workspaceId, transaction);
      const parentOf = await loadParentMap(workspaceId, transaction);
      assertParentExists(parentOf, parentId);
      // The new collection sits one level below its parent.
      parentOf.set('new', parentId);
      assertValidTree(parentOf);
    }
    const position = data.position !== undefined ? data.position : await nextSiblingPosition(workspaceId, parentId, transaction);
    const collection = await db.Collection.create(
      { ...data, workspaceId, slug, parentId, position, imageUrl: data.imageUrl || null },
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'collection.create',
      entityType: 'Collection',
      entityId: collection.id,
      req,
      transaction,
    });
    return collection;
  });
}

async function addProductToCollection(workspaceId, productId, collectionId, req) {
  const product = await scoped(db.Product, workspaceId).findByPkOrThrow(productId);
  const collection = await scoped(db.Collection, workspaceId, 'Collection').findByPkOrThrow(collectionId);
  // A product joins at the end of the collection's order.
  const last = await db.ProductCollection.max('position', { where: { collectionId: collection.id } });
  const [, created] = await db.ProductCollection.findOrCreate({
    where: { productId: product.id, collectionId: collection.id },
    defaults: { position: Number.isFinite(last) ? last + 1 : 0 },
  });
  if (created) {
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'collection.add_product',
      entityType: 'Collection',
      entityId: collection.id,
      after: { productId: product.id },
      req,
    });
  }
  return { success: true };
}

module.exports = {
  slugFor,
  generateProductCode,
  createProduct,
  productListQuery,
  listProducts,
  countProducts,
  getProduct,
  updateProduct,
  deleteProduct,
  restoreProduct,
  deleteProductPermanently,
  createVariant,
  getVariant,
  updateVariant,
  deleteVariant,
  createOffer,
  listOffers,
  listWorkspaceOffers,
  getOffer,
  updateOffer,
  deleteOffer,
  createCollection,
  listCollections,
  getCollection,
  updateCollection,
  deleteCollection,
  addProductToCollection,
  removeProductFromCollection,
  reorderCollections,
  reorderCollectionProducts,
  listOptionNames,
};
