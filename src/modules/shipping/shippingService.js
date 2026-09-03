'use strict';

const db = require('../../db/models');
const { scoped } = require('../../core/utils/scopedRepository');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * CRUD for the merchant's shipping zones and the rates inside them. These
 * feed shippingPricing.calculateShippingAmount at checkout, which copies the
 * resulting amount onto the order (order.shippingAmount) as a plain integer —
 * no order row ever references a zone or rate by id. That makes deletes here
 * genuine hard deletes: there is no history to protect.
 */

async function listZones(workspaceId) {
  return db.ShippingZone.findAll({
    where: { workspaceId },
    include: [{ model: db.ShippingRate, as: 'rates' }],
    order: [['createdAt', 'ASC']],
  });
}

async function getZone(workspaceId, zoneId) {
  const zone = await db.ShippingZone.findOne({
    where: { id: zoneId, workspaceId },
    include: [{ model: db.ShippingRate, as: 'rates' }],
  });
  if (!zone) throw new NotFoundError('ShippingZone');
  return zone;
}

async function createZone(workspaceId, data, req) {
  const zone = await db.ShippingZone.create({ ...data, workspaceId });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'shipping_zone.create',
    entityType: 'ShippingZone',
    entityId: zone.id,
    after: zone.toJSON(),
    req,
  });
  return zone;
}

async function updateZone(workspaceId, zoneId, data, req) {
  const zone = await scoped(db.ShippingZone, workspaceId, 'ShippingZone').findByPkOrThrow(zoneId);
  const before = zone.toJSON();
  await zone.update(data);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'shipping_zone.update',
    entityType: 'ShippingZone',
    entityId: zone.id,
    before,
    after: zone.toJSON(),
    req,
  });
  return zone;
}

async function deleteZone(workspaceId, zoneId, req) {
  return db.sequelize.transaction(async (t) => {
    const zone = await db.ShippingZone.findOne({ where: { id: zoneId, workspaceId }, transaction: t });
    if (!zone) throw new NotFoundError('ShippingZone');
    const before = zone.toJSON();

    await db.ShippingRate.destroy({ where: { zoneId: zone.id, workspaceId }, transaction: t });
    await zone.destroy({ transaction: t });

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'shipping_zone.delete',
      entityType: 'ShippingZone',
      entityId: zoneId,
      before,
      req,
      transaction: t,
    });

    return { deleted: true, id: zoneId };
  });
}

async function listRates(workspaceId, zoneId) {
  await scoped(db.ShippingZone, workspaceId, 'ShippingZone').findByPkOrThrow(zoneId);
  return db.ShippingRate.findAll({ where: { workspaceId, zoneId }, order: [['createdAt', 'ASC']] });
}

async function getRate(workspaceId, rateId) {
  const rate = await db.ShippingRate.findOne({ where: { id: rateId, workspaceId } });
  if (!rate) throw new NotFoundError('ShippingRate');
  return rate;
}

async function createRate(workspaceId, zoneId, data, req) {
  const zone = await scoped(db.ShippingZone, workspaceId, 'ShippingZone').findByPkOrThrow(zoneId);
  const rate = await db.ShippingRate.create({ ...data, workspaceId, zoneId: zone.id });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'shipping_rate.create',
    entityType: 'ShippingRate',
    entityId: rate.id,
    after: rate.toJSON(),
    req,
  });
  return rate;
}

async function updateRate(workspaceId, rateId, data, req) {
  const rate = await scoped(db.ShippingRate, workspaceId, 'ShippingRate').findByPkOrThrow(rateId);
  const before = rate.toJSON();
  await rate.update(data);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'shipping_rate.update',
    entityType: 'ShippingRate',
    entityId: rate.id,
    before,
    after: rate.toJSON(),
    req,
  });
  return rate;
}

async function deleteRate(workspaceId, rateId, req) {
  const rate = await scoped(db.ShippingRate, workspaceId, 'ShippingRate').findByPkOrThrow(rateId);
  const before = rate.toJSON();
  await rate.destroy();
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'shipping_rate.delete',
    entityType: 'ShippingRate',
    entityId: rateId,
    before,
    req,
  });
  return { deleted: true, id: rateId };
}

module.exports = {
  listZones,
  getZone,
  createZone,
  updateZone,
  deleteZone,
  listRates,
  getRate,
  createRate,
  updateRate,
  deleteRate,
};
