'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { NotFoundError } = require('../../core/errors/AppError');
const { getAdapter } = require('./carriers');
const accounts = require('./carrierAccountService');
const { applyCarrierStatus } = require('./carrierShipmentService');

/**
 * POST /webhooks/carriers/:code/:token.
 *
 * The token in the URL is the only identity (Bosta's per-delivery webhook has
 * no signature). The payload itself is never trusted: the adapter pulls out
 * the tracking number and nothing else, and the status is re-read from the
 * carrier's API with the merchant's credentials. A forged body can at most
 * make us ask Bosta about a parcel — Bosta's answer is what gets applied.
 *
 * The carrier gets its 200 before that fetch runs. Bosta documents no retry
 * policy, so we never answer a known token with a 5xx: a failure is logged,
 * and the merchant can always POST .../sync.
 */

// 32 random bytes as base64url — exactly what carrierAccountService issues.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const inFlight = new Set();

function track(promise) {
  inFlight.add(promise);
  promise.finally(() => inFlight.delete(promise));
  return promise;
}

/** Resolves once every accepted webhook has finished processing (tests, shutdown). */
async function whenIdle() {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

async function resolveAccount(code, token) {
  const adapter = getAdapter(code);
  if (!adapter || typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new NotFoundError('Webhook');

  // Unique-index lookup; the constant-time compare is belt and braces against
  // any collation/normalisation surprise in the lookup itself.
  const account = await db.CarrierAccount.scope('withCredentials').findOne({
    where: { carrierCode: code, webhookToken: token },
  });
  if (!account) throw new NotFoundError('Webhook');
  const a = Buffer.from(account.webhookToken, 'utf8');
  const b = Buffer.from(token, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new NotFoundError('Webhook');
  return { adapter, account };
}

async function processUpdate(adapter, account, ref) {
  const shipment = await db.Shipment.findOne({
    // Only shipments we booked (they carry a carrierResponse); a manual row
    // that merely shares the tracking number is never touched.
    where: {
      workspaceId: account.workspaceId,
      carrierCode: adapter.code,
      waybillNumber: ref,
      carrierResponse: { [Op.ne]: null },
    },
  });
  if (!shipment) {
    logger.info('Carrier webhook for an unknown shipment — acknowledged and ignored', {
      workspaceId: account.workspaceId,
      carrierCode: adapter.code,
      ref,
    });
    return;
  }

  const credentials = accounts.decryptFor(account);
  const result = await accounts.withAuthHandling(account, () => adapter.getShipment(credentials, ref));
  const { changed } = await applyCarrierStatus(account.workspaceId, shipment.id, result, { trigger: 'webhook' });
  logger.info('Carrier webhook processed', {
    workspaceId: account.workspaceId,
    shipmentId: shipment.id,
    changed,
    carrierStatus: result.carrierStatus && result.carrierStatus.code,
  });
}

/**
 * Validates the token (throws 404 when unknown) and returns the work to run
 * after the response, or null when the payload names no shipment.
 */
async function accept(code, token, req) {
  const { adapter, account } = await resolveAccount(code, token);
  const parsed = adapter.parseWebhook(req);
  if (!parsed) {
    logger.warn('Carrier webhook without a usable shipment reference', { carrierCode: code, workspaceId: account.workspaceId });
    return null;
  }
  return () =>
    track(
      processUpdate(adapter, account, parsed.ref).catch((err) =>
        logger.error('Carrier webhook processing failed', {
          carrierCode: code,
          workspaceId: account.workspaceId,
          ref: parsed.ref,
          code: err.code,
          message: err.message,
        })
      )
    );
}

module.exports = { accept, whenIdle, TOKEN_PATTERN };
