'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const tokens = require('./campaignTokens');

/**
 * A recipient leaves the store's marketing emails — from the link at the foot
 * of the email (the store's /unsubscribe page, or the one-click POST mail apps
 * make from the List-Unsubscribe header), or because the provider reported a
 * spam complaint or an unsubscribe. Each time:
 *   - the recipient row is marked (and the campaign's count moves, once);
 *   - the address (and the customer's phone) is added to marketing_opt_outs,
 *     which every campaign (campaignAudience.js), the abandoned-cart email and
 *     the automations (automations/marketingGuard.js) leave out from then on;
 *   - the customer's marketing consent goes false.
 * Running it twice changes nothing more. Only the customer opting in again
 * (the newsletter, the checkout box, their account) brings them back.
 */

async function unsubscribeRecipient(row, { via }) {
  const workspaceId = row.workspaceId;
  const email = String(row.email).trim().toLowerCase();
  await db.sequelize.transaction(async (transaction) => {
    await db.sequelize.query(
      `WITH r AS (
         UPDATE email_campaign_recipients SET unsubscribed_at = NOW() WHERE id = :id AND unsubscribed_at IS NULL RETURNING campaign_id)
       UPDATE email_campaigns SET unsubscribed_count = unsubscribed_count + 1, updated_at = NOW() WHERE id IN (SELECT campaign_id FROM r)`,
      { replacements: { id: row.id }, transaction }
    );
    const customerId = row.customerId || null;
    // One stop covers both channels, as the abandoned-cart email's link does (notifications/marketingUnsubscribe.js):
    // the address, and the customer's phone when there is one.
    const customer = customerId ? await db.Customer.findOne({ where: { id: customerId, workspaceId }, attributes: ['id', 'phoneNormalized'], transaction }) : null;
    const phoneNormalized = customer && customer.phoneNormalized ? customer.phoneNormalized : null;
    const word = via === 'complaint' ? 'complaint' : 'unsubscribe';
    const emailTaken = await db.MarketingOptOut.count({ where: { workspaceId, email }, transaction });
    if (phoneNormalized) {
      const [optOut] = await db.MarketingOptOut.findOrCreate({
        where: { workspaceId, phoneNormalized },
        defaults: { workspaceId, phoneNormalized, email: emailTaken ? null : email, source: 'email', word },
        transaction,
      });
      if (!emailTaken && !optOut.email) await optOut.update({ email }, { transaction });
    } else if (!emailTaken) {
      await db.MarketingOptOut.create({ workspaceId, email, source: 'email', word }, { transaction });
    }
    if (customerId) {
      await db.Customer.update({ marketingConsent: false }, { where: { id: customerId, workspaceId, marketingConsent: true }, transaction });
    }
    // Any other customer row of the store with the same address leaves too.
    await db.sequelize.query(
      'UPDATE customers SET marketing_consent = FALSE, updated_at = NOW() WHERE workspace_id = :workspaceId AND lower(trim(email)) = :email AND marketing_consent = TRUE',
      { replacements: { workspaceId, email }, transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: null,
      action: 'customer.marketing_consent.withdrawn',
      entityType: 'Customer',
      entityId: customerId,
      metadata: { via: `email_campaign_${via}`, campaignId: row.campaignId, recipientId: row.id },
      transaction,
    });
  });
  logger.info(`[emailCampaigns] recipient ${row.id} of campaign ${row.campaignId} unsubscribed (${via})`);
}

/** The token from a link: the recipient it names, in `workspaceId` when given. Throws 404 INVALID_LINK. */
async function recipientFor(token, workspaceId = null) {
  const named = tokens.readToken(token);
  if (!named || (workspaceId && named.workspaceId !== workspaceId)) throw new AppError('INVALID_LINK', 'This link is not valid', 404);
  const row = await db.EmailCampaignRecipient.findOne({
    where: { id: named.recipientId, workspaceId: named.workspaceId },
    attributes: ['id', 'campaignId', 'workspaceId', 'customerId', 'email'],
  });
  if (!row) throw new AppError('INVALID_LINK', 'This link is not valid', 404);
  return row;
}

async function unsubscribeByToken(token, { workspaceId = null, via = 'link' } = {}) {
  const row = await recipientFor(token, workspaceId);
  await unsubscribeRecipient(row, { via });
  const workspace = await db.Workspace.findByPk(row.workspaceId, { attributes: ['id', 'name'] });
  return { storeName: workspace ? workspace.name : '' };
}

module.exports = { unsubscribeRecipient, unsubscribeByToken, recipientFor };
