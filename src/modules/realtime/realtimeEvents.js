'use strict';

const env = require('../../config/env');
const logger = require('../../core/utils/logger');

/**
 * The outbox events only the live updates read (catalog.js). Recorded while
 * REALTIME_ENABLED is on, and never otherwise: with it off nothing new is
 * written. Recording never fails the change it reports (core/outbox).
 *
 *   order.stage_changed  orders/orderStatusHistory.sync, on a move between stages
 *   subscription.paid    billing/subscriptionChargeService.settlePaid
 *   merchant.created     a sign-up, from its audit entry (onAudit below)
 *   ticket.created       a support ticket, from its audit entry
 *   referral.used        a store entered a referral code, from its audit entry
 */

async function record(transaction, type, payload, options = {}) {
  if (!env.realtime.enabled) return null;
  try {
    // Required here: outbox → queue → registry loads every module's jobs.js.
    // eslint-disable-next-line global-require
    return await require('../../core/outbox/outbox').record(transaction || null, type, payload, options);
  } catch (err) {
    logger.error(`[realtime] could not record ${type}: ${err.message}`);
    return null;
  }
}

// audit action → [event type, payload, aggregate]
const FROM_AUDIT = {
  'user.register': (e) => ['merchant.created', { userId: e.entityId }, { aggregateType: 'user', aggregateId: e.entityId }],
  'user.register.google': (e) => ['merchant.created', { userId: e.entityId }, { aggregateType: 'user', aggregateId: e.entityId }],
  'support_ticket.create': (e) => ['ticket.created', { workspaceId: e.workspaceId, ticketId: e.entityId }, {}],
  'subscription.referral_code_attach': (e) => ['referral.used', { workspaceId: e.workspaceId }, { aggregateType: 'workspace', aggregateId: e.workspaceId }],
};

/** Called by audit/auditService for every entry, in its transaction. Never throws. */
async function onAudit(entry) {
  if (!env.realtime.enabled) return;
  const rule = FROM_AUDIT[entry.action];
  if (!rule || !entry.entityId) return;
  const [type, payload, options] = rule(entry);
  await record(entry.transaction, type, payload, options);
}

module.exports = { record, onAudit };
