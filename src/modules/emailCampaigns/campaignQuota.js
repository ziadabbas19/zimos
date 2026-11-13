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
 *   campaigns  plans.max_campaigns_per_month (migration 749): campaigns a
 *            store may send or schedule in a Cairo month, by the month it goes
 *            out (scheduled_at while scheduled, started_at once started).
 *            null = unlimited. A draft doesn't count; a scheduled campaign
 *            does; cancelling one that never started, or one failing before
 *            any email went out, gives its place back.
 *   audience plans.max_recipients_per_campaign (migration 749): the largest
 *            audience one campaign may have, checked against the live
 *            audience when it is sent or scheduled, and again when a
 *            scheduled one starts. Too large is refused whole, never cut
 *            down. null = unlimited.
 * All of them hold together: a campaign goes out only within every one.
 *
 * Test emails to the merchant's own address count against none of them (they
 * are rate-limited instead, core/middleware/rateLimiters.js).
 */

const TIME_ZONE = 'Africa/Cairo';
const USED = "status IN ('queued', 'sending', 'sent', 'failed')";

const limitOf = (value) => (value === null || value === undefined ? null : Number(value));

/** The store's plan's three limits (null = unlimited). No plan: no emails, the other two unset. */
async function planLimits(workspaceId, { transaction } = {}) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    attributes: ['id'],
    include: [{ model: db.Plan, as: 'plan', attributes: ['id', 'maxCampaignEmailsPerMonth', 'maxCampaignsPerMonth', 'maxRecipientsPerCampaign'] }],
    transaction,
  });
  if (!subscription || !subscription.plan) return { emails: 0, campaigns: null, recipients: null };
  const plan = subscription.plan;
  return { emails: limitOf(plan.maxCampaignEmailsPerMonth), campaigns: limitOf(plan.maxCampaignsPerMonth), recipients: limitOf(plan.maxRecipientsPerCampaign) };
}

async function planLimit(workspaceId, options = {}) {
  return (await planLimits(workspaceId, options)).emails;
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

/**
 * { max (null = unlimited), used, remaining, resetsAt }: campaigns counted in
 * `now`'s Cairo month, leaving out `excludeId` (the campaign being checked,
 * which may itself be counted as scheduled).
 */
async function campaignsMonthly(workspaceId, { now = new Date(), excludeId = null, max, transaction } = {}) {
  const { start, resetsAt } = monthWindow(now, TIME_ZONE);
  const [limit, [row]] = await Promise.all([
    max === undefined ? planLimits(workspaceId, { transaction }).then((l) => l.campaigns) : Promise.resolve(max),
    db.sequelize.query(
      `SELECT count(*)::int AS n FROM email_campaigns
        WHERE workspace_id = :workspaceId ${excludeId ? 'AND id <> :excludeId' : ''}
          AND ((status = 'scheduled' AND scheduled_at >= :start AND scheduled_at < :end)
            OR (started_at >= :start AND started_at < :end
                AND (status IN ('sending', 'sent', 'cancelled') OR (status = 'failed' AND sent_count > 0))))`,
      { replacements: { workspaceId, excludeId, start, end: resetsAt }, type: QueryTypes.SELECT, transaction }
    ),
  ]);
  const used = row ? row.n : 0;
  return { max: limit, used, remaining: limit === null ? null : Math.max(0, limit - used), resetsAt };
}

async function summary(workspaceId, opts = {}) {
  const limits = await planLimits(workspaceId, opts);
  const [month, day, campaigns] = await Promise.all([
    monthly(workspaceId, opts),
    daily(workspaceId, opts),
    campaignsMonthly(workspaceId, { ...opts, max: limits.campaigns }),
  ]);
  return { monthly: month, daily: day, campaigns, recipientsPerCampaign: limits.recipients };
}

/** The refusal when one more campaign doesn't fit this month; null when it does. */
function overCampaignLimit(month) {
  if (month.max === null || month.used < month.max) return null;
  return new AppError(
    'CAMPAIGN_LIMIT_REACHED',
    month.max === 0
      ? 'Your plan does not include email campaigns this month'
      : `Your plan allows ${month.max} campaigns a month and ${month.used} are already sent or scheduled this month`,
    422,
    { max: month.max, used: month.used, resetsAt: month.resetsAt }
  );
}

/** The refusal when the audience is larger than one campaign may have; null when it isn't. */
function overAudienceLimit(max, audienceSize) {
  if (max === null || max === undefined || audienceSize <= max) return null;
  return new AppError(
    'AUDIENCE_TOO_LARGE',
    `This campaign's audience is ${audienceSize} people and your plan allows up to ${max} per campaign. Narrow the audience with a segment or rules.`,
    422,
    { audienceSize, max }
  );
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

module.exports = { TIME_ZONE, monthly, daily, summary, overQuota, lockStore, planLimit, planLimits, campaignsMonthly, overCampaignLimit, overAudienceLimit };
