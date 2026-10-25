'use strict';

const Joi = require('joi');
const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const queue = require('../../core/queue');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const geo = require('../geo/geoRegions');
const accounts = require('./carrierAccountService');
const { resolveDropOff } = require('./carrierRegionMap');

/**
 * "Ship selected" with a connected courier (SPEC §12.4).
 *
 *   preview   which of the chosen orders are ready to book, which miss a
 *             place on the courier's list (with the place to fix on the
 *             areas map, when the order names one), and which cannot ship
 *   start     a batch: one item per order, booked one by one by a job on
 *             the carriers queue (shipments.bulk_book), each exactly as a
 *             booking from the order page
 *   retry     the merchant sends the failed ones again, optionally with a
 *             place chosen for each
 *
 * A booking is never repeated on its own: a job that stops halfway leaves
 * the order it was booking marked failed ("interrupted") unless the order
 * has the shipment by then, and only the merchant sends it again.
 */

const MAX_ORDERS = 500;
const JOB = 'shipments.bulk_book';

const uuid = Joi.string().uuid();
const pathSchema = Joi.object({ path: Joi.array().items(Joi.string().max(100)).min(1).max(6).required() });
const addressesSchema = Joi.object().pattern(uuid, pathSchema).max(MAX_ORDERS);
const params = Joi.object({ workspaceId: uuid.required() });
const batchParams = params.keys({ batchId: uuid.required() });
const carrierCode = Joi.string().pattern(/^[a-z0-9_-]{1,50}$/).required();

const schemas = {
  preview: {
    params,
    body: Joi.object({
      carrierCode,
      orderIds: Joi.array().items(uuid).min(1).max(MAX_ORDERS).optional(),
      filter: Joi.object().unknown(true).optional(),
      addresses: addressesSchema.optional(),
    }).xor('orderIds', 'filter'),
  },
  start: {
    params,
    body: Joi.object({
      carrierCode,
      orderIds: Joi.array().items(uuid).min(1).max(MAX_ORDERS).required(),
      addresses: addressesSchema.optional(),
      notes: Joi.string().trim().max(500).allow('', null).optional(),
    }),
  },
  list: { params },
  get: { params: batchParams },
  retry: {
    params: batchParams,
    body: Joi.object({
      orderIds: Joi.array().items(uuid).min(1).max(MAX_ORDERS).optional(),
      addresses: addressesSchema.optional(),
    }),
  },
};

const operational = (err) => ({
  code: err.isOperational ? err.code : 'INTERNAL_SERVER_ERROR',
  message: err.isOperational ? String(err.message).slice(0, 500) : 'Something went wrong with this order',
});

/** Why an order cannot be booked at all, or null. Mirrors the booking's own guards. */
function blockedReason(order, hasActiveShipment) {
  try {
    require('./carrierShipmentService').assertConfirmedOrPaid(order);
  } catch (err) {
    return operational(err);
  }
  if (require('./storePickup').isPickup(order)) return { code: 'PICKUP_ORDER', message: 'This order is collected from the store' };
  if (!order.shippingAddressSnapshot) return { code: 'SHIPPING_ADDRESS_REQUIRED', message: 'This order has no shipping address' };
  if (hasActiveShipment) {
    return { code: 'SHIPMENT_ALREADY_EXISTS', message: 'This order already has an active shipment. Cancel it before booking another.' };
  }
  return null;
}

async function selectedIds(workspaceId, { orderIds, filter }) {
  if (orderIds && orderIds.length) return [...new Set(orderIds)].slice(0, MAX_ORDERS);
  // eslint-disable-next-line global-require
  return require('../orders/orderBulkService').idsForFilter(workspaceId, filter || {});
}

const placeView = (place) => place && { code: place.code, level: place.level, nameAr: place.nameAr, nameEn: place.nameEn };

/**
 * POST /shipment-batches/preview — sorts the chosen orders into ready,
 * missing (no place on the courier's list) and blocked, without booking.
 */
async function preview(workspaceId, body) {
  const ids = await selectedIds(workspaceId, body);
  if (ids.length === 0) throw new AppError('NO_ORDERS_SELECTED', 'No orders match this selection', 422);
  const connection = await accounts.loadConnection(workspaceId, body.carrierCode);
  const { adapter } = connection;
  const { index } = await accounts.loadCities(connection);
  const addresses = body.addresses || {};

  const orders = await db.Order.findAll({ where: { workspaceId, id: ids } });
  const byId = new Map(orders.map((o) => [o.id, o]));
  const { FINISHED_STATUSES } = require('./carrierShipmentService');
  const active = new Set(
    (await db.Shipment.findAll({ where: { orderId: ids, status: { [Op.notIn]: FINISHED_STATUSES } }, attributes: ['orderId'] })).map((s) => s.orderId)
  );
  // A locked order (orders/orderLock) is blocked as its booking would be (402 ORDER_LOCKED), before its address is read.
  const orderLock = require('../orders/orderLock');
  const lockCtx = await orderLock.contextFor(workspaceId);
  const locked = await orderLock.lockedIds(lockCtx, orders);
  const lockedReason = locked.size > 0 ? { code: 'ORDER_LOCKED', message: orderLock.lockedError(lockCtx).message } : null;

  const ready = [];
  const missing = [];
  const blocked = [];
  for (const id of ids) {
    const order = byId.get(id);
    if (!order) {
      blocked.push({ orderId: id, orderNumber: null, code: 'NOT_FOUND', message: 'Order not found' });
      continue;
    }
    const base = { orderId: id, orderNumber: order.orderNumber };
    const reason = locked.has(id) ? lockedReason : blockedReason(order, active.has(id));
    if (reason) {
      blocked.push({ ...base, ...reason });
      continue;
    }
    const snapshot = order.shippingAddressSnapshot;
    try {
      const resolved = await resolveDropOff(adapter, index, workspaceId, snapshot, addresses[id]);
      ready.push({ ...base, place: resolved.path.map((n) => ({ id: n.id, name: n.name, nameAr: n.nameAr || null })) });
    } catch (err) {
      if (!(err instanceof AppError) || !['CARRIER_ADDRESS_UNMATCHED', 'VALIDATION_ERROR'].includes(err.code)) throw err;
      const place = await geo.resolve(snapshot);
      missing.push({
        ...base,
        province: snapshot.province || null,
        city: snapshot.city || null,
        // A city of the platform's list: fixing it on the areas map fixes every order from there.
        region: placeView(place.city),
        governorate: placeView(place.governorate),
        code: err.code,
      });
    }
  }
  return {
    carrierCode: adapter.code,
    carrierName: adapter.name,
    levels: adapter.capabilities.addressLevels,
    total: ids.length,
    ready,
    missing,
    blocked,
  };
}

function itemView(item) {
  return {
    orderId: item.orderId,
    orderNumber: item.order ? item.order.orderNumber : null,
    status: item.status,
    waybillNumber: item.waybillNumber,
    shipmentId: item.shipmentId,
    errorCode: item.errorCode,
    errorMessage: item.errorMessage,
    attempts: item.attempts,
    updatedAt: item.updatedAt,
  };
}

function countsOf(items) {
  const counts = { total: items.length, pending: 0, booked: 0, failed: 0 };
  for (const item of items) {
    if (item.status === 'booked') counts.booked += 1;
    else if (item.status === 'failed') counts.failed += 1;
    else counts.pending += 1;
  }
  return counts;
}

function batchView(batch, items, { withItems = true } = {}) {
  return {
    id: batch.id,
    carrierCode: batch.carrierCode,
    status: batch.status,
    notes: batch.notes,
    createdBy: batch.createdBy,
    createdAt: batch.createdAt,
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
    counts: countsOf(items),
    ...(withItems ? { items: items.map(itemView) } : {}),
  };
}

async function loadBatch(workspaceId, batchId, { transaction, lock } = {}) {
  const batch = await db.ShipmentBatch.findOne({ where: { id: batchId, workspaceId }, transaction, lock });
  if (!batch) throw new NotFoundError('Shipment batch');
  return batch;
}

async function itemsOf(batchId, { transaction } = {}) {
  return db.ShipmentBatchItem.findAll({
    where: { batchId },
    include: [{ model: db.Order, as: 'order', attributes: ['id', 'orderNumber'] }],
    order: [['createdAt', 'ASC'], ['id', 'ASC']],
    transaction,
  });
}

/** POST /shipment-batches — queues the booking of the orders with the courier. */
async function start(workspaceId, body, req) {
  const connection = await accounts.loadConnection(workspaceId, body.carrierCode);
  const ids = [...new Set(body.orderIds)];
  const found = await db.Order.count({ where: { workspaceId, id: ids } });
  if (found !== ids.length) throw new NotFoundError('Order');
  const addresses = body.addresses || {};

  const t0 = Date.now();
  const batch = await db.sequelize.transaction(async (transaction) => {
    const created = await db.ShipmentBatch.create(
      { workspaceId, carrierCode: connection.adapter.code, notes: body.notes || null, createdBy: req.user.id },
      { transaction }
    );
    await db.ShipmentBatchItem.bulkCreate(
      // One millisecond apart: items are booked and listed in the order the merchant chose.
      ids.map((orderId, i) => ({
        batchId: created.id,
        workspaceId,
        orderId,
        carrierAddress: addresses[orderId] || null,
        createdAt: new Date(t0 + i),
      })),
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'shipment_batch.create',
      entityType: 'ShipmentBatch',
      entityId: created.id,
      metadata: { carrierCode: connection.adapter.code, orders: ids.length },
      req,
      transaction,
    });
    await queue.add('carriers', JOB, { batchId: created.id }, { transaction, workspaceId, dedupeKey: `bulk_book:${created.id}:0` });
    return created;
  });
  return batchView(batch, await itemsOf(batch.id));
}

/** POST /shipment-batches/:batchId/retry — the failed orders (or those named) go to the courier again. */
async function retry(workspaceId, batchId, body, req) {
  const addresses = body.addresses || {};
  const batch = await db.sequelize.transaction(async (transaction) => {
    const locked = await loadBatch(workspaceId, batchId, { transaction, lock: transaction.LOCK.UPDATE });
    if (locked.status !== 'done') throw new AppError('BATCH_RUNNING', 'This batch is still booking. Wait for it to finish.', 409);
    const where = { batchId, status: 'failed' };
    if (body.orderIds) where.orderId = body.orderIds;
    const failed = await db.ShipmentBatchItem.findAll({ where, transaction });
    if (failed.length === 0) throw new AppError('NOTHING_TO_RETRY', 'No failed orders to send again', 422);
    for (const item of failed) {
      await item.update(
        {
          status: 'pending',
          errorCode: null,
          errorMessage: null,
          carrierAddress: addresses[item.orderId] || item.carrierAddress,
        },
        { transaction }
      );
    }
    await locked.update({ status: 'queued', finishedAt: null }, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'shipment_batch.retry',
      entityType: 'ShipmentBatch',
      entityId: batchId,
      metadata: { orders: failed.length },
      req,
      transaction,
    });
    await queue.add('carriers', JOB, { batchId }, { transaction, workspaceId, dedupeKey: `bulk_book:${batchId}:${Date.now()}` });
    return locked;
  });
  return batchView(batch, await itemsOf(batchId));
}

async function get(workspaceId, batchId) {
  const batch = await loadBatch(workspaceId, batchId);
  return batchView(batch, await itemsOf(batchId));
}

/** The store's latest batches, newest first. */
async function list(workspaceId) {
  const batches = await db.ShipmentBatch.findAll({ where: { workspaceId }, order: [['createdAt', 'DESC']], limit: 20 });
  const items = await db.ShipmentBatchItem.findAll({
    where: { batchId: batches.map((b) => b.id) },
    attributes: ['batchId', 'status'],
  });
  return {
    batches: batches.map((b) => batchView(b, items.filter((i) => i.batchId === b.id), { withItems: false })),
  };
}

async function tellCreator(batch, counts, adapter) {
  if (!batch.createdBy) return;
  const name = adapter ? adapter.name : batch.carrierCode;
  await require('../notifications/merchantNotificationService').create(batch.workspaceId, {
    type: 'shipping.batch_done',
    title: counts.failed
      ? `تم حجز ${counts.booked} من ${counts.total} أوردر مع ${name} — ${counts.failed} لم يُحجز`
      : `تم حجز ${counts.booked} أوردر مع ${name}`,
    body: counts.failed ? 'افتح التقرير لمعرفة السبب وإعادة إرسال ما لم يُحجز.' : null,
    link: `/orders/shipment-batches/${batch.id}`,
    data: { batchId: batch.id, carrierCode: batch.carrierCode, carrierName: name, ...counts },
    userIds: [batch.createdBy],
  });
}

/** The carriers-queue job: books the batch's pending orders one by one. */
async function processBatch(job) {
  const batch = await db.ShipmentBatch.findByPk(job.payload && job.payload.batchId);
  if (!batch) return null;
  const { workspaceId } = batch;
  const shipments = require('./carrierShipmentService');
  const adapter = require('./carriers').getAdapter(batch.carrierCode);
  await batch.update({ status: 'running', startedAt: batch.startedAt || new Date() });

  // A run that stopped while booking: booked if the order has the shipment now, else the merchant decides.
  const interrupted = await db.ShipmentBatchItem.findAll({ where: { batchId: batch.id, status: 'booking' } });
  for (const item of interrupted) {
    const shipment = await db.Shipment.findOne({
      where: { orderId: item.orderId, carrierCode: batch.carrierCode, status: { [Op.notIn]: shipments.FINISHED_STATUSES } },
    });
    await item.update(
      shipment
        ? { status: 'booked', shipmentId: shipment.id, waybillNumber: shipment.waybillNumber }
        : {
            status: 'failed',
            errorCode: 'BOOKING_INTERRUPTED',
            errorMessage: `The run stopped while booking this order. Check ${adapter ? adapter.name : batch.carrierCode} before sending it again.`,
          }
    );
  }

  // As the person who started it, for the audit trail and the order history.
  const actor = { user: { id: batch.createdBy }, headers: {}, ip: null };
  const pending = await db.ShipmentBatchItem.findAll({ where: { batchId: batch.id, status: 'pending' }, order: [['createdAt', 'ASC'], ['id', 'ASC']] });
  for (const item of pending) {
    await item.update({ status: 'booking', attempts: item.attempts + 1 });
    try {
      const shipment = await shipments.createCarrierShipment(
        workspaceId,
        item.orderId,
        { carrierCode: batch.carrierCode, carrierAddress: item.carrierAddress || undefined, notes: batch.notes || undefined },
        batch.createdBy ? actor : null
      );
      await item.update({ status: 'booked', shipmentId: shipment.id, waybillNumber: shipment.waybillNumber, errorCode: null, errorMessage: null });
    } catch (err) {
      if (!err.isOperational) logger.error('Bulk booking failed unexpectedly', { workspaceId, orderId: item.orderId, message: err.message });
      const { code, message } = operational(err);
      await item.update({ status: 'failed', errorCode: code, errorMessage: message });
    }
  }

  const counts = countsOf(await db.ShipmentBatchItem.findAll({ where: { batchId: batch.id }, attributes: ['status'] }));
  await batch.update({ status: 'done', finishedAt: new Date() });
  logger.info('Shipment batch done', { workspaceId, batchId: batch.id, carrierCode: batch.carrierCode, ...counts });
  await tellCreator(batch, counts, adapter);
  return counts;
}

module.exports = { JOB, MAX_ORDERS, schemas, preview, start, retry, get, list, processBatch };
