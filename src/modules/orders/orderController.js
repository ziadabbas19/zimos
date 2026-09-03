'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./orderService');

const create = asyncHandler(async (req, res) => {
  const { order, items } = await service.createOrder(req.tenant.workspaceId, req.body, req);
  res.status(201).json({ order: { ...order.toJSON(), items } });
});

const get = asyncHandler(async (req, res) => {
  const order = await service.getOrder(req.tenant.workspaceId, req.params.orderId);
  res.json({ order });
});

const list = asyncHandler(async (req, res) => {
  const result = await service.listOrders(req.tenant.workspaceId, req.query);
  res.json(result);
});

const cancel = asyncHandler(async (req, res) => {
  const order = await service.cancelOrder(req.tenant.workspaceId, req.params.orderId, req.body, req);
  res.json({ order });
});

const update = asyncHandler(async (req, res) => {
  const order = await service.updateOrderLimited(req.tenant.workspaceId, req.params.orderId, req.body, req);
  res.json({ order });
});

const listShipments = asyncHandler(async (req, res) => {
  res.json({ shipments: await service.listShipments(req.tenant.workspaceId, req.params.orderId) });
});

const createShipment = asyncHandler(async (req, res) => {
  const shipment = await service.createShipment(req.tenant.workspaceId, req.params.orderId, req.body, req);
  res.status(201).json({ shipment });
});

const updateShipment = asyncHandler(async (req, res) => {
  const shipment = await service.updateShipment(
    req.tenant.workspaceId,
    req.params.orderId,
    req.params.shipmentId,
    req.body,
    req
  );
  res.json({ shipment });
});

module.exports = { create, get, list, cancel, update, listShipments, createShipment, updateShipment };
