'use strict';

const db = require('../../db/models');
const { scoped } = require('../../core/utils/scopedRepository');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * CRUD for the merchant's tax rates. taxService.calculateTax reads these at
 * checkout and the resulting amount is copied onto order.taxAmount as a plain
 * integer — no order references a tax_rate row — so deletes here are genuine
 * hard deletes with no history to protect.
 */

async function listRates(workspaceId) {
  return db.TaxRate.findAll({ where: { workspaceId }, order: [['createdAt', 'ASC']] });
}

async function getRate(workspaceId, taxRateId) {
  return scoped(db.TaxRate, workspaceId, 'TaxRate').findByPkOrThrow(taxRateId);
}

async function createRate(workspaceId, data, req) {
  const rate = await db.TaxRate.create({ ...data, workspaceId });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'tax_rate.create',
    entityType: 'TaxRate',
    entityId: rate.id,
    after: rate.toJSON(),
    req,
  });
  return rate;
}

async function updateRate(workspaceId, taxRateId, data, req) {
  const rate = await scoped(db.TaxRate, workspaceId, 'TaxRate').findByPkOrThrow(taxRateId);
  const before = rate.toJSON();
  await rate.update(data);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'tax_rate.update',
    entityType: 'TaxRate',
    entityId: rate.id,
    before,
    after: rate.toJSON(),
    req,
  });
  return rate;
}

async function deleteRate(workspaceId, taxRateId, req) {
  const rate = await scoped(db.TaxRate, workspaceId, 'TaxRate').findByPkOrThrow(taxRateId);
  const before = rate.toJSON();
  await rate.destroy();
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'tax_rate.delete',
    entityType: 'TaxRate',
    entityId: taxRateId,
    before,
    req,
  });
  return { deleted: true, id: taxRateId };
}

module.exports = { listRates, getRate, createRate, updateRate, deleteRate };
