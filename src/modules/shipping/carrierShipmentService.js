'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const logger = require('../../core/utils/logger');
const { recordAudit } = require('../audit/auditService');
const { insertShipment, transitionShipment } = require('../orders/shipmentLifecycle');
const { getAdapter, availableFor, assertSandboxAllowed, reservedAdapterFor, MANUAL } = require('./carriers');
const { isCityDistrict } = require('./carriers/adapterContract');
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

// After a manual-cancel acknowledgement the carrier is asked again this long
// later (carrierSyncService), to catch a parcel that was not really cancelled.
const CANCEL_CHECKS_MS = [24 * 60 * 60 * 1000, 72 * 60 * 60 * 1000];

/** When a shipment a polled carrier just booked is first read; null when never. */
function firstPollAt(adapter, now = new Date()) {
  return adapter.capabilities.polling ? new Date(now.getTime() + adapter.pollIntervalMinutes * 60 * 1000) : null;
}

/** The shipment fields a manual-cancel acknowledgement writes. */
function manualCancelFields(actorUserId, now = new Date()) {
  return {
    status: 'cancelled',
    cancelMode: 'manual_ack',
    cancelAcknowledgedBy: actorUserId || null,
    cancelAcknowledgedAt: now,
    nextPollAt: new Date(now.getTime() + CANCEL_CHECKS_MS[0]),
    pollFailures: 0,
  };
}

const FLAG_CANCEL_UNCONFIRMED = 'carrier_cancel_unconfirmed';

// A webhook or a manual sync after a manual cancel that says the parcel is
// moving (or was delivered) means the carrier never cancelled it. 'created'
// and 'failed' are not proof of that on their own.
const UNCONFIRMED_CANCEL_STATUSES = ['picked_up', 'in_transit', 'out_for_delivery', 'delivered'];

// applyCarrierStatus trigger -> the trigger recorded on the flag's audit row.
// The scheduled checks flag through carrierSyncService ('cancel_check').
const UNCONFIRMED_CANCEL_TRIGGERS = { webhook: 'webhook', sync: 'manual_sync' };

/**
 * The carrier still has a parcel the merchant said they cancelled there. Our
 * shipment stays cancelled; the order gets the carrier_cancel_unconfirmed
 * flag (once) and the audit log a row. Shared by the scheduled checks
 * (carrierSyncService), webhooks and the manual sync button (applyCarrierStatus).
 *
 * @param {object} shipment  { id, orderId, workspaceId, carrierCode, waybillNumber }
 * @param {object} result    the carrier's reading: { status, carrierStatus }
 * @param {object} ctx       { trigger, check?, transaction? }
 */
async function flagUnconfirmedCancel(shipment, result, { trigger, check = null, transaction: outer = null }) {
  const run = async (transaction) => {
    const order = await db.Order.findOne({
      where: { id: shipment.orderId, workspaceId: shipment.workspaceId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!order) return;
    const flags = order.riskFlags || [];
    if (!flags.includes(FLAG_CANCEL_UNCONFIRMED)) {
      await order.update({ riskFlags: [...flags, FLAG_CANCEL_UNCONFIRMED] }, { transaction });
    }
    await recordAudit({
      workspaceId: shipment.workspaceId,
      actorUserId: null,
      action: 'shipment.carrier_cancel_unconfirmed',
      entityType: 'Shipment',
      entityId: shipment.id,
      after: { orderId: shipment.orderId, riskFlags: order.riskFlags },
      metadata: {
        source: 'carrier',
        trigger,
        check,
        carrierCode: shipment.carrierCode,
        trackingNumber: shipment.waybillNumber,
        reportedStatus: result.status,
        carrierStatus: result.carrierStatus || null,
      },
      transaction,
    });
  };
  if (outer) return run(outer);
  return db.sequelize.transaction(run);
}

const cancelsManually = (adapter) => Boolean(adapter && adapter.capabilities.cancel === 'manual');

/**
 * 409 CARRIER_MANUAL_CANCEL_REQUIRED: these shipments can only be cancelled
 * in the carrier's own dashboard. The request is repeated with
 * acknowledgeManualCancel: true once the merchant has done that.
 */
function manualCancelRequired(entries) {
  const names = [...new Set(entries.map((e) => e.adapter.name))].join(', ');
  const numbers = entries.map((e) => e.shipment.waybillNumber).join(', ');
  return new AppError(
    'CARRIER_MANUAL_CANCEL_REQUIRED',
    `${names} can't be cancelled from here. Cancel shipment ${numbers} in the ${names} dashboard first, then confirm you did.`,
    409,
    {
      shipments: entries.map(({ shipment, adapter }) => ({
        shipmentId: shipment.id,
        carrierCode: adapter.code,
        carrierName: adapter.name,
        waybillNumber: shipment.waybillNumber,
      })),
    }
  );
}

/**
 * Whether POST /shipments should book with a courier (true) or record a
 * manual shipment (false). A courier booking is exactly the adapter's code
 * — what the dashboard's courier option sends — on a store that connected
 * it, with no waybill/tracking URL (the courier assigns those; a request
 * carrying them was typed into the manual form). Any other spelling of a
 * courier's name ("Bosta", " BOSTA ") is refused with 422: manual shipments
 * are local records only and must never look like, or become, a booking.
 * A carrier's name is only reserved on stores that connected it, unless the
 * adapter reserves it everywhere (Bosta); a carrier the store can't see
 * (not enabled, or beta elsewhere) reserves nothing.
 * Checked without decrypting anything, so a connected store on a server
 * without CARRIER_CREDENTIALS_KEY still gets the 503.
 */
async function shouldBookWithCarrier(workspaceId, data) {
  const adapter = reservedAdapterFor(data.carrierCode);
  if (!adapter || !(await availableFor(adapter, workspaceId))) return false;

  const connected = (await db.CarrierAccount.count({ where: { workspaceId, carrierCode: adapter.code } })) > 0;
  if (!connected && !adapter.capabilities.reserveNameWhenUnconnected) return false;
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

/** The drop-off address as kept on the shipment: the carrier's ids only. */
function storedAddress(adapter, address) {
  if (isCityDistrict(adapter.capabilities.addressLevels)) {
    return { cityId: address.cityId, districtId: address.districtId, zoneId: address.zoneId };
  }
  return { path: address.path.map((node) => node.id) };
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
  // Checked again at booking: a store that left the test list keeps its
  // stored sandbox connection, and must not book real orders into it.
  await assertSandboxAllowed(adapter, credentials, workspaceId, { booking: true });

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

      const address = await matchAddress(adapter, index, order.shippingAddressSnapshot, data.carrierAddress);

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
          carrierAccountId: account.id,
          nextPollAt: firstPollAt(adapter),
          waybillNumber: booked.trackingNumber,
          trackingUrl: booked.trackingUrl || null,
          carrierResponse: {
            ...booked.raw,
            carrierShipmentId: booked.carrierShipmentId,
            labelUrl: booked.labelUrl || null,
            address: storedAddress(adapter, address),
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
    if (booked && cancelsManually(adapter)) {
      // The courier has a parcel we failed to record, and no API to take it
      // back: only the merchant can, in the carrier's dashboard.
      logger.error('Carrier shipment created but not saved; it must be cancelled in the carrier dashboard', {
        workspaceId,
        orderId,
        carrierCode: adapter.code,
        trackingNumber: booked.trackingNumber,
        reason: err.message,
      });
      await recordAudit({
        workspaceId,
        actorUserId: req.user.id,
        action: 'shipment.booking_not_saved',
        entityType: 'Order',
        entityId: orderId,
        metadata: { carrierCode: adapter.code, trackingNumber: booked.trackingNumber, manualCancelRequired: true },
        req,
      }).catch((auditErr) => logger.error('Could not audit the unsaved carrier booking', { reason: auditErr.message }));
      throw new AppError(
        'CARRIER_BOOKING_NOT_SAVED',
        `${adapter.name} created shipment ${booked.trackingNumber}, but it could not be saved here. Cancel it in the ${adapter.name} dashboard, then book the order again.`,
        502,
        { carrierCode: adapter.code, trackingNumber: booked.trackingNumber, manualCancelRequired: true }
      );
    }
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
      await adapter.cancelShipment(credentials, booked.trackingNumber, { carrierShipmentId: booked.carrierShipmentId }).catch((cancelErr) =>
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
    const finalStatus = decision === 'apply' ? result.status : shipment.status;
    // A final shipment is not polled any more — except the checks that
    // follow a manual cancel, which carrierSyncService schedules itself.
    const stopPolling = Boolean(
      shipment.nextPollAt && TERMINAL_STATUSES.includes(finalStatus) && shipment.cancelMode !== 'manual_ack'
    );
    // A webhook or manual sync contradicting a manual cancel: flag the
    // order, keep the status (a cancelled shipment is final, so decision is
    // 'blocked').
    const flagTrigger = UNCONFIRMED_CANCEL_TRIGGERS[trigger];
    if (
      flagTrigger &&
      shipment.status === 'cancelled' &&
      shipment.cancelMode === 'manual_ack' &&
      UNCONFIRMED_CANCEL_STATUSES.includes(result.status)
    ) {
      await flagUnconfirmedCancel(shipment, result, { trigger: flagTrigger, transaction });
      logger.warn('Carrier shows a manually cancelled parcel still moving; order flagged', {
        shipmentId: shipment.id,
        orderId: shipment.orderId,
        carrierCode: shipment.carrierCode,
        reportedStatus: result.status,
        trigger: flagTrigger,
      });
    }
    if (decision !== 'apply') {
      if (decision === 'blocked') {
        logger.info('Carrier status ignored: shipment is already final', {
          shipmentId: shipment.id,
          current: shipment.status,
          reported: result.status,
          carrierState,
        });
      }
      if (carrierResponse || stopPolling) {
        await shipment.update(
          { ...(carrierResponse ? { carrierResponse } : {}), ...(stopPolling ? { nextPollAt: null } : {}) },
          { transaction }
        );
      }
      return { shipment, changed: false };
    }

    await transitionShipment(
      workspaceId,
      shipment,
      { status: result.status, carrierResponse, ...(stopPolling ? { nextPollAt: null } : {}) },
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
  if (adapter.alreadyCancelledPattern.test(carrierMessage)) return { settled: true, via: 'error_message' };

  if (typeof adapter.isCancelSettled !== 'function' || err instanceof CarrierAuthError) return { settled: false };
  try {
    const current = await adapter.getShipment(credentials, shipment.waybillNumber);
    const carrierStatus = current && current.carrierStatus ? current.carrierStatus : null;
    if (adapter.isCancelSettled(carrierStatus)) return { settled: true, via: 'carrier_state', code: carrierStatus.code };
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
 * Called by orderService.cancelOrder (and a confirmation correction to
 * rejected) inside its transaction, before anything local changes. Cancels
 * every carrier-booked shipment the courier could still act on — 'created'
 * (not collected yet) and 'failed' (Bosta may re-attempt an exception) — and
 * marks each one cancelled locally. A delivery the courier already
 * cancelled/terminated counts as done. Any other refusal throws, which rolls
 * the whole cancellation back.
 *
 * A carrier without a cancel API (capabilities.cancel 'manual') needs the
 * merchant's word that they cancelled it in the carrier's dashboard:
 * without `acknowledgeManualCancel` this throws 409
 * CARRIER_MANUAL_CANCEL_REQUIRED before any carrier is called; with it the
 * shipment is marked cancelled (cancel_mode 'manual_ack') and the carrier is
 * checked again later (carrierSyncService).
 */
async function cancelCarrierShipmentsForOrder(workspaceId, orderId, transaction, options = {}) {
  const { acknowledgeManualCancel = false, req = null, trigger = 'order_cancel' } = options;
  const shipments = await db.Shipment.findAll({
    where: { workspaceId, orderId, status: ['created', 'failed'], carrierCode: { [Op.ne]: MANUAL } },
    transaction,
  });
  const booked = shipments
    .filter(isCarrierBooked)
    .map((shipment) => ({ shipment, adapter: getAdapter(shipment.carrierCode) }));
  const manual = booked.filter((entry) => cancelsManually(entry.adapter));
  if (manual.length > 0 && !acknowledgeManualCancel) throw manualCancelRequired(manual);

  for (const { shipment, adapter: bookedWith } of booked) {
    if (cancelsManually(bookedWith)) {
      await acknowledgeManualCancelOf(workspaceId, shipment, { transaction, req, trigger });
      continue;
    }
    const { adapter, account, credentials } = await accounts.loadConnection(workspaceId, shipment.carrierCode, {
      transaction,
    });
    try {
      await accounts.withAuthHandling(account, () =>
        adapter.cancelShipment(credentials, shipment.waybillNumber, {
          carrierShipmentId: shipment.carrierResponse ? shipment.carrierResponse.carrierShipmentId : null,
        })
      );
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
    await shipment.update({ status: 'cancelled', cancelMode: 'api', nextPollAt: null }, { transaction });
    logger.info('Carrier shipment cancelled with the order', {
      workspaceId,
      orderId,
      carrierCode: adapter.code,
      trackingNumber: shipment.waybillNumber,
      previousStatus,
    });
  }
}

/** Marks one manually-cancelled carrier shipment, with its audit row. */
async function acknowledgeManualCancelOf(workspaceId, shipment, { transaction, req, trigger }) {
  const actorUserId = req && req.user ? req.user.id : null;
  await transitionShipment(workspaceId, shipment, manualCancelFields(actorUserId), {
    transaction,
    req,
    actorUserId,
    metadata: { source: 'merchant', trigger, carrierCode: shipment.carrierCode, cancelMode: 'manual_ack' },
  });
  logger.info('Carrier shipment cancelled by hand at the carrier (acknowledged)', {
    workspaceId,
    shipmentId: shipment.id,
    carrierCode: shipment.carrierCode,
    trackingNumber: shipment.waybillNumber,
  });
}

/**
 * PATCH .../shipments/:id to 'cancelled' on a carrier-booked shipment of a
 * carrier without a cancel API: refused (409 CARRIER_MANUAL_CANCEL_REQUIRED)
 * unless acknowledgeManualCancel is sent. Returns the extra fields the
 * update must write, or {} when the rule doesn't apply.
 */
function manualCancelUpdates(shipment, data, req) {
  if (data.status !== 'cancelled' || TERMINAL_STATUSES.includes(shipment.status) || !isCarrierBooked(shipment)) {
    return {};
  }
  const adapter = getAdapter(shipment.carrierCode);
  if (!cancelsManually(adapter)) return {};
  if (!data.acknowledgeManualCancel) throw manualCancelRequired([{ shipment, adapter }]);
  return manualCancelFields(req && req.user ? req.user.id : null);
}

module.exports = {
  FINISHED_STATUSES,
  TERMINAL_STATUSES,
  CANCEL_CHECKS_MS,
  FLAG_CANCEL_UNCONFIRMED,
  flagUnconfirmedCancel,
  firstPollAt,
  manualCancelUpdates,
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
