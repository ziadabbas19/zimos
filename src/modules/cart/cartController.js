'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./cartService');
const { AppError } = require('../../core/errors/AppError');

/**
 * Cart identity travels via the X-Cart-Token header end to end (never a
 * body field or query param that could be forged more easily), and is
 * always looked up scoped to req.tenant.workspaceId — a guest token from
 * workspace A resolves to nothing in workspace B.
 */
function readToken(req) {
  return req.headers['x-cart-token'];
}

const getOrCreate = asyncHandler(async (req, res) => {
  const cart = await service.getOrCreateCart(req.tenant.workspaceId, readToken(req));
  const full = await service.getCart(req.tenant.workspaceId, cart.id);
  res.status(201).json(full);
});

const getCurrent = asyncHandler(async (req, res) => {
  const token = readToken(req);
  if (!token) throw new AppError('CART_TOKEN_REQUIRED', 'X-Cart-Token header is required', 400);
  const cart = await service.getOrCreateCart(req.tenant.workspaceId, token);
  res.json(await service.getCart(req.tenant.workspaceId, cart.id));
});

const addItem = asyncHandler(async (req, res) => {
  const token = readToken(req);
  if (!token) throw new AppError('CART_TOKEN_REQUIRED', 'X-Cart-Token header is required', 400);
  const cart = await service.getOrCreateCart(req.tenant.workspaceId, token);
  res.status(201).json(await service.addItem(req.tenant.workspaceId, cart.id, req.body));
});

const updateItem = asyncHandler(async (req, res) => {
  const token = readToken(req);
  if (!token) throw new AppError('CART_TOKEN_REQUIRED', 'X-Cart-Token header is required', 400);
  const cart = await service.getOrCreateCart(req.tenant.workspaceId, token);
  res.json(await service.updateItemQuantity(req.tenant.workspaceId, cart.id, req.params.itemId, req.body.quantity));
});

const removeItem = asyncHandler(async (req, res) => {
  const token = readToken(req);
  if (!token) throw new AppError('CART_TOKEN_REQUIRED', 'X-Cart-Token header is required', 400);
  const cart = await service.getOrCreateCart(req.tenant.workspaceId, token);
  res.json(await service.removeItem(req.tenant.workspaceId, cart.id, req.params.itemId));
});

module.exports = { getOrCreate, getCurrent, addItem, updateItem, removeItem };
