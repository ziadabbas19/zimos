'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { add } = require('../../core/utils/money');
const inventoryService = require('../inventory/inventoryService');
const customerService = require('../customers/customerService');
const discountService = require('../discounts/discountService');
const { calculateShippingAmount } = require('../shipping/shippingPricing');
const { calculateTax } = require('../tax/taxService');
const { createInvoiceForOrder } = require('../invoices/invoiceService');
const { recordAudit } = require('../audit/auditService');
const { setConfirmationState, setFulfillmentState } = require('./orderStateService');

// A shipment past this point means the parcel has left the merchant's hands.
const SHIPMENT_IN_MOTION = ['picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'returned'];

async function assertNotShipped(order, transaction) {
  if (order.fulfillmentState === 'fulfilled' || order.fulfillmentState === 'partially_fulfilled' || order.fulfillmentState === 'returned') {
    throw new AppError('ORDER_ALREADY_SHIPPED', 'This order has already been shipped and can no longer be changed', 409);
  }
  const moving = await db.Shipment.count({
    where: { orderId: order.id, status: SHIPMENT_IN_MOTION },
    transaction,
  });
  if (moving > 0) {
    throw new AppError('ORDER_ALREADY_SHIPPED', 'This order has a shipment in transit and can no longer be changed', 409);
  }
}

function generateOrderNumber() {
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `ORD-${Date.now().toString(36).toUpperCase()}-${rand}`;
}

// Human-facing shipment reference: `zg` + 9 random digits.
function generateTrackingCode() {
  return `zg${String(crypto.randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

// Prices one line from server-side data only. variantId/offerId are looked up
// fresh inside the caller's transaction; any client-sent price is ignored.
async function priceLine(workspaceId, { variantId, offerId, quantity }, transaction) {
  const variant = await db.ProductVariant.findOne({
    where: { id: variantId, workspaceId, status: 'active' },
    include: [{ model: db.Product, as: 'product' }],
    transaction,
  });
  if (!variant) throw new NotFoundError('ProductVariant');

  if (offerId) {
    const offer = await db.Offer.findOne({
      where: { id: offerId, workspaceId, productId: variant.productId, status: 'active' },
      include: [{ model: db.OfferVariant, as: 'lines' }],
      transaction,
    });
    if (!offer) throw new NotFoundError('Offer');

    const consumedLines = offer.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity * quantity }));
    const unitPrice = offer.priceAmount;
    const lineTotal = unitPrice * quantity;

    return {
      productId: variant.productId,
      productName: variant.product.name,
      variantId: variant.id,
      variantOptions: variant.optionValues,
      sku: variant.sku,
      offerId: offer.id,
      offerName: offer.name,
      quantity,
      unitPriceAmount: unitPrice,
      unitCostAmount: variant.costAmount,
      lineTotalAmount: lineTotal,
      consumedInventory: consumedLines,
      currency: offer.currency,
      shippingOverride: offer.shippingOverride,
      weightGrams: (variant.weightGrams || 0) * quantity,
    };
  }

  const lineTotal = variant.priceAmount * quantity;
  return {
    productId: variant.productId,
    productName: variant.product.name,
    variantId: variant.id,
    variantOptions: variant.optionValues,
    sku: variant.sku,
    offerId: null,
    offerName: null,
    quantity,
    unitPriceAmount: variant.priceAmount,
    unitCostAmount: variant.costAmount,
    lineTotalAmount: lineTotal,
    consumedInventory: [{ variantId: variant.id, quantity }],
    currency: variant.currency,
    shippingOverride: null,
    weightGrams: (variant.weightGrams || 0) * quantity,
  };
}

async function createOrder(workspaceId, payload, req) {
  const { items, contact, shippingAddress, paymentMethod, discountCode, funnelId, websiteId, notes } = payload;

  if (!items || items.length === 0) {
    throw new ValidationError([{ field: 'items', message: 'At least one item is required' }]);
  }

  return db.sequelize.transaction(async (transaction) => {
    const customer = await customerService.findOrCreateByPhone(workspaceId, contact, transaction);

    const riskFlags = [];
    if (customer.isBlacklisted) riskFlags.push('blacklisted_customer');

    // Price every line and consume/reserve inventory for it. Consuming
    // inventory inside the same transaction as pricing/order-row creation
    // means a failure anywhere rolls the reservation back too — no orphaned
    // reservations from a half-completed order.
    const pricedLines = [];
    for (const item of items) {
      const line = await priceLine(workspaceId, item, transaction);
      pricedLines.push(line);
      for (const consumed of line.consumedInventory) {
        await inventoryService.reserve(
          {
            workspaceId,
            variantId: consumed.variantId,
            quantity: consumed.quantity,
            referenceType: 'order_pending',
            referenceId: null, // filled in after the order row exists, see movement backfill below
            actorUserId: req.user ? req.user.id : null,
          },
          transaction
        );
      }
    }

    const subtotal = add(...pricedLines.map((l) => l.lineTotalAmount));
    const productIds = pricedLines.map((l) => l.productId);
    const totalWeightGrams = add(...pricedLines.map((l) => l.weightGrams));
    const totalQuantity = pricedLines.reduce((sum, l) => sum + l.quantity, 0);
    const offerShippingOverride = pricedLines.find((l) => l.shippingOverride)?.shippingOverride || null;

    let discountAmount = 0;
    let discountsSnapshot = [];
    let discountRecord = null;
    if (discountCode) {
      const evaluation = await discountService.evaluate(workspaceId, discountCode, {
        subtotal,
        productIds,
        customerId: customer.id,
        funnelId,
      });
      discountAmount = evaluation.amount;
      discountRecord = evaluation.discount;
      discountsSnapshot = [{ code: discountCode, type: evaluation.discount.type, amount: discountAmount }];
    }

    const shippingAmount = shippingAddress
      ? await calculateShippingAmount(workspaceId, {
          country: shippingAddress.country,
          region: shippingAddress.province,
          subtotal,
          totalWeightGrams,
          totalQuantity,
          offerShippingOverride,
        })
      : 0;

    const { taxAmount } = await calculateTax(workspaceId, {
      country: shippingAddress ? shippingAddress.country : null,
      region: shippingAddress ? shippingAddress.province : null,
      lines: pricedLines.map((l) => ({ productId: l.productId, lineTotal: l.lineTotalAmount })),
      shippingAmount,
    });

    const totalAmount = subtotal - discountAmount + shippingAmount + taxAmount;

    const order = await db.Order.create(
      {
        workspaceId,
        websiteId: websiteId || null,
        funnelId: funnelId || null,
        customerId: customer.id,
        orderNumber: generateOrderNumber(),
        paymentMethod,
        currency: pricedLines[0].currency,
        subtotalAmount: subtotal,
        discountAmount,
        shippingAmount,
        taxAmount,
        totalAmount,
        contactSnapshot: contact,
        shippingAddressSnapshot: shippingAddress || null,
        discountsSnapshot,
        notes: notes || null,
        riskFlags,
      },
      { transaction }
    );

    // Sequential, not Promise.all — see note in workspaceService: one
    // transaction = one pooled connection, so concurrent queries on it are unsafe.
    const orderItems = [];
    for (const line of pricedLines) {
      orderItems.push(
        await db.OrderItem.create(
          {
            orderId: order.id,
            productId: line.productId,
            variantId: line.variantId,
            offerId: line.offerId,
            productNameSnapshot: line.productName,
            variantOptionsSnapshot: line.variantOptions,
            skuSnapshot: line.sku,
            offerNameSnapshot: line.offerName,
            quantity: line.quantity,
            unitPriceAmount: line.unitPriceAmount,
            unitCostAmount: line.unitCostAmount,
            lineTotalAmount: line.lineTotalAmount,
          },
          { transaction }
        )
      );
    }

    if (discountRecord) {
      await discountService.redeem(
        discountRecord.id,
        { orderId: order.id, customerId: customer.id, amountAllocated: discountAmount },
        transaction
      );
    }

    if (paymentMethod === 'cod') {
      await db.ConfirmationTask.create({ workspaceId, orderId: order.id, status: 'queued' }, { transaction });
    }

    order.items = orderItems;
    await createInvoiceForOrder(order, transaction);

    await customer.increment('totalOrders', { by: 1, transaction });

    await recordAudit({
      workspaceId,
      actorUserId: req.user ? req.user.id : null,
      action: 'order.create',
      entityType: 'Order',
      entityId: order.id,
      after: { orderNumber: order.orderNumber, totalAmount, paymentMethod },
      req,
      transaction,
    });

    return { order, items: orderItems };
  });
}

async function getOrder(workspaceId, orderId) {
  const order = await db.Order.findOne({
    where: { id: orderId, workspaceId },
    include: [
      { model: db.OrderItem, as: 'items' },
      { model: db.Payment, as: 'payments' },
      { model: db.Shipment, as: 'shipments' },
    ],
  });
  if (!order) throw new NotFoundError('Order');
  return order;
}

async function listOrders(workspaceId, { limit = 50, cursor, confirmationState, financialState, fulfillmentState } = {}) {
  const where = { workspaceId };
  if (cursor) where.id = { [db.Sequelize.Op.gt]: cursor };
  if (confirmationState) where.confirmationState = confirmationState;
  if (financialState) where.financialState = financialState;
  if (fulfillmentState) where.fulfillmentState = fulfillmentState;

  const orders = await db.Order.findAll({ where, order: [['id', 'ASC']], limit: limit + 1, include: [{ model: db.OrderItem, as: 'items' }] });
  const hasMore = orders.length > limit;
  const page = orders.slice(0, limit);
  return { orders: page, nextCursor: hasMore ? page[page.length - 1].id : null };
}

/**
 * Merchant cancellation: releases the inventory reservation (like a COD
 * rejection), advances confirmationState to 'rejected', cancels any
 * uncollected shipment, closes open confirmation tasks and records the
 * reason. Refused once a parcel has shipped — use a return after that.
 */
async function cancelOrder(workspaceId, orderId, { reason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({
      where: { id: orderId, workspaceId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!order) throw new NotFoundError('Order');
    if (order.cancelledAt) {
      throw new AppError('ORDER_ALREADY_CANCELLED', 'This order is already cancelled', 409);
    }
    await assertNotShipped(order, transaction);

    const items = await db.OrderItem.findAll({ where: { orderId: order.id }, transaction });
    for (const item of items) {
      if (!item.variantId) continue;
      await inventoryService.release(
        {
          workspaceId,
          variantId: item.variantId,
          quantity: item.quantity,
          referenceType: 'order_cancelled',
          referenceId: order.id,
          actorUserId: req.user.id,
        },
        transaction
      );
    }

    // Cancel any shipment that was created but never collected.
    await db.Shipment.update(
      { status: 'cancelled' },
      { where: { orderId: order.id, status: 'created' }, transaction }
    );

    // Close any confirmation task still in the queue for this order.
    await db.ConfirmationTask.update(
      { status: 'done', outcome: 'rejected', rejectionReason: reason, lockedByUserId: null, lockedAt: null },
      { where: { orderId: order.id, status: ['queued', 'in_progress'] }, transaction }
    );

    const before = { confirmationState: order.confirmationState, cancelledAt: order.cancelledAt };
    await order.update({ cancelledAt: new Date(), cancellationReason: reason }, { transaction });
    if (order.confirmationState !== 'rejected') {
      await setConfirmationState(workspaceId, order.id, 'rejected', req, transaction);
    }

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'order.cancel',
      entityType: 'Order',
      entityId: order.id,
      before,
      after: { cancelledAt: order.cancelledAt, cancellationReason: reason, confirmationState: 'rejected' },
      req,
      transaction,
    });

    return db.Order.findByPk(order.id, { include: [{ model: db.OrderItem, as: 'items' }], transaction });
  });
}

/**
 * The only fields a merchant may edit on an existing order: the shipping
 * address snapshot and the internal notes. Totals, line items and pricing are
 * never touched here. Refused once the order has shipped.
 */
async function updateOrderLimited(workspaceId, orderId, data, req) {
  return db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new NotFoundError('Order');
    if (order.cancelledAt) throw new AppError('ORDER_CANCELLED', 'This order is cancelled', 409);
    await assertNotShipped(order, transaction);

    const before = { shippingAddressSnapshot: order.shippingAddressSnapshot, notes: order.notes };
    const updates = {};
    if (data.shippingAddress !== undefined) updates.shippingAddressSnapshot = data.shippingAddress;
    if (data.notes !== undefined) updates.notes = data.notes;
    await order.update(updates, { transaction });

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'order.update',
      entityType: 'Order',
      entityId: order.id,
      before,
      after: { shippingAddressSnapshot: order.shippingAddressSnapshot, notes: order.notes },
      req,
      transaction,
    });

    return db.Order.findByPk(order.id, { include: [{ model: db.OrderItem, as: 'items' }], transaction });
  });
}

async function listShipments(workspaceId, orderId) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId } });
  if (!order) throw new NotFoundError('Order');
  return db.Shipment.findAll({ where: { workspaceId, orderId }, order: [['createdAt', 'ASC']] });
}

async function createShipment(workspaceId, orderId, data, req) {
  return db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction });
    if (!order) throw new NotFoundError('Order');
    if (order.cancelledAt) throw new AppError('ORDER_CANCELLED', 'This order is cancelled', 409);

    // Generate a `zg`+9-digit code and insert; on the rare unique-index
    // collision under concurrent creation, roll back to a savepoint and retry
    // with a fresh code (same retry-on-collision idea as generateOrderNumber).
    let shipment;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        shipment = await db.sequelize.transaction({ transaction }, (sp) =>
          db.Shipment.create(
            {
              workspaceId,
              orderId: order.id,
              trackingCode: generateTrackingCode(),
              carrierCode: data.carrierCode,
              waybillNumber: data.waybillNumber || null,
              trackingUrl: data.trackingUrl || null,
              status: 'created',
            },
            { transaction: sp }
          )
        );
        break;
      } catch (err) {
        if (err.name === 'SequelizeUniqueConstraintError' && attempt < 5) continue;
        throw err;
      }
    }

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'shipment.create',
      entityType: 'Shipment',
      entityId: shipment.id,
      after: shipment.toJSON(),
      req,
      transaction,
    });

    return shipment;
  });
}

const SHIPMENT_FULFILLMENT = {
  picked_up: 'partially_fulfilled',
  in_transit: 'partially_fulfilled',
  out_for_delivery: 'partially_fulfilled',
  delivered: 'fulfilled',
  returned: 'returned',
};

async function updateShipment(workspaceId, orderId, shipmentId, data, req) {
  return db.sequelize.transaction(async (transaction) => {
    const shipment = await db.Shipment.findOne({ where: { id: shipmentId, workspaceId, orderId }, transaction });
    if (!shipment) throw new NotFoundError('Shipment');
    const before = shipment.toJSON();

    const updates = {};
    if (data.status !== undefined) updates.status = data.status;
    if (data.waybillNumber !== undefined) updates.waybillNumber = data.waybillNumber;
    if (data.trackingUrl !== undefined) updates.trackingUrl = data.trackingUrl;
    if (data.status && SHIPMENT_IN_MOTION.includes(data.status) && !shipment.shippedAt) {
      updates.shippedAt = new Date();
    }
    if (data.status === 'delivered' && !shipment.deliveredAt) updates.deliveredAt = new Date();
    await shipment.update(updates, { transaction });

    // Keep the order's fulfillment state coherent via the state service — the
    // one place allowed to write that column.
    const nextFulfillment = data.status ? SHIPMENT_FULFILLMENT[data.status] : null;
    if (nextFulfillment) {
      await setFulfillmentState(workspaceId, orderId, nextFulfillment, req, transaction);
    }

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'shipment.update',
      entityType: 'Shipment',
      entityId: shipment.id,
      before,
      after: shipment.toJSON(),
      req,
      transaction,
    });

    return shipment;
  });
}

module.exports = {
  createOrder,
  getOrder,
  listOrders,
  generateOrderNumber,
  generateTrackingCode,
  priceLine,
  cancelOrder,
  updateOrderLimited,
  listShipments,
  createShipment,
  updateShipment,
};
