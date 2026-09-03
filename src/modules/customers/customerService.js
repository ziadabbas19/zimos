'use strict';

const db = require('../../db/models');
const { normalizePhone } = require('../../core/utils/phone');
const { scoped } = require('../../core/utils/scopedRepository');
const { AppError, NotFoundError, ConflictError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * Finds an existing customer by normalized phone within the workspace, or
 * creates one. This is the identity-resolution step used by checkout so
 * repeat customers (by phone) accumulate order history instead of getting a
 * duplicate Customer row per order.
 */
async function findOrCreateByPhone(workspaceId, { phone, alternatePhone, email, fullName }, transaction) {
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422);

  const [customer] = await db.Customer.findOrCreate({
    where: { workspaceId, phoneNormalized },
    defaults: { workspaceId, phoneNormalized, phoneRaw: phone, alternatePhone, email, fullName },
    transaction,
  });

  // Keep contact details fresh on repeat orders without clobbering an
  // existing name/email with blanks.
  const updates = {};
  if (fullName && !customer.fullName) updates.fullName = fullName;
  if (email && !customer.email) updates.email = email;
  if (alternatePhone && !customer.alternatePhone) updates.alternatePhone = alternatePhone;
  if (Object.keys(updates).length) await customer.update(updates, { transaction });

  return customer;
}

async function getCustomer(workspaceId, customerId) {
  const customer = await db.Customer.findOne({
    where: { id: customerId, workspaceId },
    include: [{ model: db.CustomerAddress, as: 'addresses' }],
  });
  if (!customer) throw new NotFoundError('Customer');
  return customer;
}

async function listCustomers(workspaceId, { limit = 50, cursor, blacklistedOnly } = {}) {
  const where = { workspaceId };
  if (cursor) where.id = { [db.Sequelize.Op.gt]: cursor };
  if (blacklistedOnly) where.isBlacklisted = true;

  const customers = await db.Customer.findAll({ where, order: [['id', 'ASC']], limit: limit + 1 });
  const hasMore = customers.length > limit;
  const page = customers.slice(0, limit);
  return { customers: page, nextCursor: hasMore ? page[page.length - 1].id : null };
}

async function setBlacklist(workspaceId, customerId, { isBlacklisted, reason }, req) {
  const customer = await scoped(db.Customer, workspaceId).findByPkOrThrow(customerId);
  const before = { isBlacklisted: customer.isBlacklisted };
  await customer.update({ isBlacklisted, blacklistReason: isBlacklisted ? reason : null });

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'customer.blacklist_change',
    entityType: 'Customer',
    entityId: customer.id,
    before,
    after: { isBlacklisted },
    req,
  });
  return customer;
}

// Full phone/address/history reveal — gated by customers.reveal_sensitive
// and audited every time.
async function revealSensitive(workspaceId, customerId, req) {
  const customer = await getCustomer(workspaceId, customerId);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'customer.reveal_sensitive',
    entityType: 'Customer',
    entityId: customer.id,
    req,
  });
  return customer;
}

// Edit a customer's contact details only. Blacklist, reliability score and
// order counters are maintained elsewhere. A supplied `phone` is re-normalized
// and must stay unique in the workspace.
async function updateCustomer(workspaceId, customerId, data, req) {
  const customer = await scoped(db.Customer, workspaceId).findByPkOrThrow(customerId);
  const before = customer.toJSON();

  const updates = {};
  for (const field of ['fullName', 'email', 'alternatePhone', 'marketingConsent']) {
    if (data[field] !== undefined) updates[field] = data[field];
  }
  if (data.phone !== undefined) {
    const phoneNormalized = normalizePhone(data.phone);
    if (!phoneNormalized) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422);
    updates.phoneRaw = data.phone;
    updates.phoneNormalized = phoneNormalized;
  }

  try {
    await customer.update(updates);
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      throw new ConflictError('Another customer in this workspace already uses that phone number', 'PHONE_TAKEN');
    }
    throw err;
  }

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'customer.update',
    entityType: 'Customer',
    entityId: customer.id,
    before,
    after: customer.toJSON(),
    req,
  });
  return customer;
}

async function addAddress(workspaceId, customerId, data, req) {
  const customer = await scoped(db.Customer, workspaceId).findByPkOrThrow(customerId);
  const address = await db.CustomerAddress.create({ ...data, workspaceId, customerId: customer.id });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'customer.address_add', entityType: 'CustomerAddress', entityId: address.id, req });
  return address;
}

async function updateAddress(workspaceId, customerId, addressId, data, req) {
  const customer = await scoped(db.Customer, workspaceId).findByPkOrThrow(customerId);
  const address = await db.CustomerAddress.findOne({ where: { id: addressId, workspaceId, customerId: customer.id } });
  if (!address) throw new NotFoundError('CustomerAddress');
  const before = address.toJSON();
  await address.update(data);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'customer.address_update',
    entityType: 'CustomerAddress',
    entityId: address.id,
    before,
    after: address.toJSON(),
    req,
  });
  return address;
}

module.exports = {
  findOrCreateByPhone,
  getCustomer,
  listCustomers,
  setBlacklist,
  revealSensitive,
  updateCustomer,
  addAddress,
  updateAddress,
};
