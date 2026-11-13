'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { recordAudit } = require('../audit/auditService');

/**
 * The shopper ticked "Email me offers" at checkout (EMAIL_CAMPAIGNS_ENABLED;
 * off, the box isn't shown and `marketingConsent` is ignored). The order's
 * customer gains marketing consent, and an earlier unsubscribe of that
 * address is lifted: ticking the box is opting in again, as the newsletter
 * sign-up is (offers/engagement.js). An unticked box changes nothing — it
 * never takes a consent away. Never throws: the order stands either way.
 */
async function recordCheckoutConsent(order, marketingConsent) {
  if (!env.emailCampaigns.enabled || marketingConsent !== true || !order || !order.customerId) return false;
  try {
    const customer = await db.Customer.findOne({ where: { id: order.customerId, workspaceId: order.workspaceId } });
    if (!customer || !customer.email) return false;
    const email = String(customer.email).trim().toLowerCase();
    if (!customer.marketingConsent) await customer.update({ marketingConsent: true });
    await db.MarketingOptOut.destroy({ where: { workspaceId: order.workspaceId, email } });
    await recordAudit({
      workspaceId: order.workspaceId,
      actorUserId: null,
      action: 'customer.marketing_consent.given',
      entityType: 'Customer',
      entityId: customer.id,
      metadata: { via: 'checkout', orderId: order.id },
    });
    return true;
  } catch (err) {
    logger.error(`[emailCampaigns] checkout consent for order ${order.id} not recorded: ${err.message}`);
    return false;
  }
}

/** The shopper turned marketing emails on in their account: an earlier unsubscribe of their address is lifted too. */
async function recordAccountConsent(customer) {
  if (!env.emailCampaigns.enabled || !customer || !customer.marketingConsent || !customer.email) return;
  await db.MarketingOptOut.destroy({ where: { workspaceId: customer.workspaceId, email: String(customer.email).trim().toLowerCase() } });
}

module.exports = { recordCheckoutConsent, recordAccountConsent };
