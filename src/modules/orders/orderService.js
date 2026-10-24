'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const storePickup = require('../shipping/storePickup');
const deliveryZones = require('../shipping/deliveryZones');
const storeHours = require('../shipping/storeHours');
const { DESTINATION_INDEPENDENT } = require('../shipping/shippingRules');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { add } = require('../../core/utils/money');
const { normalizePhone } = require('../../core/utils/phone');
const { storeFeatureOn } = require('../../core/middleware/storeFeatures');
const logger = require('../../core/utils/logger');
const fraudRules = require('../fraud/fraudRules');
const blockedEntries = require('../fraud/blockedEntries');
const visitorGate = require('../risk/visitorGate');
const riskService = require('../risk/riskService');
const aiOrderCheck = require('../risk/aiOrderCheck');
const checkoutOtp = require('../risk/checkoutOtp');
const platformBlocklist = require('../risk/platformBlocklistService');
const inventoryService = require('../inventory/inventoryService');
const orderStock = require('../inventory/orderStock');
const customerService = require('../customers/customerService');
const discountService = require('../discounts/discountService');
const { calculateShippingAmount } = require('../shipping/shippingPricing');
const { calculateTax, taxableLines } = require('../tax/taxService');
const { completeOrderInTransaction } = require('./orderCompletion');
const { recordAudit } = require('../audit/auditService');
const { setConfirmationState, trackStage, nextStages } = require('./orderStateService');
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
const orderLock = require('./orderLock');
const outbox = require('../../core/outbox/outbox');
const orderMeta = require('./orderMetaService');
const { applyOrderFilters } = require('./orderFilters');
const { effectiveVariantPrice } = require('../catalog/productPage');
const { applyBundleTiers } = require('../bundles/bundlePricing');
const pixelMatching = require('../marketing/pixelMatching');

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
async function priceLine(workspaceId, line, transaction, { forSale = true } = {}) {
  const { variantId, offerId, quantity, customizations } = line;
  const active = forSale ? { status: 'active' } : {};
  const variant = await db.ProductVariant.findOne({
    where: { id: variantId, workspaceId, ...active },
    // A draft or archived product isn't for sale, even if its variant row is active.
    include: [{ model: db.Product, as: 'product', ...(forSale ? { where: { status: 'active' } } : {}) }],
    transaction,
  });
  if (!variant) throw new NotFoundError('ProductVariant');
  // Priced custom fields the shopper filled in add to the unit price (catalog/customFieldPricing.js).
  const customDelta = require('../catalog/customFieldPricing').customFieldsDelta(variant.product.customFields, customizations);
  // Menu options (catalog/menuOptions.js): checked against the product's menu and priced from the
  // database only. Required groups bind the shopper's own orders (enforceRequiredOptions). A line an
  // order already holds (forSale false) keeps the prices it recorded, so its menu is not read again.
  const options = forSale
    ? await require('../catalog/menuOptions').resolveSelection(workspaceId, variant.productId, line.options, {
        enforceRequired: Boolean(line.enforceRequiredOptions),
        transaction,
      })
    : { snapshot: null, deltaPerUnit: 0 };
  const fieldsDelta = customDelta + options.deltaPerUnit;

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

    // A one-line offer taken in another variant of its product (the shopper's choice,
    // offers/offerVariantChoice.js) holds that variant's stock; a bundle keeps its own lines.
    const consumedLines =
      offer.lines.length === 1 && offer.lines[0].variantId !== variant.id
        ? [{ variantId: variant.id, quantity: offer.lines[0].quantity * quantity }]
        : offer.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity * quantity }));
    const unitPrice = fieldsDelta ? Number(offer.priceAmount) + fieldsDelta : offer.priceAmount;
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
      optionsSnapshot: options.snapshot,
      currency: offer.currency,
      shippingOverride: offer.shippingOverride,
      // One bundle weighs what its offer lines weigh — not the anchor variant.
      weightUnits: offer.lines.map((l) => weightUnit(l.variant, l.quantity)),
      // An offer's lines are all variants of its product, so every unit the
      // bundles hold ships under that product's rule.
      shippingRule: productShippingRule(variant.product, consumedLines.reduce((sum, l) => sum + l.quantity, 0)),
    };
  }

  // A countdown offer that has ended sells at the full price (catalog/productPage.js).
  // A product A/B test's price for this shopper, pinned by the server (catalog/productTests.js).
  const testPrice = require('../catalog/productTests').testPriceOf(line);
  const listUnit = testPrice !== undefined ? testPrice : effectiveVariantPrice(variant, variant.product).priceAmount;
  const unitPriceAmount = fieldsDelta ? Number(listUnit) + fieldsDelta : listUnit;
  const lineTotal = unitPriceAmount * quantity;
  return {
    productId: variant.productId,
    productName: variant.product.name,
    variantId: variant.id,
    variantOptions: variant.optionValues,
    sku: variant.sku,
    offerId: null,
    offerName: null,
    quantity,
    unitPriceAmount,
    unitCostAmount: variant.costAmount,
    lineTotalAmount: lineTotal,
    consumedInventory: [{ variantId: variant.id, quantity }],
    customFields: variant.product.customFields || [],
    optionsSnapshot: options.snapshot,
    currency: variant.currency,
    shippingOverride: null,
    weightUnits: [weightUnit(variant, 1)],
    shippingRule: productShippingRule(variant.product, quantity),
  };
}

// The product's shipping mode for shippingRules.productShipping: `units` is
// how many units of it the line ships.
// Whether the order was placed with a free-shipping code: it ships free even when an offer
// in it sets its own shipping price, also when a line joins later or its items are edited.
function couponShipsFree(order) {
  return Boolean(order.shippingSnapshot && order.shippingSnapshot.freeShippingGranted === true) &&
    (order.discountsSnapshot || []).some((d) => d && d.kind !== 'bundle' && d.type === 'free_shipping');
}

function productShippingRule(product, units) {
  return { mode: product.shippingMode, extraAmount: product.shippingExtraAmount, units, profileId: product.shippingProfileId || null };
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
    source = null,
    // { method, tokenHash }: a storefront order paid with one of the store's
    // manual methods (manualPayments) — unpaid, confirmed only once approved.
    manualPayment = null,
  } = {}
) {
  const { items, contact, paymentMethod, discountCode, funnelId, websiteId, notes } = payload;
  // Store pickup (shipping/storePickup.js): no address and no shipping fee, whatever was sent.
  const pickup = payload.deliveryMethod === storePickup.METHOD;
  const shippingAddress = pickup ? null : payload.shippingAddress;

  if (!items || items.length === 0) {
    throw new ValidationError([{ field: 'items', message: 'At least one item is required' }]);
  }

  const evaluateFraudRules = !req.user && !skipFraudRules;
  // SPEC §4.2: where the order came from, and whether it is the merchant
  // trying their own store (kept out of sales figures and ad pixels).
  const orderSource = source || orderMeta.sourceFor(req, { funnelId });
  const isTest = orderMeta.isTestRequest(req, workspaceId);

  const run = async (transaction) => {
    if (pickup) await storePickup.assertAvailable(workspaceId, transaction);
    // Opening hours (shipping/storeHours.js): a closed store takes no shopper orders. An add-on to an
    // order just placed, and an order staff type in, are not refused.
    if (!req.user && !shippingOverride && source !== 'upsell') await storeHours.assertOpen(workspaceId, transaction);
    // Chosen now so the reservations below can name the order they hold stock
    // for (inventory/orderStock.js releases exactly what they reserved).
    const orderId = crypto.randomUUID();
    // Each product's purchase limits for every shopper order — the store, funnels — counted again here
    // under a lock on the phone, so two orders at once can't both pass the per-customer limit. Staff
    // orders are not limited (catalog/purchaseLimits.js).
    if (!req.user && storeFeatureOn('purchase_limits')) {
      const limitPhone = normalizePhone(contact && contact.phone);
      if (limitPhone) await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `purchase-limits:${workspaceId}:${limitPhone}` }, transaction });
      // A follow-on add-on order (an upsell placed as its own order) counts toward the per-customer limit only.
      await require('../catalog/purchaseLimits').assertWithin(workspaceId, items, contact, transaction, { perOrder: orderSource !== 'upsell' });
    }
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

    // The shopper's own IP and browser: a staff order carries the staff member's.
    const visitor = req && !req.user ? await visitorGate.describeVisitor(req) : { ip: null, ipCountry: null, isVpn: false };
    const visitorIp = visitor.ip;
    const deviceId = req && !req.user && req.deviceId ? req.deviceId : null;
    visitor.deviceId = deviceId;
    const visitorAgent = req && !req.user && req.headers ? req.headers['user-agent'] : null;

    const riskFlags = [];
    if (customer.isBlacklisted) riskFlags.push('blacklisted_customer');
    // The store's blocked_entries (scope orders). The IP is the shopper's only
    // on a storefront order; a staff order carries the staff member's.
    const blockedEntry = await blockedEntries.findMatch(
      workspaceId,
      'orders',
      {
        phoneNormalized: customer.phoneNormalized,
        email: contact.email,
        ip: visitorIp,
        deviceId,
        fullName: contact.fullName,
        addressLine: shippingAddress && shippingAddress.addressLine,
      },
      transaction
    );
    if (blockedEntry && !riskFlags.includes('blacklisted_customer')) riskFlags.push('blacklisted_customer');
    // A phone blocked before it ever ordered: its customer row exists only now.
    if (blockedEntry && blockedEntry.type === 'phone' && !customer.isBlacklisted) {
      await customer.update(
        { isBlacklisted: true, blacklistReason: blockedEntry.reason, blacklistedAt: blockedEntry.createdAt },
        { transaction }
      );
    }

    // Before any inventory is touched, so a refusal has nothing to undo but
    // the customer lookup.
    // Risk score and data quality of a storefront order (risk/riskService):
    // a marker only, unless the store's high_risk rule acts on it.
    const risk = evaluateFraudRules
      ? await riskService.score(
          { contact, shippingAddress },
          {
            workspaceId,
            country: fraudRules.storeCountry(await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'defaultLocale', 'settings'], transaction })),
            visitor,
            secondsOnPage: req && typeof req.secondsOnPage === 'number' ? req.secondsOnPage : null,
            transaction,
          }
        )
      : null;

    if (evaluateFraudRules) {
      const { flags: ruleFlags, requireOtp } = await fraudRules.evaluateStorefrontOrder({
        workspaceId,
        customer,
        variantIds: [...new Set(items.map((item) => item.variantId).filter(Boolean))],
        transaction,
        onlinePayment: Boolean(awaitingPayment),
        blockedEntry,
        items,
        paymentMethod,
        phone: contact.phone,
        visitor,
        riskLevel: risk.level,
      });
      for (const flag of ruleFlags) if (!riskFlags.includes(flag)) riskFlags.push(flag);
      // A rule (or the store's "verify risky orders") wants the phone verified first — risk/checkoutOtp.
      if (checkoutOtp.needsOtp(req, { requireOtp, riskLevel: risk.level, flags: ruleFlags })) throw new checkoutOtp.NeedsOtp();
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
      // The shopper's own checkout must answer the product's required menu groups (catalog/menuOptions.js).
      const line = await priceLine(workspaceId, { ...item, enforceRequiredOptions: Boolean(customFields.enforceRequired) }, transaction).catch((err) => {
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

    // A funnel with a currency of its own takes orders in it only (funnels/funnelCurrency.js).
    await require('../funnels/funnelCurrency').assertOrderCurrency(workspaceId, funnelId, pricedLines[0] && pricedLines[0].currency, transaction);

    // Quantity bundles (modules/bundles): lowers the totals of the lines they
    // cover, before anything else looks at the subtotal.
    const bundleSnapshots = await applyBundleTiers(workspaceId, pricedLines, transaction);

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
        // A product- or collection-limited code works on its lines only.
        lines: pricedLines,
        customerId: customer.id,
        funnelId,
        transaction,
      });
      discountAmount = evaluation.amount;
      discountRecord = evaluation.discount;
      discountsSnapshot = [{ code: discountCode, type: evaluation.discount.type, amount: discountAmount }];
    }
    const couponExtras = require('../discounts/couponExtras');
    if (!discountCode) {
      // No code typed: the store's best automatic discount, when one applies.
      const automatic = await couponExtras.bestAutomatic(workspaceId, { subtotal, productIds, lines: pricedLines, customerId: customer.id, funnelId }, transaction);
      if (automatic) {
        discountAmount = automatic.amount;
        discountRecord = automatic.discount;
        discountsSnapshot = [{ code: null, automatic: true, discountId: automatic.discount.id, type: automatic.discount.type, amount: discountAmount }];
      }
    }
    // A free-shipping code: every line ships free, and the order keeps it when a
    // line joins later or its items are edited (freeShippingGranted below).
    // A VIP tier with free shipping (modules/vipTiers) sets this on the checkout's payload: the same as such a code.
    const couponFreeShipping = Boolean(discountRecord && discountRecord.type === 'free_shipping') || payload[Symbol.for('zimos.freeShipping')] === true;
    if (couponFreeShipping) {
      for (const line of pricedLines) if (line.shippingRule) line.shippingRule = { ...line.shippingRule, mode: 'free', extraAmount: null };
    }
    // The store's minimum order amount binds shoppers, not staff typing an
    // order in, and not an add-on order that follows another one.
    if (!req.user && !shippingOverride) await couponExtras.assertMinimumOrder(workspaceId, subtotal, transaction);
    // The governorates the store delivers to, when it limits them (shipping/deliveryAreas.js).
    if (!req.user && !shippingOverride && !pickup) await require('../shipping/deliveryAreas').assertAreaServed(workspaceId, shippingAddress, transaction);
    // Delivery zones inside a city (shipping/deliveryZones.js): the shopper's area prices the delivery
    // and its minimum binds too. Read from the database only; null while the store does not use zones.
    const zone =
      !req.user && !shippingOverride && !pickup ? await deliveryZones.resolveForCheckout(workspaceId, payload.deliveryZoneId, transaction) : null;
    deliveryZones.assertZoneMinimum(zone, subtotal);
    // Kept apart from the coupon: the bundle's saving is already in the line totals.
    discountsSnapshot = [...bundleSnapshots, ...discountsSnapshot];

    // Always priced, even without an address (amount 0 then): the weight
    // and tier are stored on the order either way.
    const shipping = await calculateShippingAmount(workspaceId, {
      country: shippingAddress ? shippingAddress.country : null,
      region: shippingAddress ? shippingAddress.province : null,
      subtotal,
      totalQuantity,
      // A free-shipping code beats an offer's own shipping price; an add-on's does not.
      offerShippingOverride: couponFreeShipping && !shippingOverride ? null : offerShippingOverride,
      weightLines: pricedLines.map((l) => ({ quantity: l.quantity, units: l.weightUnits })),
      productLines: pricedLines.map((l) => l.shippingRule),
      funnelId: payload.funnelId || null,
      transaction,
    });
    // The shopper's choice among the store's shipping options (shipping/shippingOptions.js).
    const chosenShipping =
      pickup || zone ? null : await require('../shipping/shippingOptions').choose(workspaceId, payload.shippingOption, shipping, transaction);
    // A zone's fee replaces the destination price; a store-wide rule that makes shipping free (or an offer's own price) still wins.
    const zoneAmount = zone ? (DESTINATION_INDEPENDENT.includes(shipping.rule) ? shipping.amount : zone.feeAmount) : null;
    const shippingAmount = pickup ? 0 : zone ? zoneAmount : chosenShipping ? chosenShipping.amount : shipping.amount;
    const etaMinutes = pickup
      ? null
      : (zone && zone.etaMinutes) ||
        storeHours.etaMinutes(((await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'], transaction })) || {}).settings);

    const { taxAmount } = await calculateTax(workspaceId, {
      country: shippingAddress ? shippingAddress.country : null,
      region: shippingAddress ? shippingAddress.province : null,
      // Taxed on what the shopper pays: the code's or automatic discount comes off first.
      lines: await taxableLines(pricedLines, discountAmount, discountRecord, transaction),
      shippingAmount,
      transaction,
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
        deliveryMethod: pickup ? storePickup.METHOD : null,
        discountsSnapshot,
        notes: notes || null,
        riskFlags,
        ipAddress: visitorIp,
        ipCountry: visitor.ipCountry,
        deviceId,
        adMatch: pixelMatching.fromCheckout(req),
        riskScore: risk ? risk.score : null,
        riskLevel: risk ? risk.level : null,
        riskReasons: risk ? risk.reasons : [],
        dataQuality: risk ? risk.dataQuality : null,
        userAgent: visitorAgent ? String(visitorAgent).slice(0, 400) : null,
        source: orderSource,
        isTest,
        // An order staff typed in themselves is not news to them.
        isSeen: Boolean(req.user),
        seenAt: req.user ? new Date() : null,
        totalWeightGrams: shipping.weightGrams,
        weightTierSnapshot: shipping.tier,
        weightEstimated: shipping.weightEstimated,
        // With the option the shopper picked, when not the standard one.
        shippingSnapshot: {
          ...shippingSnapshot(shipping),
          ...(chosenShipping ? { option: chosenShipping.snapshot } : {}),
          ...(zone ? { zone: { id: zone.id, name: zone.name, feeAmount: zone.feeAmount, etaMinutes: zone.etaMinutes } } : {}),
          // The estimated delivery time the customer was shown: the zone's, else the store's.
          ...(etaMinutes ? { etaMinutes } : {}),
          // Free shipping a free-shipping code gave: kept when a line joins later or the items are edited.
          ...(couponFreeShipping ? { freeShippingGranted: true } : {}),
        },
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
        ...(manualPayment ? { paymentTokenHash: manualPayment.tokenHash } : {}),
      },
      { transaction }
    );
    // A moderate order may get the AI text check after it commits (risk/aiOrderCheck); nothing while AI_ENABLED is off.
    if (risk) await aiOrderCheck.queueFor(workspaceId, order.id, risk.level, transaction);

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
            lineDiscountAmount: line.lineDiscountAmount || 0,
            lineTotalAmount: line.lineTotalAmount,
            unitWeightGrams: shipping.lineWeights[index],
            customizations: line.customizations || null,
            optionsSnapshot: line.optionsSnapshot || null,
            isOrderBump: line.isOrderBump,
          },
          { transaction }
        )
      );
      // The line's photos now belong to the order: attached, no longer expiring.
      await attachUploads(line.customizations, orderItems[orderItems.length - 1].id, transaction);
    }

    if (manualPayment) await require('../manualPayments/manualPaymentService').recordForOrder(order, manualPayment.method, transaction);
    // A manually paid order waits in the queue too, flagged until its proof is approved.
    if (paymentMethod === 'cod' || manualPayment) {
      // `confirmationAvailableAt`: a funnel order waits for the funnel's offer
      // window before anyone may confirm it (funnels/funnelOfferMerge.js).
      await db.ConfirmationTask.create(
        { workspaceId, orderId: order.id, status: 'queued', availableAt: confirmationAvailableAt || null },
        { transaction }
      );
    }

    // The first row of the order's status history: nothing → where it starts.
    await trackStage(workspaceId, order.id, { req, transaction, fallbackActor: 'customer' });

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

    // Merchant automations (WhatsApp templates) and server-side ad-platform
    // conversions run after commit and never fail the order. An order waiting
    // for its online payment is not a purchase yet, so it sends no conversion.
    // They hang off the order.created event in the outbox (see each module's jobs.js).
    await outbox.record(transaction, 'order.created', { workspaceId, orderId: order.id, awaitingPayment: Boolean(awaitingPayment), isTest: Boolean(isTest) });

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
    // Nothing was saved; the shopper is sent a code and asked for it.
    if (err instanceof checkoutOtp.NeedsOtp) throw await checkoutOtp.challengeError(workspaceId, contact.phone, { req });
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
/**
 * The discount an order was placed with when it has no redemption yet: an order still awaiting its
 * online payment keeps its code in completionContext.discount until it is paid, and an automatic
 * discount names itself in discountsSnapshot. Tax spreads it over the lines it covers.
 */
async function placedDiscount(order, transaction) {
  const pending = order.completionContext && order.completionContext.discount;
  const automatic = (order.discountsSnapshot || []).find((d) => d && d.kind !== 'bundle' && d.discountId);
  const discountId = (pending && pending.discountId) || (automatic && automatic.discountId) || null;
  return discountId ? db.Discount.findByPk(discountId, { transaction }) : null;
}

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
  // An upsell the shopper takes counts toward the product's purchase limits with the order's own lines.
  if (isUpsell && storeFeatureOn('purchase_limits')) {
    const limits = require('../catalog/purchaseLimits');
    const lines = [...existing.map((i) => ({ variantId: i.variantId, offerId: i.offerId, quantity: i.quantity })), lineInput];
    // Only the products the upsell adds, with the order's own lines of those products.
    const added = [...(await limits.unitsByProduct(workspaceId, [lineInput], transaction)).keys()];
    if (added.length) await limits.assertWithin(workspaceId, lines, order.contactSnapshot || {}, transaction, { excludeOrderId: order.id, onlyProductIds: added });
  }
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

  // Free shipping the order was given when placed (a free-shipping code) still holds for every line.
  if ((order.shippingSnapshot || {}).freeShippingGranted === true) {
    for (const line of lines) if (line.shippingRule) line.shippingRule = { ...line.shippingRule, mode: 'free', extraAmount: null };
  }

  const subtotal = add(...lines.map((l) => l.lineTotalAmount));
  const totalQuantity = lines.reduce((sum, l) => sum + l.quantity, 0);
  // A free-shipping code beats an offer's own shipping price.
  const offerShippingOverride = couponShipsFree(order) ? null : lines.find((l) => l.shippingOverride)?.shippingOverride || null;

  // The code the order was placed with, on the new subtotal. It was checked
  // and redeemed when the order was placed and is not checked again.
  let discountAmount = before.discountAmount;
  let discountsSnapshot = order.discountsSnapshot || [];
  let placed = null;
  const redemption = await db.DiscountRedemption.findOne({ where: { orderId: order.id }, transaction });
  if (redemption) {
    const discount = await db.Discount.findByPk(redemption.discountId, { transaction });
    placed = discount;
    if (discount) {
      // A product- or collection-limited code still covers only its lines.
      discountAmount = await discountService.amountForLines(discount, lines, transaction);
      discountsSnapshot = discountsSnapshot.map((d) => (d.code === discount.code ? { ...d, amount: discountAmount } : d));
      await redemption.update({ amountAllocated: discountAmount }, { transaction });
    }
  } else {
    placed = await placedDiscount(order, transaction);
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
    funnelId: order.funnelId || null,
    transaction,
  });
  // A pickup order has no delivery fee, with or without the new line.
  const shippingAmount = storePickup.isPickup(order) ? 0 : shipping.amount;
  const { taxAmount } = await calculateTax(workspaceId, {
    country: address ? address.country : null,
    region: address ? address.province : null,
    // Taxed on what the shopper pays: the order's discount comes off first.
    lines: await taxableLines(lines, discountAmount, placed, transaction),
    shippingAmount,
    transaction,
  });
  const totalAmount = subtotal - discountAmount + shippingAmount + taxAmount;

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
      shippingAmount,
      taxAmount,
      totalAmount,
      totalWeightGrams: shipping.weightGrams,
      weightTierSnapshot: shipping.tier,
      weightEstimated: shipping.weightEstimated,
      // Over what the order was placed with: the option, the zone, the delivery
      // estimate and free shipping a code granted stay for the next change.
      shippingSnapshot: { ...(order.shippingSnapshot || {}), ...shippingSnapshot(shipping) },
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
  // A product joined an order that was already placed (an upsell, a merged offer).
  await outbox.record(transaction, 'order.item_added', { workspaceId, orderId: order.id, itemId: item.id, isUpsell });
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
  // Paid by InstaPay / a wallet: the payer's number, the screenshot's signed link and the review (manualPayments).
  if (order.paymentMethod === 'bank_transfer') {
    json.manualPayment = await require('../manualPayments/manualPaymentService').presentForStaff(workspaceId, order.id);
  }
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
  const stage = await stageForOrder(order.id);
  // Locked orders (orderLock): the customer's details hidden, `contactLocked` set either way.
  return orderLock.presentOrder(workspaceId, {
    ...json,
    paymentProvider: providers.get(order.id) || null,
    stage,
    // The stages PATCH /orders/:id/status accepts from here (orderStageChange.js).
    nextStages: storePickup.isPickup(order) ? nextStages(stage).filter((s) => !storePickup.COURIER_STAGES.includes(s)) : nextStages(stage),
    confirmationTask: await confirmationService.taskSummaryForOrder(workspaceId, order.id),
    linkedOrders: linkedOrders.map((o) => o.toJSON()),
    linkedFromOrder: linkedFrom ? linkedFrom.toJSON() : null,
  });
}

/** The order's id and number, or 404 — the check every per-order endpoint starts with. */
async function getOrderRef(workspaceId, orderId) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id', 'orderNumber'] });
  if (!order) throw new NotFoundError('Order');
  return order;
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
function applySearchAndDates(conditions, bind, { q, from, to }, lockCtx = null) {
  if (q) {
    const term = q.trim();
    const arms = [];
    // A locked order is never found by its customer's name, email or phone
    // (orderLock.visibleSql; TRUE while nothing is locked).
    const visible = orderLock.visibleSql(lockCtx, 'o');
    const customerArm = (sql) => (visible === 'TRUE' ? sql : `(${sql} AND ${visible})`);

    bind.qNumber = `%${escapeLike(term.replace(/^#/, ''))}%`;
    arms.push('zimos_normalize_search(o.order_number) LIKE zimos_normalize_search($qNumber)');

    bind.qText = `%${escapeLike(term)}%`;
    arms.push(customerArm("zimos_normalize_search(o.contact_snapshot->>'fullName') LIKE zimos_normalize_search($qText)"));
    arms.push(customerArm("zimos_normalize_search(o.contact_snapshot->>'email') LIKE zimos_normalize_search($qText)"));

    // A courier's waybill number, exactly (any case): the store's shipments only.
    bind.qWaybill = term;
    arms.push(
      'o.id IN (SELECT ws.order_id FROM shipments ws WHERE ws.workspace_id = $workspaceId AND lower(ws.waybill_number) = lower($qWaybill))'
    );

    const digits = term.replace(/\D/g, '');
    if (digits.length >= 10) {
      bind.qPhone = normalizePhone(term).slice(-10);
      arms.push(
        customerArm("right(regexp_replace(coalesce(o.contact_snapshot->>'phone', ''), '[^0-9]', '', 'g'), 10) = $qPhone")
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
  const shipments = await latestShipments(rows.map((row) => row.id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return page
    .filter((row) => byId.has(row.id))
    .map((row) => ({
      ...byId.get(row.id).toJSON(),
      stage: row.stage,
      paymentProvider: providers.get(row.id) || null,
      // The list's shipping column: the latest shipment that is not cancelled.
      shipment: shipments.get(row.id) || null,
    }));
}

/** Each order's latest shipment that is not cancelled: courier, waybill and status. One query for the page. */
async function latestShipments(orderIds) {
  if (orderIds.length === 0) return new Map();
  const rows = await db.sequelize.query(
    `SELECT DISTINCT ON (order_id) order_id, carrier_code, waybill_number, status
       FROM shipments
      WHERE order_id IN (:ids) AND status <> 'cancelled'
      ORDER BY order_id, created_at DESC, id DESC`,
    { replacements: { ids: orderIds }, type: QueryTypes.SELECT }
  );
  return new Map(rows.map((r) => [r.order_id, { carrierCode: r.carrier_code, waybillNumber: r.waybill_number, status: r.status }]));
}

/**
 * The gateway each online order is paid through: its latest attempt's
 * provider. Cash on delivery (including an online order the shopper switched
 * to COD) has none. One query for the page.
 */
async function paymentProviders(orders) {
  const online = orders.filter((o) => require('../payments/methodNames').isOnline(o.paymentMethod)).map((o) => o.id);
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
  { limit = 50, cursor, sort: sortKey, confirmationState, financialState, fulfillmentState, stage, q, from, to, ...filters } = {}
) {
  const conditions = ['o.workspace_id = $workspaceId'];
  const bind = { workspaceId, limit: limit + 1 };
  applyOrderFilters(conditions, bind, filters);
  const sort = orderSort(sortKey);

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
  const lockCtx = await orderLock.contextFor(workspaceId);
  applySearchAndDates(conditions, bind, { q, from, to }, lockCtx);

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
  // Locked orders hidden here, so the list, the export and the public API all get the same answer.
  const orders = await orderLock.presentOrders(workspaceId, await hydrateOrders(page), { ctx: lockCtx });
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
async function orderPipeline(workspaceId, { q, from, to, ...filters } = {}) {
  const conditions = ['o.workspace_id = $workspaceId'];
  const bind = { workspaceId };
  applyOrderFilters(conditions, bind, filters);
  const lockCtx = q ? await orderLock.contextFor(workspaceId) : null;
  applySearchAndDates(conditions, bind, { q, from, to }, lockCtx);

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
  return { stages, total, risk: await riskCounts(workspaceId, { q, from, to, ...filters }, lockCtx) };
}

/** The risk tabs' counts: every other filter applies, the risk tab itself does not. */
async function riskCounts(workspaceId, { q, from, to, riskLevel, ...filters }, lockCtx = null) {
  const conditions = ['o.workspace_id = $workspaceId'];
  const bind = { workspaceId };
  applyOrderFilters(conditions, bind, filters);
  applySearchAndDates(conditions, bind, { q, from, to }, lockCtx);
  const rows = await db.sequelize.query(
    `SELECT o.risk_level AS level, COUNT(*)::int AS count FROM orders o WHERE ${conditions.join(' AND ')} GROUP BY 1`,
    { bind, type: QueryTypes.SELECT }
  );
  const risk = { high: 0, moderate: 0, low: 0 };
  for (const row of rows) if (row.level in risk) risk[row.level] = row.count;
  return risk;
}

/**
 * Merchant cancellation: releases the inventory reservation (like a COD
 * rejection), advances confirmationState to 'rejected', cancels any
 * uncollected shipment, closes open confirmation tasks and records the
 * reason. Refused once a parcel has shipped — use a return after that.
 */
async function cancelOrder(workspaceId, orderId, { reason, acknowledgeManualCancel = false, notifyCustomer }, req) {
  // The gateway is asked about an open card or wallet attempt first (best effort, as expiry does), so a payment
  // that already went through is recorded before the cancel closes the attempt.
  const known = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id', 'cancelledAt'] });
  if (known && !known.cancelledAt) {
    await require('../payments/onlinePaymentService')
      .inquireOpenAttempts(known.id)
      .catch((err) => logger.warn('[orders] payment inquiry before cancel failed', { orderId, reason: err.message }));
  }
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
    await outbox.record(transaction, 'order.cancelled', {
      workspaceId,
      orderId: order.id,
      ...(notifyCustomer !== undefined ? { notifyCustomer } : {}),
    });

    // Whatever the order still holds: nothing more if a rejection already gave it back.
    await orderStock.releaseOrderStock(
      { workspaceId, orderId: order.id, referenceType: 'order_cancelled', actorUserId: req.user.id },
      transaction
    );
    // An order waiting for its card or wallet payment: its open gateway attempts end
    // here too (a manual transfer receipt waiting for review is left as it is).
    await require('../payments/onlinePaymentService').cancelOpenAttempts(order, transaction, { gatewayOnly: true });

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
    await trackStage(workspaceId, order.id, { req, transaction, reason });
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

const blank = (v) => (v === undefined || v === null ? '' : String(v));
const sameFields = (a, b, keys) => keys.every((k) => blank((a || {})[k]) === blank((b || {})[k]));
// What a courier booking carries of the receiver: the address fields this endpoint sets
// (orderValidation's address), and the name and phones.
const COURIER_ADDRESS_FIELDS = ['country', 'province', 'city', 'area', 'addressLine', 'placeId', 'postalCode', 'notes'];
const COURIER_CONTACT_FIELDS = ['fullName', 'phone', 'alternatePhone'];

/** Whether an updateOrderLimited body changes what a courier was given at booking. */
function receiverChanges(order, data) {
  if (data.shippingAddress !== undefined && !sameFields(order.shippingAddressSnapshot, data.shippingAddress, COURIER_ADDRESS_FIELDS)) return true;
  if (data.contact !== undefined) {
    const next = { ...(order.contactSnapshot || {}), ...data.contact };
    if (!sameFields(order.contactSnapshot, next, COURIER_CONTACT_FIELDS)) return true;
  }
  return false;
}

/**
 * The only fields a merchant may edit on an existing order: the shipping
 * address snapshot, the customer's contact details and the internal notes. Totals, line items and pricing are
 * never touched here. Refused once the order has shipped.
 */
async function updateOrderLimited(workspaceId, orderId, data, req) {
  return db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new NotFoundError('Order');
    if (order.cancelledAt) throw new AppError('ORDER_CANCELLED', 'This order is cancelled', 409);
    // Everything this endpoint edits is the customer's details: not on a locked order (402 ORDER_LOCKED).
    await orderLock.assertUnlocked(workspaceId, order, { transaction });
    await assertNotShipped(order, transaction);
    // The courier delivers to the address and receiver it was given at booking:
    // a real change to either waits for the booking to be cancelled. Notes, the email, or
    // the same values sent again stay allowed.
    if (receiverChanges(order, data)) await carrierShipmentService.assertNoCarrierBooking(order.id, transaction);

    const before = { shippingAddressSnapshot: order.shippingAddressSnapshot, contactSnapshot: order.contactSnapshot, notes: order.notes };
    const updates = {};
    if (data.shippingAddress !== undefined) updates.shippingAddressSnapshot = data.shippingAddress;
    if (data.contact !== undefined) updates.contactSnapshot = { ...(order.contactSnapshot || {}), ...data.contact };
    if (data.notes !== undefined) updates.notes = data.notes;
    await order.update(updates, { transaction });

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'order.update',
      entityType: 'Order',
      entityId: order.id,
      before,
      after: { shippingAddressSnapshot: order.shippingAddressSnapshot, contactSnapshot: order.contactSnapshot, notes: order.notes },
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
  // A locked order is not booked with a courier nor shipped by hand: its
  // address is hidden (402 ORDER_LOCKED, orderLock). The bulk action, the
  // batches and the public API come through here or the carrier booking.
  await orderLock.assertUnlocked(workspaceId, orderId);
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
    storePickup.assertCourierAllowed(order, data.carrierCode);
    await carrierShipmentService.assertNoActiveShipment(order.id, transaction);
    // A returned parcel that was restocked: its units are taken again.
    await require('./returnedStock').retakeForReship(workspaceId, order.id, req.user ? req.user.id : null, transaction);

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
    // A new shipment for an order whose last parcel came back: ready to ship again.
    await trackStage(workspaceId, order.id, { req, transaction });

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
    // A courier with a cancel API is asked first, before anything here
    // changes: a refusal (409 CARRIER_CANCEL_FAILED) leaves the shipment as
    // it was, instead of a parcel live at the courier that we call cancelled
    // and whose COD we would then ignore. The stage guard runs before that,
    // so a refused move never follows a cancel the courier already made.
    if (data.status === 'cancelled' && carrierShipmentService.cancelsByApi(shipment)) {
      await require('./orderStateService').assertShipmentCancelMove(orderId, shipment.id, transaction);
      Object.assign(extra, await carrierShipmentService.apiCancelUpdates(workspaceId, shipment, data, req, transaction));
    }
    if (!extra.cancelMode && carrierShipmentService.TERMINAL_STATUSES.includes(data.status) && shipment.nextPollAt) {
      extra.nextPollAt = null;
    }
    // A returned or cancelled shipment set going again is the order sent again: if its
    // returned parcel was restocked, the units are taken back first, as for a new shipment.
    if (
      data.status &&
      carrierShipmentService.FINISHED_STATUSES.includes(shipment.status) &&
      !carrierShipmentService.FINISHED_STATUSES.includes(data.status)
    ) {
      await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
      await require('./returnedStock').retakeForReship(workspaceId, orderId, req.user ? req.user.id : null, transaction);
    }
    // The stamps, fulfillment state and audit row live in shipmentLifecycle,
    // shared with the carrier status updates.
    return transitionShipment(
      workspaceId,
      shipment,
      { status: data.status, waybillNumber: data.waybillNumber, trackingUrl: data.trackingUrl, ...extra },
      // A status set by hand must be a move the order may make (409 otherwise).
      { transaction, req, actorUserId: req.user.id, enforceStageGuard: true }
    );
  });
}

module.exports = {
  createOrder,
  addLineToOpenOrder,
  getOrder,
  getOrderRef,
  applySearchAndDates,
  listOrders,
  orderPipeline,
  resolveCursor,
  generateOrderNumber,
  generateTrackingCode,
  priceLine,
  couponShipsFree,
  placedDiscount,
  cancelOrder,
  updateOrderLimited,
  listShipments,
  createShipment,
  updateShipment,
};
