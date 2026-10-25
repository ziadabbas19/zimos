'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./customerService');
const orderLock = require('../orders/orderLock');

const { forViewer } = require('../../core/utils/phoneMask');

// A customer whose every order is locked comes hidden (orders/orderLock), and
// is not edited: the merchant would be writing over details they cannot see.
const present = async (req, customers) => orderLock.presentCustomers(req.tenant.workspaceId, customers);
const presentOne = async (req, customer) => (await present(req, [customer]))[0];
const assertVisible = (req) => orderLock.assertCustomerVisible(req.tenant.workspaceId, req.params.customerId);

// Phones in the list are masked for roles without customers.reveal_sensitive.
const list = asyncHandler(async (req, res) => {
  const result = await service.listCustomers(req.tenant.workspaceId, req.query);
  res.json(forViewer(req, { ...result, customers: await present(req, result.customers) }));
});
const get = asyncHandler(async (req, res) => {
  const canRevealSensitive = req.tenant.hasPermission('customers.reveal_sensitive');
  const customer = canRevealSensitive
    ? await service.revealSensitive(req.tenant.workspaceId, req.params.customerId, req)
    : await service.getCustomer(req.tenant.workspaceId, req.params.customerId);
  res.json({ customer: await presentOne(req, customer) });
});
const update = asyncHandler(async (req, res) => {
  await assertVisible(req);
  res.json({ customer: await service.updateCustomer(req.tenant.workspaceId, req.params.customerId, req.body, req) });
});
// Blocking writes the phone into the store's blacklist (fraud/blockedEntries), where it would show.
const blacklist = asyncHandler(async (req, res) => {
  await assertVisible(req);
  res.json({ customer: await presentOne(req, await service.setBlacklist(req.tenant.workspaceId, req.params.customerId, req.body, req)) });
});
const addAddress = asyncHandler(async (req, res) => {
  await assertVisible(req);
  res.status(201).json({ address: await service.addAddress(req.tenant.workspaceId, req.params.customerId, req.body, req) });
});
const updateAddress = asyncHandler(async (req, res) => {
  await assertVisible(req);
  res.json({ address: await service.updateAddress(req.tenant.workspaceId, req.params.customerId, req.params.addressId, req.body, req) });
});

module.exports = { list, get, update, blacklist, addAddress, updateAddress };
