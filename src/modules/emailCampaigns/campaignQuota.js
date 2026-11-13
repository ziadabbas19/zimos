'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const { monthWindow, dayWindow } = require('../../core/utils/zonedMonth');
const { AppError } = require('../../core/errors/AppError');

/**
 * How many campaign emails a store may send — a quota, not a charge:
 *
 *   monthly  plans.max_campaign_emails_per_month on the store's plan, for the
 *            calendar month in Cairo time (like the funnels limit). null =
 *            unlimited; a store without a plan, or a plan never given a
 *            number (0, what migration 748 gave existing plans), sends none.
 *            Counted when sending starts: every address queued this month
 *            uses one, sent or failed; one skipped (opted out before its
 *            turn) or cancelled gives it back. A campaign that doesn't fit
 *            is refused whole, never sent in part.
 *   daily    EMAIL_CAMPAIGNS_STORE_DAILY_CAP: emails one store hands to the
 *            provider in a Cairo day, whatever its plan, so a single store
 *            can't hurt the shared sender's reputation. Past it the campaign
 *            waits for the next day (campaignSender.js), it is not refused.
 *
 * Test emails to the merchant's own address count against neither (they are
 * rate-limited instead, core/middleware/rateLimiters.js).
 */

const TIME_ZONE = 'Africa/Cairo';
const USED = "status IN ('queued', 'sending', 'sent', 'failed')";

async function planLimit(workspaceId, { transaction } = {}) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    attributes: ['id'],
    include: [{ model: db.Plan, as: 'plan', attributes: ['id', 'maxCampaignEmailsPerMonth'] }],
    transaction,
  });
  if (!subscription || !subscription.plan) return 0;
  const max = subscription.plan.maxCampaignEmailsPerMonth;
  return max === null || max === undefined ? null : Number(max);
}

/** { max (null = unlimited), used, remaining (null = unlimited), resetsAt } for this Cairo month. */
async function monthly(workspaceId, { now = new Date(), transaction } = {}) {
  const { start, resetsAt } = monthWindow(now, TIME_ZONE);
  const [max, [row]] = await Promise.all([
    planLimit(workspaceId, { transaction }),
    db.sequelize.query(
      `SELECT count(*)::int AS n FROM email_campaign_recipients
        WHERE workspace_id = :workspaceId AND created_at >= :start AND created_at < :end AND ${USED}`,
      { replacements: { workspaceId, start, end: resetsAt }, type: QueryTypes.SELECT, transaction }
    ),
  ]);
  const used = row ? row.n : 0;
  return { max, used, remaining: max === null ? null : Math.max(0, max - used), resetsAt };
}

/** { cap, used, remaining, resetsAt } for this Cairo day: emails handed to the provider. */
async function daily(workspaceId, { now = new Date(), transaction } = {}) {
  const { start, end: resetsAt } = dayWindow(now, TIME_ZONE);
  const [row] = await db.sequelize.query(
    `SELECT count(*)::int AS n FROM email_campaign_recipients
      WHERE workspace_id = :workspaceId AND handed_at >= :start AND handed_at < :end`,
    { replacements: { workspaceId, start, end: resetsAt }, type: QueryTypes.SELECT, transaction }
  );
  const cap = env.emailCampaigns.storeDailyCap;
  const used = row ? row.n : 0;
  return { cap, used, remaining: Math.max(0, cap - used), resetsAt };
}

async function summary(workspaceId, opts = {}) {
  const [month, day] = await Promise.all([monthly(workspaceId, opts), daily(workspaceId, opts)]);
  return { monthly: month, daily: day };
}

/** The refusal when `needed` more addresses don't fit this month; null when they do. */
function overQuota(month, needed) {
  if (month.max === null || needed <= month.remaining) return null;
  return new AppError(
    'EMAIL_QUOTA_EXCEEDED',
    month.max === 0
      ? 'Your plan does not include email campaigns this month'
      : `This campaign needs ${needed} emails and your plan has ${month.remaining} left this month`,
    422,
    { needed, remaining: month.remaining, max: month.max, used: month.used, resetsAt: month.resetsAt }
  );
}

/** Serialises starts per store (a campaign's quota check and its rows), inside the transaction. */
async function lockStore(workspaceId, transaction) {
  await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `email-campaigns:${workspaceId}` }, transaction });
}

module.exports = { TIME_ZONE, monthly, daily, summary, overQuota, lockStore, planLimit };
