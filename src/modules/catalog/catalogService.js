'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const { scoped } = require('../../core/utils/scopedRepository');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const slugify = require('../../core/utils/slugify');
const inventoryService = require('../inventory/inventoryService');

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
async function createProduct(workspaceId, data, req) {
  const { variant: variantData, ...productData } = data;
  const products = scoped(db.Product, workspaceId);
  const baseSlug = slugify(productData.slug || productData.name);
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
      { ...variantFields, workspaceId, productId: product.id, stockOnHand: 0 },
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

async function listProducts(workspaceId, { status, collectionId, limit = 50, cursor } = {}) {
  const where = { workspaceId };
  if (status) where.status = statusFilter(status);
  if (cursor) where.id = { [db.Sequelize.Op.gt]: cursor };

  const include = [
    { model: db.ProductVariant, as: 'variants' },
    { model: db.Offer, as: 'offers' },
  ];
  if (collectionId) {
    include.push({ model: db.Collection, as: 'collections', where: { id: collectionId }, attributes: [] });
  }

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
    await product.update(data, { transaction: t });

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
 */
async function deleteProduct(workspaceId, productId, req) {
  return db.sequelize.transaction(async (t) => {
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
async function deleteProductPermanently(workspaceId, productId, req) {
  return db.sequelize.transaction(async (t) => {
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

async function listCollections(workspaceId) {
  return db.Collection.findAll({ where: { workspaceId }, order: [['createdAt', 'ASC']] });
}

async function getCollection(workspaceId, collectionId) {
  const collection = await db.Collection.findOne({
    where: { id: collectionId, workspaceId },
    include: [{ model: db.Product, as: 'products', through: { attributes: [] } }],
  });
  if (!collection) throw new NotFoundError('Collection');
  return collection;
}

async function updateCollection(workspaceId, collectionId, data, req) {
  const collection = await scoped(db.Collection, workspaceId, 'Collection').findByPkOrThrow(collectionId);
  const before = collection.toJSON();
  await collection.update(data);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'collection.update',
    entityType: 'Collection',
    entityId: collection.id,
    before,
    after: collection.toJSON(),
    req,
  });
  return collection;
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
  const baseSlug = slugify(data.slug || data.name);
  let slug = baseSlug;
  let n = 1;
  while (await collections.findOne({ where: { slug } })) {
    slug = `${baseSlug}-${++n}`;
  }
  const collection = await collections.create({ ...data, slug });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'collection.create', entityType: 'Collection', entityId: collection.id, req });
  return collection;
}

async function addProductToCollection(workspaceId, productId, collectionId, req) {
  const product = await scoped(db.Product, workspaceId).findByPkOrThrow(productId);
  const collection = await scoped(db.Collection, workspaceId, 'Collection').findByPkOrThrow(collectionId);
  const [, created] = await db.ProductCollection.findOrCreate({ where: { productId: product.id, collectionId: collection.id } });
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
  generateProductCode,
  createProduct,
  listProducts,
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
};
