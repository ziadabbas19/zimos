'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { add } = require('../../core/utils/money');
const { normalizePhone } = require('../../core/utils/phone');
const logger = require('../../core/utils/logger');
const fraudRules = require('../fraud/fraudRules');
const platformBlocklist = require('../risk/platformBlocklistService');
const inventoryService = require('../inventory/inventoryService');
const orderStock = require('../inventory/orderStock');
const customerService = require('../customers/customerService');
const discountService = require('../discounts/discountService');
const { calculateShippingAmount } = require('../shipping/shippingPricing');
const { calculateTax } = require('../tax/taxService');
const { completeOrderInTransaction } = require('./orderCompletion');
const { recordAudit } = require('../audit/auditService');
const { setConfirmationState } = require('./orderStateService');
const { STAGES, STAGE_SQL, ORDERS_WITH_STAGE_FROM } = require('./orderStage');
const { orderSort, orderByClause, afterAnchorClause, anchorValue } = require('./orderSort');
const gateways = require('../payments/gateways');
const { assertNotShipped, generateTrackingCode, insertShipment, transitionShipment } = require('./shipmentLifecycle');
const carrierShipmentService = require('../shipping/carrierShipmentService');
const confirmationService = require('../cod/confirmationService');
const { resolveCustomizations, attachUploads } = require('../catalog/customFields');
const { presentOrderItems } = require('../customerUploads/customerUploadService');
const { orderBumpUnavailable } = require('../checkout/orderBump');
const wallet = require('../billing/walletService');

function generateOrderNumber() {
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `ORD-${Date.now().toString(36).toUpperCase()}-${rand}`;
}

// Prices one line from server-side data only. variantId/offerId are looked up
// fresh inside the caller's transaction; any client-sent price is ignored.
//
// `forSale: false` reads a line an order already holds — its variant, product
// or offer may have been archived since — for what it weighs and how it ships
// (recalculateOrder); the caller keeps the prices the order recorded.
async function priceLine(workspaceId, { variantId, offerId, quantity }, transaction, { forSale = true } = {}) {
  const active = forSale ? { status: 'active' } : {};
  const variant = await db.ProductVariant.findOne({
    where: { id: variantId, workspaceId, ...active },
    // A draft or archived product isn't for sale, even if its variant row is active.
    include: [{ model: db.Product, as: 'product', ...(forSale ? { where: { status: 'active' } } : {}) }],
    transaction,
  });
  if (!variant) throw new NotFoundError('ProductVariant');

  if (offerId) {
    const offer = await db.Offer.findOne({
      where: { id: offerId, workspaceId, productId: variant.productId, ...active },
      include: [
        {
          model: db.OfferVariant,
          as: 'lines',
          include: [
            {
              model: db.ProductVariant,
              as: 'variant',
              attributes: ['id', 'weightGrams'],
              include: [{ model: db.Product, as: 'product', attributes: ['productType'] }],
            },
          ],
        },
      ],
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
      customFields: variant.product.customFields || [],
      currency: offer.currency,
      shippingOverride: offer.shippingOverride,
      // One bundle weighs what its offer lines weigh — not the anchor variant.
      weightUnits: offer.lines.map((l) => weightUnit(l.variant, l.quantity)),
      // An offer's lines are all variants of its product, so every unit the
      // bundles hold ships under that product's rule.
      shippingRule: productShippingRule(variant.product, consumedLines.reduce((sum, l) => sum + l.quantity, 0)),
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
    customFields: variant.product.customFields || [],
    currency: variant.currency,
    shippingOverride: null,
    weightUnits: [weightUnit(variant, 1)],
    shippingRule: productShippingRule(variant.product, quantity),
  };
}

// The product's shipping mode for shippingRules.productShipping: `units` is
// how many units of it the line ships.
function productShippingRule(product, units) {
  return { mode: product.shippingMode, extraAmount: product.shippingExtraAmount, units };
}

// One component of a line's unit, for shippingWeight.summarizeWeight.
function weightUnit(variant, quantity) {
  return {
    weightGrams: variant ? variant.weightGrams : null,
    quantity,
    weightless: Boolean(variant && variant.product && variant.product.productType !== 'physical'),
  };
}

/**
 * How the order's shipping amount was reached, kept on the order so the
 * dashboard can say why (and a later change to the store's rates cannot
 * rewrite that). Never read back for pricing: the amount is shippingAmount.
 */
function shippingSnapshot(shipping) {
  return {
    rule: shipping.rule,
    pricingMode: shipping.pricingMode,
    baseAmount: Number(shipping.baseAmount),
    extraFeesAmount: shipping.extraFeesAmount,
    governorate: shipping.governorate,
    freeShippingThresholdAmount: shipping.freeShipping ? shipping.freeShipping.thresholdAmount : null,
  };
}

/**
 * A refused order leaves a trace the merchant can see. Written after the
 * order's transaction has rolled back, on its own connection: an audit row
 * inserted inside that transaction would roll back with it. The customer id
 * is a committed row in every case but one: a first-time buyer refused by a
 * platform blocklist entry, whose customer row was created by this very
 * order and rolled back with it. The entry itself is named in the metadata,
 * so that refusal is still traceable.
 *
 * The actor is the staff member when a platform block refuses an order
 * placed from the dashboard; a storefront refusal has none.
 */
async function recordRefusal(workspaceId, refusal, req) {
  logger.warn(refusal.platformBlock ? 'Order refused by the platform blocklist' : 'Storefront order refused by fraud rules', {
    workspaceId,
    customerId: refusal.customerId,
    flags: refusal.flags,
    platformBlocklistEntryId: refusal.platformBlock ? refusal.platformBlock.id : undefined,
  });
  try {
    await recordAudit({
      workspaceId,
      actorUserId: req && req.user ? req.user.id : null,
      action: 'order.blocked',
      entityType: 'Customer',
      entityId: refusal.customerId,
      after: { flags: refusal.flags },
      metadata: refusal.platformBlock ? platformBlocklist.auditMetadata(refusal.platformBlock) : null,
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
 *
 * `awaitingPayment` places a storefront order that is paid online: it is
 * created unpaid, holding its stock until `expiresAt`, and is NOT completed —
 * no invoice, discount redemption or customer.totalOrders until the payment
 * lands (payments/onlinePaymentService). `tokenHash` is the shopper's status
 * token; `completionContext` ({ cartId, checkoutSessionId }) is kept for the
 * completion step, which also gets the discount to redeem. Fraud rules treat
 * it as an online payment: the blocklist still refuses, any other rule set to
 * "block" only flags.
 *
 * `chargeFee` (default true): the pay-per-order fee (billing/walletService).
 * False for a funnel add-on placed as its own order: one purchase split in two
 * for technical reasons pays one fee (Q14).
 *
 * The platform blocklist (risk/platformBlocklistService) is not a fraud rule
 * and none of the above exempts an order from it: an active entry matching
 * the order's phone, email or shipping address refuses every order — storefront
 * or staff, COD or online, checkout or funnel upsell — whatever the store's
 * own settings say.
 */
async function createOrder(
  workspaceId,
  payload,
  req,
  {
    transaction: outerTransaction,
    skipFraudRules = false,
    awaitingPayment = null,
    customFields = {},
    confirmationAvailableAt = null,
    shippingOverride = null,
    chargeFee = true,
  } = {}
) {
  const { items, contact, shippingAddress, paymentMethod, discountCode, funnelId, websiteId, notes } = payload;

  if (!items || items.length === 0) {
    throw new ValidationError([{ field: 'items', message: 'At least one item is required' }]);
  }

  const evaluateFraudRules = !req.user && !skipFraudRules;

  const run = async (transaction) => {
    // Chosen now so the reservations below can name the order they hold stock
    // for (inventory/orderStock.js releases exactly what they reserved).
    const orderId = crypto.randomUUID();
    const customer = await customerService.findOrCreateByPhone(workspaceId, contact, transaction);

    // An active platform blocklist entry refuses the order outright, in every
    // store and for every caller, before the store's own rules are consulted.
    // The refusal is recorded as a blocked customer ('order.blocked', flag
    // blacklisted_customer, the entry in the metadata); the customer row
    // itself is not touched. Expired entries never match. An order placed
    // before its entry existed is checked again when it would become a sale
    // (payments/onlinePaymentService: switch to COD, a payment landing).
    const platformBlock = await platformBlocklist.findActiveMatch(
      { phoneNormalized: customer.phoneNormalized, email: contact.email, shippingAddress },
      transaction
    );
    if (platformBlock) throw platformBlocklist.rejection(customer.id, platformBlock);

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
        onlinePayment: Boolean(awaitingPayment),
      });
      for (const flag of ruleFlags) if (!riskFlags.includes(flag)) riskFlags.push(flag);
    }

    // Price every line and consume/reserve inventory for it. Consuming
    // inventory inside the same transaction as pricing/order-row creation
    // means a failure anywhere rolls the reservation back too — no orphaned
    // reservations from a half-completed order.
    const pricedLines = [];
    for (const item of items) {
      // The order bump line (checkout/orderBump.js) is added by the server
      // only; staff and cart items never carry the flag. When its offer can
      // no longer be sold, the shopper hears about the add-on, not a generic
      // "not found" / "out of stock".
      const isOrderBump = item.isOrderBump === true;
      const bumpFailure = (err) =>
        isOrderBump && (err instanceof NotFoundError || (err && err.code === 'INSUFFICIENT_STOCK')) ? orderBumpUnavailable() : err;
      const line = await priceLine(workspaceId, item, transaction).catch((err) => {
        throw bumpFailure(err);
      });
      line.isOrderBump = isOrderBump;
      // The shopper's answers to the product's custom fields, checked against
      // its current definition (catalog/customFields.js). Required fields are
      // enforced for the storefront checkout (customFields.enforceRequired);
      // staff and funnel orders have no form for them and may leave them out.
      if (item.customizations || line.customFields.length > 0) {
        line.customizations = await resolveCustomizations(
          { id: line.productId, customFields: line.customFields },
          item.customizations,
          {
            workspaceId,
            visitorId: customFields.visitorId || null,
            cartId: customFields.cartId || null,
            enforceRequired: Boolean(customFields.enforceRequired),
            transaction,
          }
        );
      }
      pricedLines.push(line);
      for (const consumed of line.consumedInventory) {
        await inventoryService
          .reserve(
            {
              workspaceId,
              variantId: consumed.variantId,
              quantity: consumed.quantity,
              referenceType: 'order_pending',
              referenceId: orderId,
              actorUserId: req.user ? req.user.id : null,
            },
            transaction
          )
          .catch((err) => {
            throw bumpFailure(err);
          });
      }
    }

    const subtotal = add(...pricedLines.map((l) => l.lineTotalAmount));
    const productIds = pricedLines.map((l) => l.productId);
    const totalQuantity = pricedLines.reduce((sum, l) => sum + l.quantity, 0);
    // `shippingOverride` (a funnel add-on placed as its own order after the
    // order it follows: the shopper pays shipping once) wins over any offer's.
    const offerShippingOverride = shippingOverride || pricedLines.find((l) => l.shippingOverride)?.shippingOverride || null;

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

    // Always priced, even without an address (amount 0 then): the weight
    // and tier are stored on the order either way.
    const shipping = await calculateShippingAmount(workspaceId, {
      country: shippingAddress ? shippingAddress.country : null,
      region: shippingAddress ? shippingAddress.province : null,
      subtotal,
      totalQuantity,
      offerShippingOverride,
      weightLines: pricedLines.map((l) => ({ quantity: l.quantity, units: l.weightUnits })),
      productLines: pricedLines.map((l) => l.shippingRule),
      transaction,
    });
    const shippingAmount = shipping.amount;

    const { taxAmount } = await calculateTax(workspaceId, {
      country: shippingAddress ? shippingAddress.country : null,
      region: shippingAddress ? shippingAddress.province : null,
      lines: pricedLines.map((l) => ({ productId: l.productId, lineTotal: l.lineTotalAmount })),
      shippingAmount,
    });

    const totalAmount = subtotal - discountAmount + shippingAmount + taxAmount;

    const order = await db.Order.create(
      {
        id: orderId,
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
        totalWeightGrams: shipping.weightGrams,
        weightTierSnapshot: shipping.tier,
        weightEstimated: shipping.weightEstimated,
        shippingSnapshot: shippingSnapshot(shipping),
        ...(awaitingPayment
          ? {
              paymentExpiresAt: awaitingPayment.expiresAt,
              paymentTokenHash: awaitingPayment.tokenHash,
              completionContext: {
                ...(awaitingPayment.completionContext || {}),
                discount: discountRecord ? { discountId: discountRecord.id, amountAllocated: discountAmount } : null,
              },
            }
          : {}),
      },
      { transaction }
    );

    // Sequential, not Promise.all — see note in workspaceService: one
    // transaction = one pooled connection, so concurrent queries on it are unsafe.
    const orderItems = [];
    for (const [index, line] of pricedLines.entries()) {
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
            unitWeightGrams: shipping.lineWeights[index],
            customizations: line.customizations || null,
            isOrderBump: line.isOrderBump,
          },
          { transaction }
        )
      );
      // The line's photos now belong to the order: attached, no longer expiring.
      await attachUploads(line.customizations, orderItems[orderItems.length - 1].id, transaction);
    }

    if (paymentMethod === 'cod') {
      // `confirmationAvailableAt`: a funnel order waits for the funnel's offer
      // window before anyone may confirm it (funnels/funnelOfferMerge.js).
      await db.ConfirmationTask.create(
        { workspaceId, orderId: order.id, status: 'queued', availableAt: confirmationAvailableAt || null },
        { transaction }
      );
    }

    order.items = orderItems;
    // Invoice, discount redemption, customer.totalOrders — the order is a
    // sale from this moment (see orderCompletion.js). An order paid online
    // becomes one when its payment lands.
    if (!awaitingPayment) {
      await completeOrderInTransaction(
        order,
        { discount: discountRecord ? { discountId: discountRecord.id, amountAllocated: discountAmount } : null },
        transaction
      );
    }

    // The pay-per-order fee, after Order.create and as this transaction's
    // last lock (billing/walletService). Refused past the overdraft, which
    // rolls the whole order back: 402 in the dashboard, 423 for a shopper.
    if (chargeFee) await wallet.chargeOrderFee(order, { staff: Boolean(req.user) }, transaction);

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
 * Adds one line to an order that is still open — a funnel upsell or downsell
 * the shopper accepted while the order waited in its offer window
 * (funnels/funnelOfferMerge.js) — and prices the whole order again, exactly as
 * createOrder would have priced it with that line in it: subtotal, the code's
 * discount on the new subtotal, shipping (the weight may move it to another
 * tier; the subtotal may reach free shipping), tax, total. The new line is
 * priced from its offer on the server and its stock reserved here; the lines
 * already in the order keep the prices they were sold at.
 *
 * `order` must be locked FOR UPDATE by the caller, in `transaction`, and
 * checked to still be open (pending confirmation, not paid, not shipped). The
 * invoice issued when the order was placed is brought up to the new total and
 * lines in place — same number — so the invoice always equals the order; the
 * discount redemption is updated to the new amount.
 *
 * @returns {Promise<{ order, item, before }>} before: the totals it replaced
 */
async function addLineToOpenOrder(workspaceId, order, lineInput, { isUpsell = false, actorUserId = null } = {}, transaction) {
  const before = {
    subtotalAmount: Number(order.subtotalAmount),
    discountAmount: Number(order.discountAmount),
    shippingAmount: Number(order.shippingAmount),
    taxAmount: Number(order.taxAmount),
    totalAmount: Number(order.totalAmount),
    totalWeightGrams: order.totalWeightGrams,
  };

  const existing = await db.OrderItem.findAll({ where: { orderId: order.id }, order: [['createdAt', 'ASC'], ['id', 'ASC']], transaction });
  const newLine = await priceLine(workspaceId, lineInput, transaction);
  for (const consumed of newLine.consumedInventory) {
    await inventoryService.reserve(
      {
        workspaceId,
        variantId: consumed.variantId,
        quantity: consumed.quantity,
        referenceType: 'order_upsell',
        referenceId: order.id,
        actorUserId,
      },
      transaction
    );
  }

  // What the lines already in the order weigh and how they ship, from the
  // catalogue; their amounts stay as sold.
  const lines = [];
  for (const item of existing) {
    const facts = item.variantId
      ? await priceLine(
          workspaceId,
          { variantId: item.variantId, offerId: item.offerId, quantity: item.quantity },
          transaction,
          { forSale: false }
        ).catch(() => null)
      : null;
    lines.push({
      productId: item.productId,
      quantity: item.quantity,
      lineTotalAmount: Number(item.lineTotalAmount),
      shippingOverride: facts ? facts.shippingOverride : null,
      // A line whose catalogue rows are gone ships at the weight it was sold at.
      weightUnits: facts
        ? facts.weightUnits
        : [{ weightGrams: item.unitWeightGrams === null ? null : Number(item.unitWeightGrams), quantity: 1, weightless: false }],
      shippingRule: facts ? facts.shippingRule : productShippingRule({}, item.quantity),
    });
  }
  lines.push({ ...newLine, lineTotalAmount: Number(newLine.lineTotalAmount) });

  const subtotal = add(...lines.map((l) => l.lineTotalAmount));
  const totalQuantity = lines.reduce((sum, l) => sum + l.quantity, 0);
  const offerShippingOverride = lines.find((l) => l.shippingOverride)?.shippingOverride || null;

  // The code the order was placed with, on the new subtotal. It was checked
  // and redeemed when the order was placed and is not checked again.
  let discountAmount = before.discountAmount;
  let discountsSnapshot = order.discountsSnapshot || [];
  const redemption = await db.DiscountRedemption.findOne({ where: { orderId: order.id }, transaction });
  if (redemption) {
    const discount = await db.Discount.findByPk(redemption.discountId, { transaction });
    if (discount) {
      discountAmount = discountService.amountFor(discount, subtotal);
      discountsSnapshot = discountsSnapshot.map((d) => (d.code === discount.code ? { ...d, amount: discountAmount } : d));
      await redemption.update({ amountAllocated: discountAmount }, { transaction });
    }
  }

  const address = order.shippingAddressSnapshot || null;
  const shipping = await calculateShippingAmount(workspaceId, {
    country: address ? address.country : null,
    region: address ? address.province : null,
    subtotal,
    totalQuantity,
    offerShippingOverride,
    weightLines: lines.map((l) => ({ quantity: l.quantity, units: l.weightUnits })),
    productLines: lines.map((l) => l.shippingRule),
    transaction,
  });
  const { taxAmount } = await calculateTax(workspaceId, {
    country: address ? address.country : null,
    region: address ? address.province : null,
    lines: lines.map((l) => ({ productId: l.productId, lineTotal: l.lineTotalAmount })),
    shippingAmount: shipping.amount,
  });
  const totalAmount = subtotal - discountAmount + shipping.amount + taxAmount;

  const item = await db.OrderItem.create(
    {
      orderId: order.id,
      productId: newLine.productId,
      variantId: newLine.variantId,
      offerId: newLine.offerId,
      productNameSnapshot: newLine.productName,
      variantOptionsSnapshot: newLine.variantOptions,
      skuSnapshot: newLine.sku,
      offerNameSnapshot: newLine.offerName,
      quantity: newLine.quantity,
      unitPriceAmount: newLine.unitPriceAmount,
      unitCostAmount: newLine.unitCostAmount,
      lineTotalAmount: newLine.lineTotalAmount,
      unitWeightGrams: shipping.lineWeights[lines.length - 1],
      isUpsell,
    },
    { transaction }
  );

  await order.update(
    {
      subtotalAmount: subtotal,
      discountAmount,
      discountsSnapshot,
      shippingAmount: shipping.amount,
      taxAmount,
      totalAmount,
      totalWeightGrams: shipping.weightGrams,
      weightTierSnapshot: shipping.tier,
      weightEstimated: shipping.weightEstimated,
      shippingSnapshot: shippingSnapshot(shipping),
    },
    { transaction }
  );

  // The invoice issued with the order follows it: same number, new lines and total.
  const items = [...existing, item];
  const invoice = await db.Invoice.findOne({ where: { orderId: order.id }, order: [['issuedAt', 'DESC']], transaction });
  if (invoice) {
    await invoice.update(
      {
        totalAmount,
        lineItems: items.map((i) => ({
          name: i.productNameSnapshot,
          quantity: i.quantity,
          unitPriceAmount: i.unitPriceAmount,
          lineTotalAmount: i.lineTotalAmount,
        })),
      },
      { transaction }
    );
  }

  order.items = items;
  return { order, item, before };
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
      { model: db.Refund, as: 'refunds' },
      { model: db.Shipment, as: 'shipments' },
    ],
    order: [
      [{ model: db.Payment, as: 'payments' }, 'createdAt', 'ASC'],
      [{ model: db.Refund, as: 'refunds' }, 'createdAt', 'ASC'],
    ],
  });
  if (!order) throw new NotFoundError('Order');
  const providers = await paymentProviders([order]);
  const json = order.toJSON();
  // Shoppers' photos are shown through short-lived signed links, made per read.
  await presentOrderItems(workspaceId, json.items);
  // A funnel offer the shopper took after this order had left its offer
  // window is an order of its own: both ends name the other.
  const linkedOrders = await db.Order.findAll({
    where: { workspaceId, linkedFromOrderId: order.id },
    attributes: ['id', 'orderNumber', 'totalAmount', 'currency', 'createdAt'],
    order: [['createdAt', 'ASC']],
  });
  const linkedFrom = order.linkedFromOrderId
    ? await db.Order.findOne({ where: { workspaceId, id: order.linkedFromOrderId }, attributes: ['id', 'orderNumber'] })
    : null;
  return {
    ...json,
    paymentProvider: providers.get(order.id) || null,
    stage: await stageForOrder(order.id),
    confirmationTask: await confirmationService.taskSummaryForOrder(workspaceId, order.id),
    linkedOrders: linkedOrders.map((o) => o.toJSON()),
    linkedFromOrder: linkedFrom ? linkedFrom.toJSON() : null,
  };
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
 * to the row the keyset pages on: its (created_at, id), or (total_amount, id)
 * for a sort by total.
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
    attributes: ['id', 'createdAt', 'totalAmount'],
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
  const providers = await paymentProviders(rows);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return page
    .filter((row) => byId.has(row.id))
    .map((row) => ({
      ...byId.get(row.id).toJSON(),
      stage: row.stage,
      paymentProvider: providers.get(row.id) || null,
    }));
}

/**
 * The gateway each online order is paid through: its latest attempt's
 * provider. Cash on delivery (including an online order the shopper switched
 * to COD) has none. One query for the page.
 */
async function paymentProviders(orders) {
  const online = orders.filter((o) => o.paymentMethod === 'card' || o.paymentMethod === 'wallet').map((o) => o.id);
  if (online.length === 0) return new Map();
  const rows = await db.sequelize.query(
    `SELECT DISTINCT ON (order_id) order_id, provider_code
       FROM payments
      WHERE order_id IN (:ids) AND provider_code IN (:gateways)
      ORDER BY order_id, created_at DESC, id DESC`,
    {
      replacements: { ids: online, gateways: gateways.listAdapters().map((a) => a.code) },
      type: QueryTypes.SELECT,
    }
  );
  return new Map(rows.map((r) => [r.order_id, r.provider_code]));
}

/**
 * The merchant orders list: one workspace's orders, newest first unless
 * `sort` says otherwise (orderSort.js: newest, oldest, total_desc, total_asc).
 *
 * Paging is keyset, not offset: `cursor` carries the last order id of the
 * previous page and the query asks for rows strictly after that order's
 * (sort value, id) pair in the sort's direction — for the default, strictly
 * before its (created_at, id). Orders arrive constantly, and an OFFSET page
 * would skip or repeat rows every time one lands while the merchant is paging.
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
  { limit = 50, cursor, sort: sortKey, confirmationState, financialState, fulfillmentState, stage, q, from, to } = {}
) {
  const { conditions, bind } = orderListConditions(workspaceId, {
    confirmationState,
    financialState,
    fulfillmentState,
    stage,
    q,
    from,
    to,
  });
  bind.limit = limit + 1;
  const sort = orderSort(sortKey);

  if (cursor) {
    const anchor = await resolveCursor(workspaceId, cursor);
    // Row-wise comparison rather than (created_at < x OR (created_at = x AND
    // id < y)): it says the same thing and maps straight onto the
    // (workspace_id, created_at DESC, id DESC) index — or, sorted by total,
    // the (workspace_id, total_amount DESC, id DESC) one (migration 116).
    conditions.push(afterAnchorClause(sort, 'o.id', 'cursorValue', 'cursorId'));
    bind.cursorValue = anchorValue(sort, anchor);
    bind.cursorId = anchor.id;
  }

  const rows = await db.sequelize.query(
    `SELECT o.id, ${STAGE_SQL} AS stage
       FROM ${ORDERS_WITH_STAGE_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderByClause(sort, 'o.id')}
      LIMIT $limit`,
    { bind, type: QueryTypes.SELECT }
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const orders = await hydrateOrders(page);
  return { orders, nextCursor: hasMore ? page[page.length - 1].id : null };
}

/**
 * The orders list's filters as SQL conditions over `o` (with the stage join),
 * shared with the CSV export (orderExportService) so a file and the screen
 * can never disagree about which orders match. Bind parameters only.
 */
function orderListConditions(
  workspaceId,
  { confirmationState, financialState, fulfillmentState, stage, q, from, to } = {}
) {
  const conditions = ['o.workspace_id = $workspaceId'];
  const bind = { workspaceId };

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
  return { conditions, bind };
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
async function cancelOrder(workspaceId, orderId, { reason, acknowledgeManualCancel = false }, req) {
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

    // Whatever the order still holds: nothing more if a rejection already gave it back.
    await orderStock.releaseOrderStock(
      { workspaceId, orderId: order.id, referenceType: 'order_cancelled', actorUserId: req.user.id },
      transaction
    );

    // A shipment booked with a connected courier is cancelled there first. If
    // the courier refuses, this throws and the whole cancellation rolls back:
    // the order must not say "cancelled" while a courier still plans to
    // collect the parcel. A courier without a cancel API needs the
    // merchant's acknowledgeManualCancel (409 CARRIER_MANUAL_CANCEL_REQUIRED).
    await carrierShipmentService.cancelCarrierShipmentsForOrder(workspaceId, order.id, transaction, {
      acknowledgeManualCancel,
      req,
      trigger: 'order_cancel',
    });

    // Cancel any shipment that was created but never collected.
    await db.Shipment.update(
      { status: 'cancelled' },
      { where: { orderId: order.id, status: 'created' }, transaction }
    );

    // Close any confirmation task still in the queue for this order, recorded
    // as an order-page rejection so the queue's Done tab shows who and why.
    await confirmationService.closeTasksForCancelledOrder(workspaceId, order.id, reason, req, transaction);

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
    // The pay-per-order fee goes back to the store (the last lock taken here).
    await wallet.reverseOrderFee(order, { reason: 'order_cancelled', actorUserId: req.user.id }, transaction);

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
  // merchant's account. Everything else is a manual shipment — a local record
  // only, the merchant types the waybill in; a manual name that spells a
  // courier ("Bosta") is refused with 422 there.
  if (await carrierShipmentService.shouldBookWithCarrier(workspaceId, data)) {
    return carrierShipmentService.createCarrierShipment(workspaceId, orderId, data, req);
  }

  return db.sequelize.transaction(async (transaction) => {
    // Locked so two concurrent requests can't both pass the one-active-
    // shipment check below.
    const order = await db.Order.findOne({
      where: { id: orderId, workspaceId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!order) throw new NotFoundError('Order');
    carrierShipmentService.assertConfirmedOrPaid(order);
    await carrierShipmentService.assertNoActiveShipment(order.id, transaction);

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
    // Cancelling a booking whose courier has no cancel API needs the
    // merchant's acknowledgeManualCancel; a final status stops polling.
    const extra = carrierShipmentService.manualCancelUpdates(shipment, data, req);
    if (!extra.cancelMode && carrierShipmentService.TERMINAL_STATUSES.includes(data.status) && shipment.nextPollAt) {
      extra.nextPollAt = null;
    }
    // The stamps, fulfillment state and audit row live in shipmentLifecycle,
    // shared with the carrier status updates.
    return transitionShipment(
      workspaceId,
      shipment,
      { status: data.status, waybillNumber: data.waybillNumber, trackingUrl: data.trackingUrl, ...extra },
      { transaction, req, actorUserId: req.user.id }
    );
  });
}

module.exports = {
  createOrder,
  addLineToOpenOrder,
  getOrder,
  listOrders,
  orderListConditions,
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
