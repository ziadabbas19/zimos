'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const auth = require('./shopperAuth');
const { clientIp } = require('../../core/middleware/clientIp');
const { requireStoreFeature } = require('../../core/middleware/storeFeatures');

/*
 * Shopper accounts: sign in with a code
 * (shopperAuth.js), see your orders, keep addresses, order again.
 *
 * On only with STORE_FEATURES shopper_accounts, and then the store setting:
 * workspace.settings.shopper_accounts = { enabled, channels: ['sms','email'] }
 * (off by default). The token goes in X-Shopper-Token. A saved address may
 * name one of the store's delivery zones (deliveryZoneId).
 * Everything a shopper reads is their own: every query is by the token's
 * customer and the store.
 */

const MAX_ADDRESSES = 10;
const PAGE = 20;
const CHANNELS = ['sms', 'email'];

function settingsOf(workspace) {
  const s = (workspace.settings && workspace.settings.shopper_accounts) || {};
  return { enabled: Boolean(s.enabled), channels: Array.isArray(s.channels) && s.channels.length ? s.channels.filter((c) => CHANNELS.includes(c)) : ['sms'] };
}

// ---------------------------------------------------------------- shopper --

const profile = (c) => ({
  id: c.id,
  fullName: c.fullName || null,
  phone: c.phoneRaw || (c.phoneNormalized ? `+${c.phoneNormalized}` : null),
  email: c.email || null,
  // Only a verified email signs in by email.
  emailVerified: Boolean(c.email && c.emailVerifiedAt),
  marketingConsent: Boolean(c.marketingConsent),
  ordersCount: c.totalOrders || 0,
});

async function me(customer) {
  return { customer: profile(customer), addresses: customer.savedAddresses || [] };
}

async function updateMe(customer, body) {
  const changes = {};
  if (body.fullName !== undefined) changes.fullName = body.fullName || null;
  if (body.email !== undefined) {
    changes.email = body.email ? body.email.toLowerCase() : null;
    // A typed email isn't verified; the same one keeps its verification.
    if (changes.email !== (customer.email || null)) changes.emailVerifiedAt = null;
  }
  if (body.marketingConsent !== undefined) changes.marketingConsent = body.marketingConsent;
  await customer.update(changes);
  // Turned on here: an earlier unsubscribe of the address is lifted too (emailCampaigns/consent.js; nothing while off).
  if (body.marketingConsent === true) await require('../emailCampaigns/consent').recordAccountConsent(customer);
  return me(customer);
}

async function saveAddresses(customer, list) {
  // At most one default; the first is the default when none is.
  if (list.length && !list.some((a) => a.isDefault)) list[0].isDefault = true;
  customer.savedAddresses = list;
  customer.changed('savedAddresses', true);
  await customer.save({ fields: ['savedAddresses'] });
  return { addresses: list };
}

/** A zone named on an address must be one of this store's active delivery zones. */
async function assertZone(customer, body) {
  if (!body.deliveryZoneId) return;
  if (!(await db.DeliveryZone.count({ where: { id: body.deliveryZoneId, workspaceId: customer.workspaceId, active: true } }))) {
    throw new AppError('VALIDATION_ERROR', 'Pick one of the store\'s delivery areas', 422, [{ field: 'deliveryZoneId', message: 'Unknown delivery area' }]);
  }
}

async function addAddress(customer, body) {
  await assertZone(customer, body);
  const list = [...(customer.savedAddresses || [])];
  if (list.length >= MAX_ADDRESSES) throw new AppError('TOO_MANY_ADDRESSES', `You can keep up to ${MAX_ADDRESSES} addresses`, 422);
  const address = { id: crypto.randomUUID(), ...body, isDefault: Boolean(body.isDefault) };
  if (address.isDefault) list.forEach((a) => (a.isDefault = false));
  list.push(address);
  return saveAddresses(customer, list);
}

async function updateAddress(customer, id, body) {
  await assertZone(customer, body);
  const list = [...(customer.savedAddresses || [])];
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) throw new NotFoundError('Address');
  if (body.isDefault) list.forEach((a) => (a.isDefault = false));
  list[i] = { ...list[i], ...body, id };
  return saveAddresses(customer, list);
}

async function removeAddress(customer, id) {
  const list = (customer.savedAddresses || []).filter((a) => a.id !== id);
  if (list.length === (customer.savedAddresses || []).length) throw new NotFoundError('Address');
  return saveAddresses(customer, list);
}

const ownOrders = (customer) => ({ workspaceId: customer.workspaceId, customerId: customer.id, isTest: false, archivedAt: null });

async function listOrders(customer, { before }) {
  const { trackingStage } = require('../storefront/storefrontService');
  const rows = await db.Order.findAll({
    where: { ...ownOrders(customer), ...(before ? { createdAt: { [Op.lt]: new Date(before) } } : {}) },
    include: [
      { model: db.OrderItem, as: 'items', attributes: ['productNameSnapshot', 'quantity', 'variantId'] },
      { model: db.Shipment, as: 'shipments', attributes: ['status'] },
    ],
    order: [['createdAt', 'DESC']],
    limit: PAGE + 1,
  });
  const page = rows.slice(0, PAGE);
  return {
    orders: page.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      createdAt: o.createdAt,
      stage: trackingStage(o, o.shipments || []),
      totalAmount: String(o.totalAmount),
      currency: o.currency,
      itemsCount: (o.items || []).reduce((n, i) => n + i.quantity, 0),
      firstItemName: o.items && o.items[0] ? o.items[0].productNameSnapshot : null,
    })),
    nextBefore: rows.length > PAGE ? page[page.length - 1].createdAt.toISOString() : null,
  };
}

async function loadOwnOrder(customer, orderId) {
  const order = await db.Order.findOne({
    where: { ...ownOrders(customer), id: orderId },
    include: [{ model: db.OrderItem, as: 'items' }, { model: db.Shipment, as: 'shipments' }],
  });
  if (!order) throw new NotFoundError('Order');
  return order;
}

async function getOrder(customer, orderId) {
  const order = await loadOwnOrder(customer, orderId);
  const tracked = await require('../storefront/storefrontService').presentTrackedOrder(customer.workspaceId, order);
  return { order: { id: order.id, createdAt: order.createdAt, paymentMethod: order.paymentMethod, shippingAddress: order.shippingAddressSnapshot || null, ...tracked } };
}

/** The order's lines as cart lines, each saying whether it can be bought again now. The frontend fills the cart. */
async function reorder(customer, orderId) {
  const order = await loadOwnOrder(customer, orderId);
  const ids = [...new Set(order.items.map((i) => i.variantId).filter(Boolean))];
  const variants = await db.ProductVariant.findAll({
    where: { id: ids, workspaceId: customer.workspaceId },
    include: [{ model: db.Product, as: 'product', attributes: ['id', 'name', 'status'] }],
  });
  const byId = new Map(variants.map((v) => [v.id, v]));
  const lines = order.items
    .filter((i) => !i.isUpsell && !i.isOrderBump)
    .map((i) => {
      const v = byId.get(i.variantId);
      const free = v ? v.stockOnHand - v.reservedStock : 0;
      let reason = null;
      if (!v || v.status !== 'active' || !v.product || v.product.status !== 'active') reason = 'unavailable';
      else if (!v.allowOverselling && free < i.quantity) reason = free > 0 ? 'low_stock' : 'out_of_stock';
      return {
        variantId: i.variantId,
        productId: v ? v.productId : i.productId,
        name: i.productNameSnapshot,
        quantity: reason === 'low_stock' ? free : i.quantity,
        unitPrice: v ? String(v.priceAmount) : null,
        available: !reason || reason === 'low_stock',
        reason,
      };
    });
  return { lines };
}

// ----------------------------------------------------------------- routes --

const storeParams = Joi.object({ workspaceId: Joi.string().required() });
const phone = Joi.string().trim().min(6).max(32);
const email = Joi.string().trim().email().max(255);
const who = { phone, email };
const addressBody = {
  label: Joi.string().trim().max(60).allow('', null),
  fullName: Joi.string().trim().max(200).allow('', null),
  phone: Joi.string().trim().max(32).allow('', null),
  country: Joi.string().pattern(/^[A-Za-z]{2}$/),
  province: Joi.string().trim().max(120).allow('', null),
  city: Joi.string().trim().max(120).allow('', null),
  area: Joi.string().trim().max(120).allow('', null),
  addressLine: Joi.string().trim().max(500).allow('', null),
  postalCode: Joi.string().trim().max(20).allow('', null),
  // One of the store's delivery zones (shipping/deliveryZones.js), when it prices by zones.
  deliveryZoneId: Joi.string().uuid().allow(null),
  isDefault: Joi.boolean(),
};

function enabledOnly(req, res, next) {
  if (!settingsOf(req.publicWorkspace).enabled) return next(new AppError('SHOPPER_ACCOUNTS_OFF', 'This store has no customer accounts', 404));
  return next();
}

const signedIn = asyncHandler(async (req, res, next) => {
  const customer = await auth.readToken(req.publicWorkspace.id, req.headers['x-shopper-token']);
  if (!customer) throw new AppError('SHOPPER_NOT_SIGNED_IN', 'Sign in again', 401);
  req.shopper = customer;
  next();
});

const channelAllowed = (req) => {
  const { channels } = settingsOf(req.publicWorkspace);
  const channel = req.body.phone ? 'sms' : 'email';
  if (!channels.includes(channel)) throw new AppError('SHOPPER_CHANNEL_OFF', channel === 'sms' ? 'Sign in with your email' : 'Sign in with your phone', 422);
};

// Mounted at /api/v1/store/:workspaceId/account.
const store = Router({ mergeParams: true });
store.use(requireStoreFeature('shopper_accounts'));
store.use(resolvePublicWorkspace);
store.get('/config', validate({ params: storeParams }), (req, res) => res.json(settingsOf(req.publicWorkspace)));
store.post(
  '/code',
  enabledOnly,
  validate({ params: storeParams, body: Joi.object({ ...who, locale: Joi.string().valid('ar', 'en', 'fr') }).xor('phone', 'email') }),
  asyncHandler(async (req, res) => {
    channelAllowed(req);
    res.json(await auth.requestCode(req.publicWorkspace, req.body, { ip: clientIp(req), locale: req.body.locale }));
  })
);
store.post(
  '/verify',
  enabledOnly,
  validate({ params: storeParams, body: Joi.object({ ...who, code: Joi.string().pattern(/^\d{6}$/).required() }).xor('phone', 'email') }),
  asyncHandler(async (req, res) => {
    channelAllowed(req);
    const { token, expiresInSeconds, customer } = await auth.verifyCode(req.publicWorkspace, req.body, { req });
    res.json({ token, expiresInSeconds, ...(await me(customer)) });
  })
);
store.use(enabledOnly, signedIn);
store.get('/me', validate({ params: storeParams }), asyncHandler(async (req, res) => res.json(await me(req.shopper))));
// Verify an email: a code to it, then the code back.
store.post('/email/code', validate({ params: storeParams, body: Joi.object({ email: email.required(), locale: Joi.string().valid('ar', 'en', 'fr') }) }), asyncHandler(async (req, res) => {
  res.json(await auth.requestEmailLink(req.publicWorkspace, req.shopper, req.body, { ip: clientIp(req) }));
}));
store.post('/email/verify', validate({ params: storeParams, body: Joi.object({ email: email.required(), code: Joi.string().pattern(/^\d{6}$/).required() }) }), asyncHandler(async (req, res) => {
  res.json(await me(await auth.verifyEmailLink(req.publicWorkspace, req.shopper, req.body)));
}));
store.patch(
  '/me',
  validate({ params: storeParams, body: Joi.object({ fullName: Joi.string().trim().max(200).allow('', null), email: email.allow('', null), marketingConsent: Joi.boolean() }).min(1) }),
  asyncHandler(async (req, res) => res.json(await updateMe(req.shopper, req.body)))
);
store.post('/sign-out-everywhere', validate({ params: storeParams }), asyncHandler(async (req, res) => res.json(await auth.signOutEverywhere(req.shopper))));
store.get('/orders', validate({ params: storeParams, query: Joi.object({ before: Joi.date().iso() }) }), asyncHandler(async (req, res) => res.json(await listOrders(req.shopper, req.query))));
const orderParams = Joi.object({ workspaceId: Joi.string().required(), orderId: Joi.string().uuid().required() });
store.get('/orders/:orderId', validate({ params: orderParams }), asyncHandler(async (req, res) => res.json(await getOrder(req.shopper, req.params.orderId))));
store.post('/orders/:orderId/reorder', validate({ params: orderParams }), asyncHandler(async (req, res) => res.json(await reorder(req.shopper, req.params.orderId))));
store.get('/addresses', validate({ params: storeParams }), (req, res) => res.json({ addresses: req.shopper.savedAddresses || [] }));
store.post(
  '/addresses',
  validate({ params: storeParams, body: Joi.object({ ...addressBody, country: addressBody.country.required(), city: Joi.string().trim().min(1).max(120).required(), addressLine: Joi.string().trim().min(1).max(500).required() }) }),
  asyncHandler(async (req, res) => res.status(201).json(await addAddress(req.shopper, req.body)))
);
const addressParams = Joi.object({ workspaceId: Joi.string().required(), addressId: Joi.string().uuid().required() });
store.patch('/addresses/:addressId', validate({ params: addressParams, body: Joi.object(addressBody).min(1) }), asyncHandler(async (req, res) => res.json(await updateAddress(req.shopper, req.params.addressId, req.body))));
store.delete('/addresses/:addressId', validate({ params: addressParams }), asyncHandler(async (req, res) => res.json(await removeAddress(req.shopper, req.params.addressId))));

// Mounted at /api/v1/workspaces/:workspaceId/shopper-accounts (website.edit: it is a storefront feature).
const staff = Router({ mergeParams: true });
staff.use(requireStoreFeature('shopper_accounts'));
staff.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WEBSITE_EDIT));
const ws = Joi.object({ workspaceId: Joi.string().uuid().required() });
staff.get('/', validate({ params: ws }), asyncHandler(async (req, res) => res.json(settingsOf(await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'settings'] })))));
staff.put(
  '/',
  validate({ params: ws, body: Joi.object({ enabled: Joi.boolean().required(), channels: Joi.array().items(Joi.string().valid(...CHANNELS)).min(1).unique() }) }),
  asyncHandler(async (req, res) => {
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId);
    const before = settingsOf(workspace);
    const next = { enabled: req.body.enabled, channels: req.body.channels || before.channels };
    await workspace.update({ settings: { ...(workspace.settings || {}), shopper_accounts: next } });
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'shopper_accounts.update', entityType: 'Workspace', entityId: workspace.id, before, after: next, req });
    res.json(next);
  })
);

module.exports = { store, staff, settingsOf };
