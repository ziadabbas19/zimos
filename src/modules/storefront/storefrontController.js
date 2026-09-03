'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./storefrontService');

const getStore = asyncHandler(async (req, res) => res.json({ store: await service.getStorefront(req.tenant.workspaceId) }));
const listProducts = asyncHandler(async (req, res) => res.json(await service.listProducts(req.tenant.workspaceId, req.query)));
const getProduct = asyncHandler(async (req, res) => res.json({ product: await service.getProductBySlugOrId(req.tenant.workspaceId, req.params.idOrSlug) }));
const listCollections = asyncHandler(async (req, res) => res.json({ collections: await service.listCollections(req.tenant.workspaceId) }));
const getCollection = asyncHandler(async (req, res) => res.json({ collection: await service.getCollection(req.tenant.workspaceId, req.params.collectionId) }));

module.exports = { getStore, listProducts, getProduct, listCollections, getCollection };
