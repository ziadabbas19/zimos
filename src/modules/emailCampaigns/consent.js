'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { recordAudit } = require('../audit/auditService');
const signupSettings = require('./signupSettings');

/**
 * Marketing email consent, written in one place for every place a shopper can
 * give it (signupSettings.js): the checkout, the quick order form and the
 * cart boxes, and the footer and popup signups. The rules:
 *
 *   - only a yes is written. A box left unticked, or unticked before the order
 *     was placed, changes nothing: it never takes a consent away;
 *   - the store's customers with the address gain the consent (the order's own
 *     customer for a box; every customer of the store with that address for a
 *     signup, as an unsubscribe takes it from all of them). With no such
 *     customer, the address becomes a lightweight subscriber (email_subscribers):
 *     a customer needs a phone, a signup has none;
 *   - the source is recorded with a consent that was not there yet; one already
 *     given keeps its own;
 *   - an earlier unsubscribe of the address is lifted: signing up again is
 *     opting in again, as the newsletter sign-up is (offers/engagement.js);
 *   - nothing is sent to the shopper (no welcome email), and the address never
 *     goes to the log.
 */

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const normalize = (email) => {
  const value = String(email || '').trim().toLowerCase();
  return value && value.length <= 255 && EMAIL_SHAPE.test(value) ? value : null;
};

/**
 * Gives `email` marketing consent from `source` (checkout | quick_order | cart |
 * footer | popup). `customerId`: the one customer it is for (a box at checkout);
 * left out, every customer of the store with the address, else a subscriber.
 * Answers whether anything changed.
 */
async function grant({ workspaceId, email, customerId = null, source, metadata = {} }) {
  const address = normalize(email);
  if (!address || !signupSettings.SOURCES.includes(source)) return false;
  return db.sequelize.transaction(async (transaction) => {
    const customers = customerId
      ? await db.Customer.findAll({ where: { id: customerId, workspaceId }, attributes: ['id', 'marketingConsent'], transaction, lock: transaction.LOCK.UPDATE })
      : await db.sequelize.query(
          `SELECT id, marketing_consent AS "marketingConsent" FROM customers
            WHERE workspace_id = :workspaceId AND email IS NOT NULL AND lower(trim(email)) = :email
            ORDER BY created_at, id FOR UPDATE`,
          { replacements: { workspaceId, email: address }, type: QueryTypes.SELECT, transaction }
        );

    let changed = false;
    let subscriberId = null;
    const fresh = customers.filter((c) => !c.marketingConsent).map((c) => c.id);
    if (fresh.length) {
      await db.Customer.update({ marketingConsent: true, marketingConsentSource: source }, { where: { id: fresh, workspaceId }, transaction });
      changed = true;
    }
    if (!customers.length) {
      const [row] = await db.sequelize.query(
        `INSERT INTO email_subscribers (id, workspace_id, email, marketing_consent, source, consented_at, created_at, updated_at)
         VALUES (gen_random_uuid(), :workspaceId, :email, TRUE, :source, NOW(), NOW(), NOW())
         ON CONFLICT (workspace_id, email) DO UPDATE
            SET source = CASE WHEN email_subscribers.marketing_consent THEN email_subscribers.source ELSE EXCLUDED.source END,
                consented_at = CASE WHEN email_subscribers.marketing_consent THEN email_subscribers.consented_at ELSE NOW() END,
                marketing_consent = TRUE,
                updated_at = CASE WHEN email_subscribers.marketing_consent THEN email_subscribers.updated_at ELSE NOW() END
         RETURNING id, (xmax = 0) AS inserted, (consented_at >= NOW()) AS consented_now`,
        { replacements: { workspaceId, email: address, source }, type: QueryTypes.SELECT, transaction }
      );
      subscriberId = row.id;
      if (row.inserted || row.consented_now) changed = true;
    }
    // Opting in again after an unsubscribe from a marketing email (notifications/marketingUnsubscribe.js).
    const lifted = await db.MarketingOptOut.destroy({ where: { workspaceId, email: address }, transaction });
    if (lifted) changed = true;

    if (changed) {
      await recordAudit({
        workspaceId,
        actorUserId: null,
        action: 'customer.marketing_consent.given',
        entityType: subscriberId ? 'EmailSubscriber' : 'Customer',
        entityId: subscriberId || customers[0].id,
        metadata: { via: source, customers: customers.length, optOutLifted: Boolean(lifted), ...metadata },
        transaction,
      });
    }
    return changed;
  });
}

/**
 * After a checkout (the page's box, the quick order form's, or the cart's
 * carried along). `marketingConsent` true: the order's customer gains consent
 * from `source`, when that place is switched on. Anything else records
 * nothing, and an earlier footer or popup signup of the customer's address is
 * carried over to the customer (adopt). Never throws: the order stands.
 */
async function recordCheckoutConsent(order, marketingConsent, { source = 'checkout', workspace = null } = {}) {
  if (!env.emailCampaigns.enabled || !order || !order.customerId) return false;
  try {
    const customer = await db.Customer.findOne({ where: { id: order.customerId, workspaceId: order.workspaceId }, attributes: ['id', 'email', 'marketingConsent'] });
    if (!customer || !customer.email) return false;
    if (marketingConsent !== true) {
      await adopt(order.workspaceId, customer);
      return false;
    }
    const store = workspace || (await db.Workspace.findByPk(order.workspaceId, { attributes: ['id', 'settings'] }));
    const place = signupSettings.PLACE_OF[source];
    if (!place || !signupSettings.BOX_PLACES.includes(place) || !(await signupSettings.placeOpen(store, place))) return false;
    return await grant({ workspaceId: order.workspaceId, email: customer.email, customerId: customer.id, source, metadata: { orderId: order.id } });
  } catch (err) {
    logger.error(`[emailCampaigns] checkout consent for order ${order.id} not recorded: ${err.message}`);
    return false;
  }
}

/**
 * A customer without consent whose address signed up from the footer or the
 * popup before they ordered: the subscriber's consent (and its source) moves
 * to the customer, who is the one campaigns read from now on.
 */
async function adopt(workspaceId, customer) {
  if (customer.marketingConsent) return false;
  const email = normalize(customer.email);
  if (!email) return false;
  const subscriber = await db.EmailSubscriber.findOne({ where: { workspaceId, email, marketingConsent: true }, attributes: ['id', 'source'] });
  if (!subscriber) return false;
  if (await db.MarketingOptOut.count({ where: { workspaceId, email } })) return false;
  const [updated] = await db.Customer.update(
    { marketingConsent: true, marketingConsentSource: subscriber.source },
    { where: { id: customer.id, workspaceId, marketingConsent: false } }
  );
  return updated > 0;
}

/** The shopper turned marketing emails on in their account: an earlier unsubscribe of their address is lifted too. */
async function recordAccountConsent(customer) {
  if (!env.emailCampaigns.enabled || !customer || !customer.marketingConsent || !customer.email) return;
  await db.MarketingOptOut.destroy({ where: { workspaceId: customer.workspaceId, email: String(customer.email).trim().toLowerCase() } });
}

module.exports = { normalize, grant, recordCheckoutConsent, recordAccountConsent, adopt };
