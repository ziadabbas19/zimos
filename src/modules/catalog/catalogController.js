'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./catalogService');
const inventoryService = require('../inventory/inventoryService');
const db = require('../../db/models');

const createProduct = asyncHandler(async (req, res) => {
  const product = await service.createProduct(req.tenant.workspaceId, req.body, req);
  res.status(201).json({ product });
});

const listProducts = asyncHandler(async (req, res) => {
  const result = await service.listProducts(req.tenant.workspaceId, req.query);
  res.json(result);
});

const getProduct = asyncHandler(async (req, res) => {
  const product = await service.getProduct(req.tenant.workspaceId, req.params.productId);
  res.json({ product });
});

const updateProduct = asyncHandler(async (req, res) => {
  const product = await service.updateProduct(req.tenant.workspaceId, req.params.productId, req.body, req);
  res.json({ product });
});

const deleteProduct = asyncHandler(async (req, res) => {
  res.json(await service.deleteProduct(req.tenant.workspaceId, req.params.productId, req));
});

const createVariant = asyncHandler(async (req, res) => {
  const variant = await service.createVariant(req.tenant.workspaceId, req.params.productId, req.body, req);

  if (req.body.stockOnHand) {
    await inventoryService.restock({
      workspaceId: req.tenant.workspaceId,
      variantId: variant.id,
      quantity: req.body.stockOnHand,
      reason: 'Initial stock at variant creation',
      actorUserId: req.user.id,
    });
    await variant.reload();
  }

  res.status(201).json({ variant });
});

const getVariant = asyncHandler(async (req, res) => {
  const variant = await service.getVariant(req.tenant.workspaceId, req.params.variantId);
  res.json({ variant });
});

const updateVariant = asyncHandler(async (req, res) => {
  const variant = await service.updateVariant(req.tenant.workspaceId, req.params.variantId, req.body, req);
  res.json({ variant });
});

const deleteVariant = asyncHandler(async (req, res) => {
  res.json(await service.deleteVariant(req.tenant.workspaceId, req.params.variantId, req));
});

const createOffer = asyncHandler(async (req, res) => {
  const offer = await service.createOffer(req.tenant.workspaceId, req.params.productId, req.body, req);
  res.status(201).json({ offer });
});

const listOffers = asyncHandler(async (req, res) => {
  res.json({ offers: await service.listOffers(req.tenant.workspaceId, req.params.productId) });
});

const getOffer = asyncHandler(async (req, res) => {
  res.json({ offer: await service.getOffer(req.tenant.workspaceId, req.params.offerId) });
});

const updateOffer = asyncHandler(async (req, res) => {
  res.json({ offer: await service.updateOffer(req.tenant.workspaceId, req.params.offerId, req.body, req) });
});

const deleteOffer = asyncHandler(async (req, res) => {
  res.json(await service.deleteOffer(req.tenant.workspaceId, req.params.offerId, req));
});

const createCollection = asyncHandler(async (req, res) => {
  const collection = await service.createCollection(req.tenant.workspaceId, req.body, req);
  res.status(201).json({ collection });
});

const listCollections = asyncHandler(async (req, res) => {
  res.json({ collections: await service.listCollections(req.tenant.workspaceId) });
});

const getCollection = asyncHandler(async (req, res) => {
  res.json({ collection: await service.getCollection(req.tenant.workspaceId, req.params.collectionId) });
});

const updateCollection = asyncHandler(async (req, res) => {
  res.json({ collection: await service.updateCollection(req.tenant.workspaceId, req.params.collectionId, req.body, req) });
});

const deleteCollection = asyncHandler(async (req, res) => {
  res.json(await service.deleteCollection(req.tenant.workspaceId, req.params.collectionId, req));
});

const addToCollection = asyncHandler(async (req, res) => {
  const result = await service.addProductToCollection(
    req.tenant.workspaceId,
    req.params.productId,
    req.params.collectionId,
    req
  );
  res.json(result);
});

const removeFromCollection = asyncHandler(async (req, res) => {
  const result = await service.removeProductFromCollection(
    req.tenant.workspaceId,
    req.params.productId,
    req.params.collectionId,
    req
  );
  res.json(result);
});

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
  addToCollection,
  removeFromCollection,
};
