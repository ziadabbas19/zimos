'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const env = require('../../config/env');
const validate = require('../../core/middleware/validate');
const { AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * STOP for marketing emails (SPEC §14.5, §6.4): the abandoned-cart email ends
 * with an unsubscribe link, the email form of the STOP reply on WhatsApp.
 *
 * The link names the checkout it was sent for, signed here, so it cannot be
 * forged to unsubscribe somebody else. Opening it records the checkout's
 * email in marketing_opt_outs, and its phone too when it had one. One STOP
 * covers both channels, as a STOP reply on WhatsApp does: the person asked
 * the store to stop marketing to them. automations/marketingGuard.js then
 * skips them for every marketing message. A newsletter sign-up opts back in
 * (offers/engagement.js).
 *
 *   POST /store/:workspaceId/marketing/unsubscribe { token } → { ok, storeName }
 *
 * With EMAIL_CAMPAIGNS_ENABLED it also takes a campaign email's token
 * (`c1.…`, emailCampaigns/campaignUnsubscribe.js): the same page serves both.
 */

const signingKey = crypto.createHash('sha256').update(`marketing-unsubscribe:${env.jwt.accessSecret}`).digest();
const sign = (payload) => crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');

function tokenFor(workspaceId, checkoutSessionId) {
  const payload = `${workspaceId}.${checkoutSessionId}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

/** The checkout id the token names for this store, or null. */
function readToken(token, workspaceId) {
  if (typeof token !== 'string') return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  const payload = Buffer.from(encoded, 'base64url').toString('utf8');
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const [ws, sessionId] = payload.split('.');
  return ws === workspaceId && sessionId ? sessionId : null;
}

/** The link for one checkout, on the store's own address; null when the store has none. */
function linkFor(base, workspaceId, checkoutSessionId) {
  return base ? `${base}/unsubscribe?t=${encodeURIComponent(tokenFor(workspaceId, checkoutSessionId))}` : null;
}

async function unsubscribe(workspace, token) {
  const sessionId = readToken(token, workspace.id);
  if (!sessionId) throw new AppError('INVALID_LINK', 'This link is not valid', 404);
  const session = await db.CheckoutSession.findOne({ where: { id: sessionId, workspaceId: workspace.id } });
  if (!session) throw new AppError('INVALID_LINK', 'This link is not valid', 404);
  const contact = session.contactFields || {};
  const email = typeof contact.email === 'string' && contact.email.trim() ? contact.email.trim().toLowerCase().slice(0, 255) : null;
  const phoneNormalized = session.phoneNormalized || null;
  if (!email && !phoneNormalized) return;

  await db.sequelize.transaction(async (transaction) => {
    // The address may already be on a row of its own (an earlier unsubscribe without a phone).
    const emailTaken = email ? await db.MarketingOptOut.count({ where: { workspaceId: workspace.id, email }, transaction }) : 0;
    if (phoneNormalized) {
      const [row] = await db.MarketingOptOut.findOrCreate({
        where: { workspaceId: workspace.id, phoneNormalized },
        defaults: { workspaceId: workspace.id, phoneNormalized, email: emailTaken ? null : email, source: 'email', word: 'unsubscribe' },
        transaction,
      });
      if (email && !emailTaken && !row.email) await row.update({ email }, { transaction });
    } else if (!emailTaken) {
      await db.MarketingOptOut.create({ workspaceId: workspace.id, email, source: 'email', word: 'unsubscribe' }, { transaction });
    }
    if (phoneNormalized) {
      await db.Customer.update({ marketingConsent: false }, { where: { workspaceId: workspace.id, phoneNormalized, marketingConsent: true }, transaction });
    }
    await recordAudit({
      workspaceId: workspace.id,
      actorUserId: null,
      action: 'customer.marketing_consent.withdrawn',
      entityType: 'CheckoutSession',
      entityId: session.id,
      metadata: { via: 'email', phoneNormalized, email },
      transaction,
    });
  });
}

const router = Router({ mergeParams: true });
router.post(
  '/marketing/unsubscribe',
  validate({ body: Joi.object({ token: Joi.string().max(500).required() }) }),
  asyncHandler(async (req, res) => {
    // A campaign email's link (emailCampaigns/campaignTokens.js, `c1.`): its own token, same page.
    const campaigns = require('../emailCampaigns/campaignTokens');
    if (env.emailCampaigns.enabled && campaigns.isCampaignToken(req.body.token)) {
      await require('../emailCampaigns/campaignUnsubscribe').unsubscribeByToken(req.body.token, { workspaceId: req.publicWorkspace.id, via: 'link' });
    } else {
      await unsubscribe(req.publicWorkspace, req.body.token);
    }
    res.json({ ok: true, storeName: req.publicWorkspace.name });
  })
);

module.exports = { router, tokenFor, readToken, linkFor, unsubscribe };
