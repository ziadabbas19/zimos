'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { add } = require('../../core/utils/money');
const { normalizePhone } = require('../../core/utils/phone');
const logger = require('../../core/utils/logger');
const fraudRules = require('../fraud/fraudRules');
const inventoryService = require('../inventory/inventoryService');
const customerService = require('../customers/customerService');
const discountService = require('../discounts/discountService');
const { calculateShippingAmount } = require('../shipping/shippingPricing');
const { calculateTax } = require('../tax/taxService');
const { createInvoiceForOrder } = require('../invoices/invoiceService');
const { recordAudit } = require('../audit/auditService');
const { setConfirmationState } = require('./orderStateService');
const { STAGES, STAGE_SQL, ORDERS_WITH_STAGE_FROM } = require('./orderStage');
const { SHIPMENT_IN_MOTION, generateTrackingCode, insertShipment, transitionShipment } = require('./shipmentLifecycle');
const carrierShipmentService = require('../shipping/carrierShipmentService');

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

/**
 * A refused storefront order leaves a trace the merchant can see. Written
 * after the order's transaction has rolled back, on its own connection: an
 * audit row inserted inside that transaction would roll back with it. The
 * customer id is always a committed row here — every refusal needs a
 * blacklist flag, past orders or past rejections, none of which a customer
 * created by this very checkout can have.
 */
async function recordRefusal(workspaceId, refusal, req) {
  logger.warn('Storefront order refused by fraud rules', {
    workspaceId,
    customerId: refusal.customerId,
    flags: refusal.flags,
  });
  try {
    await recordAudit({
      workspaceId,
      actorUserId: null,
      action: 'order.blocked',
      entityType: 'Customer',
      entityId: refusal.customerId,
      after: { flags: refusal.flags },
      req,
    });
  } catch (err) {
    // The buyer still gets the refusal; a failed audit write must not turn
    // it into a 500.
    logger.error('Could not audit a refused order', { workspaceId, message: err.message });
  }
}

/**
 * `skipFraudRules` exempts an order from the storefront fraud rules. It is for
 * funnel follow-on orders (funnelsService.createFollowOnOrder): an accepted
 * upsell is the same buyer adding to the order they just placed, so it would
 * always trip duplicate_order. Staff orders (req.user set) are never
 * evaluated and need no option.
 */
async function createOrder(workspaceId, payload, req, { transaction: outerTransaction, skipFraudRules = false } = {}) {
  const { items, contact, shippingAddress, paymentMethod, discountCode, funnelId, websiteId, notes } = payload;

  if (!items || items.length === 0) {
    throw new ValidationError([{ field: 'items', message: 'At least one item is required' }]);
  }

  const evaluateFraudRules = !req.user && !skipFraudRules;

  const run = async (transaction) => {
    const customer = await customerService.findOrCreateByPhone(workspaceId, contact, transaction);

    const riskFlags = [];
    if (customer.isBlacklisted) riskFlags.push('blacklisted_customer');

    // Before any inventory is touched, so a refusal has nothing to undo but
    // the customer lookup.
    if (evaluateFraudRules) {
      const ruleFlags = await fraudRules.evaluateStorefrontOrder({
        workspaceId,
        customer,
        variantIds: [...new Set(items.map((item) => item.variantId).filter(Boolean))],
        transaction,
      });
      for (const flag of ruleFlags) if (!riskFlags.includes(flag)) riskFlags.push(flag);
    }

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
  };

  // Joining the caller's transaction rather than opening our own keeps the
  // order atomic with whatever that caller is doing — see
  // funnels/funnelsService.advanceSession, where an accepted upsell must
  // commit with the session move or not at all. A nested
  // sequelize.transaction() would take a second connection and could block on
  // rows the caller has already locked.
  try {
    return await (outerTransaction ? run(outerTransaction) : db.sequelize.transaction(run));
  } catch (err) {
    if (err instanceof fraudRules.OrderRejectedError) await recordRefusal(workspaceId, err.refusal, req);
    throw err;
  }
}

/**
 * The order's derived stage. One row, the same expression the list and the
 * counts use — see orderStage.js for why it is derived and not stored.
 */
async function stageForOrder(orderId) {
  const rows = await db.sequelize.query(
    `SELECT ${STAGE_SQL} AS stage
       FROM ${ORDERS_WITH_STAGE_FROM}
      WHERE o.id = $orderId`,
    { bind: { orderId }, type: QueryTypes.SELECT }
  );
  return rows.length > 0 ? rows[0].stage : null;
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
  return { ...order.toJSON(), stage: await stageForOrder(order.id) };
}

// `%` and `_` are wildcards in LIKE, and a backslash escapes them: a merchant
// searching for "50%_off" must not get a pattern that matches everything.
// Postgres' default LIKE escape character is the backslash, so escaping with
// one needs no ESCAPE clause.
const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * The search box and the date range, as SQL conditions.
 *
 * `q` matches the four things a merchant has in front of them when they go
 * looking for an order: the order number (with or without the '#' the UI
 * prints), the customer's name, their email, or their phone. Every arm is
 * a bind parameter; nothing the client sends is ever concatenated into SQL.
 *
 * The three text arms compare through zimos_normalize_search (migration 088),
 * which lowercases and folds the Arabic letters people type interchangeably —
 * the alef forms, taa marbuta for haa, alef maqsura for yaa — and drops
 * tashkeel and tatweel. Without it "احمد" never finds "أحمد", which is the
 * normal case here, not the exotic one. The stored side and the typed term go
 * through the same function *in SQL*: normalizing the term in JS instead would
 * be a second implementation of the rule, and the day the two disagreed the
 * search would quietly return nothing rather than fail. It is also exactly the
 * expression the three GIN trigram indexes are built on, which is what lets
 * the planner use them.
 *
 * The phone arm compares the last ten digits of both sides, which is what
 * makes 01012345678, +201012345678 and 201012345678 all find the same order:
 * strip the punctuation and the country code and Egyptian mobile numbers
 * agree from there on. It only runs when the input actually has ten digits to
 * compare — normalizePhone turns anything shorter into a country code with a
 * stub behind it, which would match arbitrary orders.
 *
 * Dates filter on created_at, and `to` is inclusive of the whole UTC day it
 * names: a merchant picking "1 Jan to 31 Jan" means the end of the 31st, not
 * its first instant. UTC, not the workspace's timezone — `Workspace.timezone`
 * exists but nothing in the codebase reads it, and every other date bucket
 * here (see platformAdmin/overviewMetricsService) is UTC. Making this one
 * endpoint local time would be the odd one out, not the fix.
 */
function applySearchAndDates(conditions, bind, { q, from, to }) {
  if (q) {
    const term = q.trim();
    const arms = [];

    bind.qNumber = `%${escapeLike(term.replace(/^#/, ''))}%`;
    arms.push('zimos_normalize_search(o.order_number) LIKE zimos_normalize_search($qNumber)');

    bind.qText = `%${escapeLike(term)}%`;
    arms.push("zimos_normalize_search(o.contact_snapshot->>'fullName') LIKE zimos_normalize_search($qText)");
    arms.push("zimos_normalize_search(o.contact_snapshot->>'email') LIKE zimos_normalize_search($qText)");

    const digits = term.replace(/\D/g, '');
    if (digits.length >= 10) {
      bind.qPhone = normalizePhone(term).slice(-10);
      arms.push(
        "right(regexp_replace(coalesce(o.contact_snapshot->>'phone', ''), '[^0-9]', '', 'g'), 10) = $qPhone"
      );
    }

    conditions.push(`(${arms.join(' OR ')})`);
  }

  if (from) {
    conditions.push('o.created_at >= $from::timestamptz');
    bind.from = new Date(from).toISOString();
  }
  if (to) {
    const day = new Date(to);
    conditions.push('o.created_at < $toExclusive::timestamptz');
    bind.toExclusive = new Date(
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1)
    ).toISOString();
  }
}

/**
 * Resolves an opaque list cursor — the last order id of the previous page —
 * to the (created_at, id) pair the keyset pages on.
 *
 * The id has to be looked up inside the workspace rather than trusted: an id
 * from another merchant's workspace would otherwise silently anchor the page
 * at that order's timestamp. Unknown or foreign ids are a bad query
 * parameter, so they fail as a validation error on `cursor` rather than a
 * 404 about an order the caller never asked for.
 */
async function resolveCursor(workspaceId, cursor, field = 'cursor') {
  const anchor = await db.Order.findOne({
    where: { id: cursor, workspaceId },
    attributes: ['id', 'createdAt'],
  });
  if (!anchor) {
    throw new ValidationError(
      [{ field, message: 'Cursor does not point at an order in this workspace' }],
      'Invalid query'
    );
  }
  return anchor;
}

/**
 * Loads full orders for a page of ids, in exactly the order the ids came in,
 * each carrying the stage the page query already worked out for it.
 */
async function hydrateOrders(page) {
  if (page.length === 0) return [];
  const rows = await db.Order.findAll({
    where: { id: page.map((row) => row.id) },
    include: [{ model: db.OrderItem, as: 'items' }],
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return page
    .filter((row) => byId.has(row.id))
    .map((row) => ({ ...byId.get(row.id).toJSON(), stage: row.stage }));
}

/**
 * The merchant orders list: one workspace's orders, newest first.
 *
 * Paging is keyset, not offset: `cursor` carries the last order id of the
 * previous page and the query asks for rows strictly before that order's
 * (created_at, id) pair. Orders arrive constantly, and an OFFSET page would
 * skip or repeat rows every time one lands while the merchant is paging.
 *
 * The page is picked in SQL and hydrated separately. A single Sequelize
 * findAll cannot do it: the row-wise keyset comparison, the derived stage and
 * the search predicates are all SQL expressions, and mixing them with a
 * hasMany include makes Sequelize wrap the query in a subquery whose shape
 * decides where those expressions land. Selecting ids first keeps the
 * filtering explicit and the hydration a plain findAll.
 */
async function listOrders(
  workspaceId,
  { limit = 50, cursor, confirmationState, financialState, fulfillmentState, stage, q, from, to } = {}
) {
  const conditions = ['o.workspace_id = $workspaceId'];
  const bind = { workspaceId, limit: limit + 1 };

  if (confirmationState) {
    conditions.push('o.confirmation_state = $confirmationState');
    bind.confirmationState = confirmationState;
  }
  if (financialState) {
    conditions.push('o.financial_state = $financialState');
    bind.financialState = financialState;
  }
  if (fulfillmentState) {
    conditions.push('o.fulfillment_state = $fulfillmentState');
    bind.fulfillmentState = fulfillmentState;
  }
  if (stage) {
    // The same expression the tab counts group by, so a tab's count and the
    // rows behind the tab can never be two different answers.
    conditions.push(`${STAGE_SQL} = $stage`);
    bind.stage = stage;
  }
  applySearchAndDates(conditions, bind, { q, from, to });

  if (cursor) {
    const anchor = await resolveCursor(workspaceId, cursor);
    // Row-wise comparison rather than (created_at < x OR (created_at = x AND
    // id < y)): it says the same thing and maps straight onto the
    // (workspace_id, created_at DESC, id DESC) index.
    conditions.push('(o.created_at, o.id) < ($cursorCreatedAt::timestamptz, $cursorId::uuid)');
    bind.cursorCreatedAt = anchor.createdAt.toISOString();
    bind.cursorId = anchor.id;
  }

  const rows = await db.sequelize.query(
    `SELECT o.id, ${STAGE_SQL} AS stage
       FROM ${ORDERS_WITH_STAGE_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $limit`,
    { bind, type: QueryTypes.SELECT }
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const orders = await hydrateOrders(page);
  return { orders, nextCursor: hasMore ? page[page.length - 1].id : null };
}

/**
 * The tab counts above the orders list: how many orders sit in each stage
 * right now, under the same `q` / `from` / `to` the merchant has typed.
 *
 * One GROUP BY over the one stage expression — not nine COUNT queries, and
 * not a second copy of the mapping. Every key is present in the answer even
 * at zero, so the client renders a stable row of tabs instead of tabs that
 * appear and vanish as orders move.
 */
async function orderPipeline(workspaceId, { q, from, to } = {}) {
  const conditions = ['o.workspace_id = $workspaceId'];
  const bind = { workspaceId };
  applySearchAndDates(conditions, bind, { q, from, to });

  const rows = await db.sequelize.query(
    `SELECT ${STAGE_SQL} AS stage, COUNT(*)::int AS count
       FROM ${ORDERS_WITH_STAGE_FROM}
      WHERE ${conditions.join(' AND ')}
      GROUP BY 1`,
    { bind, type: QueryTypes.SELECT }
  );

  const stages = Object.fromEntries(STAGES.map((key) => [key, 0]));
  let total = 0;
  for (const row of rows) {
    stages[row.stage] = row.count;
    total += row.count;
  }
  return { stages, total };
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

    // A shipment booked with a connected courier is cancelled there first. If
    // the courier refuses, this throws and the whole cancellation rolls back:
    // the order must not say "cancelled" while a courier still plans to
    // collect the parcel.
    await carrierShipmentService.cancelCarrierShipmentsForOrder(workspaceId, order.id, transaction);

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
  // A carrier this workspace has connected (Bosta, ...) is booked through the
  // merchant's account; 'manual' and any other code keep the original
  // behaviour below — the merchant types the waybill in.
  if (await carrierShipmentService.shouldBookWithCarrier(workspaceId, data.carrierCode)) {
    return carrierShipmentService.createCarrierShipment(workspaceId, orderId, data, req);
  }

  return db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction });
    if (!order) throw new NotFoundError('Order');
    if (order.cancelledAt) throw new AppError('ORDER_CANCELLED', 'This order is cancelled', 409);

    const shipment = await insertShipment(
      {
        workspaceId,
        orderId: order.id,
        carrierCode: data.carrierCode,
        waybillNumber: data.waybillNumber || null,
        trackingUrl: data.trackingUrl || null,
        status: 'created',
      },
      transaction
    );

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

async function updateShipment(workspaceId, orderId, shipmentId, data, req) {
  return db.sequelize.transaction(async (transaction) => {
    const shipment = await db.Shipment.findOne({ where: { id: shipmentId, workspaceId, orderId }, transaction });
    if (!shipment) throw new NotFoundError('Shipment');
    // The stamps, fulfillment state and audit row live in shipmentLifecycle,
    // shared with the carrier status updates.
    return transitionShipment(
      workspaceId,
      shipment,
      { status: data.status, waybillNumber: data.waybillNumber, trackingUrl: data.trackingUrl },
      { transaction, req, actorUserId: req.user.id }
    );
  });
}

module.exports = {
  createOrder,
  getOrder,
  listOrders,
  orderPipeline,
  resolveCursor,
  generateOrderNumber,
  generateTrackingCode,
  priceLine,
  cancelOrder,
  updateOrderLimited,
  listShipments,
  createShipment,
  updateShipment,
};
