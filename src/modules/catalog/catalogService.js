'use strict';

const db = require('../../db/models');
const { scoped } = require('../../core/utils/scopedRepository');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const slugify = require('../../core/utils/slugify');

async function createProduct(workspaceId, data, req) {
  const products = scoped(db.Product, workspaceId);
  const baseSlug = slugify(data.slug || data.name);
  let slug = baseSlug;
  let n = 1;
  while (await products.findOne({ where: { slug } })) {
    slug = `${baseSlug}-${++n}`;
  }

  const product = await products.create({ ...data, slug });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'product.create',
    entityType: 'Product',
    entityId: product.id,
    after: product.toJSON(),
    req,
  });
  return product;
}

async function listProducts(workspaceId, { status, collectionId, limit = 50, cursor } = {}) {
  const where = { workspaceId };
  if (status) where.status = status;
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

async function updateProduct(workspaceId, productId, data, req) {
  const products = scoped(db.Product, workspaceId);
  const product = await products.findByPkOrThrow(productId);
  const before = product.toJSON();
  await product.update(data);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'product.update',
    entityType: 'Product',
    entityId: product.id,
    before,
    after: product.toJSON(),
    req,
  });
  return product;
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
 * Products, variants and offers are archived, never hard-deleted: a real
 * DELETE would cascade away inventory_movements and offer_variants. Past
 * orders are unaffected either way since OrderItem holds its own snapshot.
 */
async function deleteProduct(workspaceId, productId, req) {
  return db.sequelize.transaction(async (t) => {
    const product = await db.Product.findOne({ where: { id: productId, workspaceId }, transaction: t });
    if (!product) throw new NotFoundError('Product');
    const before = product.toJSON();

    await product.update({ status: 'archived' }, { transaction: t });
    await db.ProductVariant.update(
      { status: 'archived' },
      { where: { productId: product.id, workspaceId }, transaction: t }
    );
    await db.Offer.update(
      { status: 'archived' },
      { where: { productId: product.id, workspaceId }, transaction: t }
    );

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

async function deleteVariant(workspaceId, variantId, req) {
  const variant = await scoped(db.ProductVariant, workspaceId, 'ProductVariant').findByPkOrThrow(variantId);
  const before = variant.toJSON();
  await variant.update({ status: 'archived' });
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
  await offer.update({ status: 'archived' });
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
  createProduct,
  listProducts,
  getProduct,
  updateProduct,
  deleteProduct,
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
