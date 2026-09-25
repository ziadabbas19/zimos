'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const logger = require('../../core/utils/logger');
const { recordAudit } = require('../audit/auditService');
const { insertShipment, transitionShipment } = require('../orders/shipmentLifecycle');
const { getAdapter, reservedAdapterFor, MANUAL } = require('./carriers');
const accounts = require('./carrierAccountService');
const { matchAddress } = require('./carrierAddressMatching');
const { CarrierAuthError } = require('./carriers/carrierErrors');
const { loadTiers } = require('./shippingPricing');

/**
 * Shipments booked through a merchant's connected courier account.
 *
 * Must not require orders/orderService — orderService requires this module.
 */

// A shipment in any other status blocks booking a new one for the order.
// 'returned' is over (the parcel is back), 'cancelled' never happened. A
// 'failed' one still blocks: for Bosta that is often an exception the courier
// will re-attempt, and a second booking would put two parcels on the road.
const FINISHED_STATUSES = ['cancelled', 'returned'];

// Statuses a carrier can't move a shipment out of. The one exception is a
// carrier explicitly reporting 'returned' after 'delivered'.
const TERMINAL_STATUSES = ['delivered', 'returned', 'cancelled'];

// Bosta states after which a terminate has nothing left to stop: 46 Returned
// to business, 48 Terminated, 49 Canceled. Delivered (45) is not here — an
// order whose parcel was handed over must not quietly become "cancelled".
const CARRIER_CANCEL_SETTLED_STATES = { bosta: [46, 48, 49] };
// The wording couriers use when the delivery is already gone.
const ALREADY_CANCELLED_PATTERN = /already\s+(been\s+)?(cancell?ed|terminated)/i;

/**
 * Whether POST /shipments should book with a courier (true) or record a
 * manual shipment (false). A courier booking is exactly the adapter's code
 * — what the dashboard's courier option sends — on a store that connected
 * it, with no waybill/tracking URL (the courier assigns those; a request
 * carrying them was typed into the manual form). Any other spelling of a
 * courier's name ("Bosta", " BOSTA ") is refused with 422: manual shipments
 * are local records only and must never look like, or become, a booking.
 * Checked without decrypting anything, so a connected store on a server
 * without CARRIER_CREDENTIALS_KEY still gets the 503.
 */
async function shouldBookWithCarrier(workspaceId, data) {
  const adapter = reservedAdapterFor(data.carrierCode);
  if (!adapter) return false;

  const connected = (await db.CarrierAccount.count({ where: { workspaceId, carrierCode: adapter.code } })) > 0;
  const manualFields = Boolean(data.waybillNumber || data.trackingUrl);
  if (connected && data.carrierCode === adapter.code && !manualFields) return true;

  const message = connected
    ? `"${adapter.name}" can't be used as a manual courier name. To ship with ${adapter.name}, choose the ${adapter.name} option — it books the delivery and fills in the tracking number.`
    : `"${adapter.name}" can't be used as a manual courier name. To ship with ${adapter.name}, connect it under shipping settings and choose the ${adapter.name} option.`;
  throw new AppError('CARRIER_NAME_RESERVED', message, 422, [
    { field: 'carrierCode', message, carrierCode: adapter.code, connected },
  ]);
}

/**
 * One active shipment per order, for courier and manual shipments alike: a
 * new one is allowed only once every existing one is cancelled or returned.
 * The caller must hold the order row FOR UPDATE, so two requests can't both
 * pass.
 */
async function assertNoActiveShipment(orderId, transaction) {
  const active = await db.Shipment.findOne({
    where: { orderId, status: { [Op.notIn]: FINISHED_STATUSES } },
    transaction,
  });
  if (active) {
    throw new AppError(
      'SHIPMENT_ALREADY_EXISTS',
      'This order already has an active shipment. Cancel it before booking another.',
      409,
      { shipmentId: active.id }
    );
  }
}

/**
 * A shipment we booked through a carrier adapter — as opposed to a manual
 * row whose free-text carrierCode happens to name one. Only these are synced,
 * cancelled at the carrier, labelled, or updated by webhooks.
 */
function isCarrierBooked(shipment) {
  return Boolean(
    shipment &&
      getAdapter(shipment.carrierCode) &&
      shipment.waybillNumber &&
      shipment.carrierResponse &&
      Object.prototype.hasOwnProperty.call(shipment.carrierResponse, 'carrierShipmentId')
  );
}

/**
 * The order may leave the building: not cancelled, and a COD order confirmed
 * on the call or a prepaid one paid. Every shipment path — courier-booked or
 * manual — goes through this, so the queue can't be skipped by typing a
 * courier name by hand.
 */
function assertConfirmedOrPaid(order) {
  if (order.cancelledAt || order.confirmationState === 'rejected') {
    throw new AppError('ORDER_CANCELLED', 'This order is cancelled', 409);
  }
  if (order.paymentMethod === 'cod' && order.confirmationState !== 'confirmed') {
    throw new AppError('ORDER_NOT_CONFIRMED', 'Confirm this cash-on-delivery order before booking a courier', 409);
  }
  if (order.paymentMethod !== 'cod' && order.financialState !== 'paid') {
    throw new AppError('ORDER_NOT_PAID', 'This prepaid order must be paid before booking a courier', 409);
  }
  // Paid with a gateway's test keys: no money moved, so nothing ships.
  if ((order.riskFlags || []).includes('test_payment')) {
    throw new AppError('ORDER_TEST_PAYMENT', 'This order was paid in test mode and cannot be shipped', 409);
  }
}

function assertReadyToShip(order) {
  assertConfirmedOrPaid(order);
  if (!order.shippingAddressSnapshot) {
    throw new AppError('SHIPPING_ADDRESS_REQUIRED', 'This order has no shipping address', 409);
  }
}

/** Amount the courier collects, in our minor units: what is still unpaid. */
function codAmountFor(order) {
  if (order.paymentMethod !== 'cod') return 0;
  return Math.max(0, Number(order.totalAmount) - Number(order.amountPaid));
}

function webhookUrlForShipment(account) {
  // A carrier can only call a public HTTPS URL. On a local/dev server the
  // merchant uses POST .../sync instead.
  const url = accounts.webhookUrlFor(account);
  return /^https:\/\//i.test(url) ? url : null;
}

/**
 * The weight tier a booking uses: the merchant's override (`tierId`, which
 * must be one of the store's current tiers) or the tier stored on the order
 * at checkout. Null for an order placed before the store had tiers.
 */
async function bookingTier(workspaceId, order, tierId, transaction) {
  if (!tierId) return order.weightTierSnapshot || null;
  const tier = (await loadTiers(workspaceId, transaction)).find((t) => t.id === tierId);
  if (!tier) {
    throw new AppError('VALIDATION_ERROR', 'Validation failed', 422, [
      { field: 'tierId', message: "Not one of this store's weight tiers" },
    ]);
  }
  return { ...tier, flags: [] };
}

/**
 * POST /orders/:orderId/shipments with a carrier that has an adapter.
 *
 * Double-click safety: the order row is locked FOR UPDATE for the whole
 * booking, carrier call included. A second request waits on that lock, then
 * finds the first one's shipment and gets 409 — so it never reaches the
 * carrier. Holding a row lock across one HTTP call (15s timeout, no retry) is
 * the price, and only this order's row pays it.
 */
async function createCarrierShipment(workspaceId, orderId, data, req) {
  const connection = await accounts.loadConnection(workspaceId, data.carrierCode);
  const { adapter, account, credentials } = connection;

  // Loaded (and cached) before the order row is locked: on a cold cache this
  // is a retried carrier read, and it must not hold the lock while it runs.
  // A failure here fails the request exactly as before, with no lock taken.
  const { index } = await accounts.loadCities(connection);

  let booked = null;
  try {
    return await db.sequelize.transaction(async (transaction) => {
      const order = await db.Order.findOne({
        where: { id: orderId, workspaceId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!order) throw new NotFoundError('Order');
      assertReadyToShip(order);
      await assertNoActiveShipment(order.id, transaction);

      const address = await matchAddress(adapter.code, index, order.shippingAddressSnapshot, data.carrierAddress);

      // Resolved before the carrier call, so an unmapped tier costs nothing.
      const tier = await bookingTier(workspaceId, order, data.tierId, transaction);
      const pkg = adapter.resolvePackage ? adapter.resolvePackage(account.settings || {}, tier) : null;

      const items = await db.OrderItem.findAll({ where: { orderId: order.id }, transaction });
      const snapshot = order.shippingAddressSnapshot;
      booked = await accounts.withAuthHandling(account, () =>
        adapter.createShipment(credentials, {
          order,
          address: { ...address, firstLine: snapshot.addressLine, secondLine: snapshot.notes || null },
          cod: codAmountFor(order),
          goodsValue: Math.max(0, Number(order.subtotalAmount) - Number(order.discountAmount)),
          itemsCount: items.reduce((sum, item) => sum + item.quantity, 0),
          description: items.map((item) => `${item.quantity}x ${item.productNameSnapshot}`).join(', '),
          notes: data.notes || null,
          carrierSettings: account.settings || {},
          package: pkg,
          webhookUrl: webhookUrlForShipment(account),
        })
      );

      const shipment = await insertShipment(
        {
          workspaceId,
          orderId: order.id,
          carrierCode: adapter.code,
          waybillNumber: booked.trackingNumber,
          trackingUrl: booked.trackingUrl || null,
          carrierResponse: {
            ...booked.raw,
            carrierShipmentId: booked.carrierShipmentId,
            labelUrl: booked.labelUrl || null,
            address: { cityId: address.cityId, districtId: address.districtId, zoneId: address.zoneId },
            package: pkg ? { ...pkg, tierOverridden: Boolean(data.tierId) } : null,
          },
          status: 'created',
        },
        transaction
      );

      if (account.status !== 'active') await account.update({ status: 'active' }, { transaction });

      await recordAudit({
        workspaceId,
        actorUserId: req.user.id,
        action: 'shipment.create',
        entityType: 'Shipment',
        entityId: shipment.id,
        after: shipment.toJSON(),
        metadata: { source: 'carrier', carrierCode: adapter.code },
        req,
        transaction,
      });

      return shipment;
    });
  } catch (err) {
    if (booked) {
      // The courier has a parcel we failed to record. Try to take it back so
      // nobody collects an order we have no shipment for; either way, say so.
      logger.error('Carrier shipment created but not saved; cancelling it at the carrier', {
        workspaceId,
        orderId,
        carrierCode: adapter.code,
        trackingNumber: booked.trackingNumber,
        reason: err.message,
      });
      await adapter.cancelShipment(credentials, booked.trackingNumber).catch((cancelErr) =>
        logger.error('Could not cancel the orphaned carrier shipment — cancel it in the carrier dashboard', {
          carrierCode: adapter.code,
          trackingNumber: booked.trackingNumber,
          reason: cancelErr.message,
        })
      );
    }
    throw err;
  }
}

/**
 * Decides whether a carrier-reported status moves the shipment.
 * @returns {'apply'|'noop'|'blocked'}
 */
function decide(current, next) {
  if (!next || next === current) return 'noop';
  if (TERMINAL_STATUSES.includes(current)) {
    return current === 'delivered' && next === 'returned' ? 'apply' : 'blocked';
  }
  return 'apply';
}

/**
 * The single place a carrier's view of a shipment is applied — webhook, sync
 * and any future poller all come through here.
 *
 * Goes through the same transitionShipment as the merchant's PATCH (stamps,
 * fulfillment state, audit), with actor null and metadata.source 'carrier'.
 * Idempotent: the same status again writes nothing to the audit log; only the
 * stored carrier state is refreshed when the carrier's own code moved.
 */
async function applyCarrierStatus(workspaceId, shipmentId, result, { trigger }) {
  return db.sequelize.transaction(async (transaction) => {
    const shipment = await db.Shipment.findOne({
      where: { id: shipmentId, workspaceId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!shipment) throw new NotFoundError('Shipment');

    const previous = shipment.carrierResponse || {};
    const carrierState = result.carrierStatus || null;
    const stateMoved =
      carrierState && (!previous.lastCarrierStatus || previous.lastCarrierStatus.code !== carrierState.code);
    const carrierResponse = stateMoved ? { ...previous, lastCarrierStatus: carrierState } : undefined;

    const decision = decide(shipment.status, result.status);
    if (decision !== 'apply') {
      if (decision === 'blocked') {
        logger.info('Carrier status ignored: shipment is already final', {
          shipmentId: shipment.id,
          current: shipment.status,
          reported: result.status,
          carrierState,
        });
      }
      if (carrierResponse) await shipment.update({ carrierResponse }, { transaction });
      return { shipment, changed: false };
    }

    await transitionShipment(
      workspaceId,
      shipment,
      { status: result.status, carrierResponse },
      {
        transaction,
        actorUserId: null,
        metadata: { source: 'carrier', trigger, carrierCode: shipment.carrierCode, carrierStatus: carrierState },
      }
    );
    return { shipment, changed: true };
  });
}

async function findCarrierShipment(workspaceId, orderId, shipmentId) {
  const shipment = await db.Shipment.findOne({ where: { id: shipmentId, workspaceId, orderId } });
  if (!shipment) throw new NotFoundError('Shipment');
  if (!isCarrierBooked(shipment)) {
    throw new AppError('SHIPMENT_NOT_CARRIER_MANAGED', 'This shipment was not booked through a connected courier', 409);
  }
  return shipment;
}

/** POST /orders/:orderId/shipments/:shipmentId/sync */
async function syncShipment(workspaceId, orderId, shipmentId) {
  const shipment = await findCarrierShipment(workspaceId, orderId, shipmentId);
  const { adapter, account, credentials } = await accounts.loadConnection(workspaceId, shipment.carrierCode);
  const result = await accounts.withAuthHandling(account, () => adapter.getShipment(credentials, shipment.waybillNumber));
  const applied = await applyCarrierStatus(workspaceId, shipment.id, result, { trigger: 'sync' });
  return { shipment: applied.shipment, changed: applied.changed, carrierStatus: result.carrierStatus };
}

/** GET /orders/:orderId/shipments/:shipmentId/label — the carrier's own AWB. */
async function getShipmentLabel(workspaceId, orderId, shipmentId) {
  const shipment = await findCarrierShipment(workspaceId, orderId, shipmentId);
  const { adapter, account, credentials } = await accounts.loadConnection(workspaceId, shipment.carrierCode);
  if (!adapter.supportsLabel) {
    throw new AppError('LABEL_NOT_AVAILABLE', `${adapter.name} does not provide printable labels`, 409);
  }
  const pdf = await accounts.withAuthHandling(account, () =>
    adapter.getLabel(credentials, shipment.waybillNumber, account.settings || {})
  );
  return { pdf, filename: `${adapter.code}-${shipment.waybillNumber}.pdf` };
}

/**
 * After a refused cancel: whether the courier already has the delivery in a
 * state a cancel has nothing left to stop — said so in its error, or visible
 * in a fresh read of the delivery. Credentials the carrier rejected answer
 * no without another call; a failing read also answers no.
 */
async function alreadySettledAtCarrier(adapter, account, credentials, shipment, err) {
  const carrierMessage = (err && err.message) || '';
  if (ALREADY_CANCELLED_PATTERN.test(carrierMessage)) return { settled: true, via: 'error_message' };

  const settledStates = CARRIER_CANCEL_SETTLED_STATES[adapter.code];
  if (!settledStates || err instanceof CarrierAuthError) return { settled: false };
  try {
    const current = await adapter.getShipment(credentials, shipment.waybillNumber);
    const code = current && current.carrierStatus ? current.carrierStatus.code : null;
    if (code != null && settledStates.includes(Number(code))) return { settled: true, via: 'carrier_state', code };
  } catch (readErr) {
    logger.warn('Could not read the carrier delivery after a refused cancel', {
      carrierCode: adapter.code,
      accountId: account.id,
      trackingNumber: shipment.waybillNumber,
      reason: readErr.message,
    });
  }
  return { settled: false };
}

/**
 * Called by orderService.cancelOrder inside its transaction, before anything
 * local changes. Cancels every carrier-booked shipment the courier could
 * still act on — 'created' (not collected yet) and 'failed' (Bosta may
 * re-attempt an exception) — and marks each one cancelled locally. A delivery
 * the courier already cancelled/terminated counts as done. Any other refusal
 * throws, which rolls the whole cancellation back.
 */
async function cancelCarrierShipmentsForOrder(workspaceId, orderId, transaction) {
  const shipments = await db.Shipment.findAll({
    where: { workspaceId, orderId, status: ['created', 'failed'], carrierCode: { [Op.ne]: MANUAL } },
    transaction,
  });
  for (const shipment of shipments) {
    if (!isCarrierBooked(shipment)) continue;
    const { adapter, account, credentials } = await accounts.loadConnection(workspaceId, shipment.carrierCode, {
      transaction,
    });
    try {
      await accounts.withAuthHandling(account, () => adapter.cancelShipment(credentials, shipment.waybillNumber));
    } catch (err) {
      const check = await alreadySettledAtCarrier(adapter, account, credentials, shipment, err);
      if (!check.settled) {
        throw new AppError(
          'CARRIER_CANCEL_FAILED',
          `${adapter.name} did not cancel shipment ${shipment.waybillNumber}: ${err.message} The order was not cancelled.`,
          409,
          { shipmentId: shipment.id, carrierCode: adapter.code, carrierErrorCode: err.code || null }
        );
      }
      logger.info('Carrier refused the cancel but the delivery is already cancelled there', {
        workspaceId,
        orderId,
        carrierCode: adapter.code,
        trackingNumber: shipment.waybillNumber,
        via: check.via,
        carrierStateCode: check.code ?? null,
      });
    }
    const previousStatus = shipment.status;
    await shipment.update({ status: 'cancelled' }, { transaction });
    logger.info('Carrier shipment cancelled with the order', {
      workspaceId,
      orderId,
      carrierCode: adapter.code,
      trackingNumber: shipment.waybillNumber,
      previousStatus,
    });
  }
}

module.exports = {
  FINISHED_STATUSES,
  assertConfirmedOrPaid,
  shouldBookWithCarrier,
  assertNoActiveShipment,
  isCarrierBooked,
  createCarrierShipment,
  applyCarrierStatus,
  syncShipment,
  getShipmentLabel,
  cancelCarrierShipmentsForOrder,
  codAmountFor,
};
