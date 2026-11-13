'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const queue = require('../../core/queue');
const { AppError } = require('../../core/errors/AppError');
const audience = require('./campaignAudience');
const content = require('./campaignContent');
const quota = require('./campaignQuota');
const providers = require('./campaignProviders');
const tokens = require('./campaignTokens');

/**
 * Sending a campaign, in batches on the `notifications` queue:
 *
 *   start      draft / scheduled → sending: the audience becomes one queued
 *              row per address (campaignAudience.materialize) and the plan's
 *              limits are checked against it (the month's campaigns and
 *              emails, the largest audience), in one transaction under the
 *              store's lock — refused whole when it doesn't fit.
 *   sendBatch  one job: claims up to EMAIL_CAMPAIGNS_BATCH_SIZE queued rows
 *              (FOR UPDATE SKIP LOCKED, so two workers never take the same
 *              row), sends them one by one and queues the next batch after
 *              the pause EMAIL_CAMPAIGNS_RATE_PER_MINUTE asks for. Past the
 *              store's daily cap the campaign waits for the next Cairo day.
 *   finish     no row left to send: sent (or failed when nothing went out).
 *   tick       every minute: starts scheduled campaigns that are due, puts
 *              back rows a stopped worker left half done, queues a batch for
 *              a sending campaign that has none. Waiting — for the next day,
 *              a retry or the provider — is the tick's: a batch that has to
 *              wait queues nothing, and the tick queues one when it is time.
 *
 * Never twice to one address:
 *   - UNIQUE (campaign_id, email): one row per address per campaign;
 *   - a row is claimed (queued → sending) by one batch only;
 *   - handed_at is written just before the provider is called. A row a
 *     stopped worker left 'sending' without it was never handed over and goes
 *     back in line; one with it may have gone out, so it is failed
 *     ('interrupted'), never sent again;
 *   - only a definite "not now" from the provider (429, 5xx) is retried, after
 *     30 s, 2 min, then 10 min (three tries in all). No answer at all (a
 *     timeout, a dropped connection) may mean it was accepted: failed, not retried.
 * Every counter on the campaign moves in the same statement as the row that
 * caused it, so the numbers can't drift from the rows.
 *
 * Off (EMAIL_CAMPAIGNS_ENABLED unset), a queued batch and the tick do nothing:
 * a campaign caught mid-way waits, and goes on once it is on again.
 */

const BATCH_JOB = 'email_campaigns.send_batch';
const RETRY_DELAYS_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;
const STALE_MS = 10 * 60 * 1000;

const flagOn = () => Boolean(env.emailCampaigns.enabled);
const run = (sql, replacements, options = {}) => db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT, ...options });
const clip = (s, n) => (s ? String(s).replace(/\s+/g, ' ').trim().slice(0, n) : null);

/** Why a campaign can't go out as it stands; null when it can. */
function contentProblem(campaign) {
  if (!String(campaign.subject || '').trim()) return 'subject';
  if (!Array.isArray(campaign.blocks) || campaign.blocks.length === 0) return 'blocks';
  return null;
}

function queueBatch(campaign, delayMs = 0) {
  return queue.add('notifications', BATCH_JOB, { campaignId: campaign.id }, { workspaceId: campaign.workspaceId, delayMs });
}

/**
 * draft / scheduled → sending. Throws an AppError the merchant can read
 * (no content, no provider, nobody to send to, over the month's quota);
 * nothing is changed then. Answers the campaign as it now stands.
 */
async function start(workspaceId, campaignId, { now = new Date() } = {}) {
  if (!providers.ready()) {
    throw new AppError('EMAIL_PROVIDER_NOT_CONFIGURED', 'Email sending is not set up on the platform yet', 503);
  }
  const campaign = await db.sequelize.transaction(async (transaction) => {
    await quota.lockStore(workspaceId, transaction);
    const row = await db.EmailCampaign.findOne({ where: { id: campaignId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw new AppError('NOT_FOUND', 'Campaign not found', 404);
    if (!['draft', 'scheduled'].includes(row.status)) {
      throw new AppError('CAMPAIGN_NOT_SENDABLE', `A ${row.status} campaign can't be sent`, 409);
    }
    const problem = contentProblem(row);
    if (problem) {
      throw new AppError('CAMPAIGN_INCOMPLETE', problem === 'subject' ? 'Add a subject before sending' : 'Add some content before sending', 422, { field: problem });
    }
    // The plan's three limits hold together (campaignQuota.js). This one's own
    // place among the month's campaigns is left out: as a scheduled one it holds one.
    const limits = await quota.planLimits(workspaceId, { transaction });
    const campaigns = await quota.campaignsMonthly(workspaceId, { now, excludeId: row.id, max: limits.campaigns, transaction });
    const tooMany = quota.overCampaignLimit(campaigns);
    if (tooMany) throw tooMany;
    // The month as it stood before this campaign's rows: they are the ones being checked.
    const month = await quota.monthly(workspaceId, { now, transaction });
    const total = await audience.materialize(row, { transaction });
    if (total === 0) throw new AppError('NO_RECIPIENTS', 'No customer in this audience can receive marketing emails', 422);
    // The live audience against the plan's largest: refused whole (the rows just made go with the transaction).
    const tooLarge = quota.overAudienceLimit(limits.recipients, total);
    if (tooLarge) throw tooLarge;
    const refusal = quota.overQuota(month, total);
    if (refusal) throw refusal;
    await row.update({ status: 'sending', startedAt: now, recipientsCount: total, failureReason: null, pausedUntil: null }, { transaction });
    return row;
  });
  logger.info(`[emailCampaigns] campaign ${campaign.id} started for ${campaign.recipientsCount} addresses`);
  await queueBatch(campaign);
  return db.EmailCampaign.findByPk(campaign.id);
}

/** A scheduled campaign whose time came: started, or failed with the reason (nothing sent). */
async function startScheduled(campaign, { now = new Date() } = {}) {
  try {
    if (await require('../billing/growthFeatures').locked(campaign.workspaceId, 'email_campaigns')) {
      throw new AppError('PLAN_FEATURE_REQUIRED', 'The plan no longer includes email campaigns', 403);
    }
    await start(campaign.workspaceId, campaign.id, { now });
  } catch (err) {
    // The provider missing is the platform's to fix: the campaign keeps its slot and starts once it is set up.
    if (err.code === 'EMAIL_PROVIDER_NOT_CONFIGURED') {
      logger.error(`[emailCampaigns] scheduled campaign ${campaign.id} waits: ${err.message}`);
      return;
    }
    const reason =
      {
        EMAIL_QUOTA_EXCEEDED: 'quota_exceeded',
        NO_RECIPIENTS: 'no_recipients',
        CAMPAIGN_INCOMPLETE: 'incomplete',
        PLAN_FEATURE_REQUIRED: 'plan_feature',
        // The audience grew past the plan's largest since it was scheduled: nothing is sent.
        AUDIENCE_TOO_LARGE: 'audience_too_large',
        CAMPAIGN_LIMIT_REACHED: 'campaign_limit',
      }[err.code] || 'start_failed';
    await db.EmailCampaign.update(
      { status: 'failed', failureReason: reason, finishedAt: now },
      { where: { id: campaign.id, status: 'scheduled' } }
    );
    logger.warn(`[emailCampaigns] scheduled campaign ${campaign.id} failed to start: ${reason}`);
  }
}

/** Rows a stopped worker left 'sending': back in line when never handed over, failed when they may have gone. */
async function recoverStale({ campaignId = null, now = new Date() } = {}) {
  const before = new Date(now.getTime() - STALE_MS);
  const scope = campaignId ? 'AND campaign_id = :campaignId' : '';
  await db.sequelize.query(
    `UPDATE email_campaign_recipients SET status = 'queued', claimed_at = NULL
      WHERE status = 'sending' AND handed_at IS NULL AND claimed_at < :before ${scope}`,
    { replacements: { before, campaignId } }
  );
  await db.sequelize.query(
    `WITH r AS (
       UPDATE email_campaign_recipients SET status = 'failed', error = 'interrupted: the worker stopped while sending'
        WHERE status = 'sending' AND handed_at IS NOT NULL AND claimed_at < :before ${scope}
        RETURNING campaign_id)
     UPDATE email_campaigns c SET failed_count = c.failed_count + x.n, updated_at = NOW()
       FROM (SELECT campaign_id, count(*)::int AS n FROM r GROUP BY campaign_id) x
      WHERE c.id = x.campaign_id`,
    { replacements: { before, campaignId } }
  );
}

/** Moves one claimed row and, only when it moved, the campaign counter that goes with it. */
async function settle(recipientId, { status, counter, fields = {} }) {
  const sets = Object.keys(fields).map((k) => `${k} = :${k}`);
  await db.sequelize.query(
    `WITH r AS (
       UPDATE email_campaign_recipients SET status = :status${sets.length ? `, ${sets.join(', ')}` : ''}
        WHERE id = :recipientId AND status = 'sending'
        RETURNING campaign_id)
     UPDATE email_campaigns SET ${counter} = ${counter} + 1, updated_at = NOW() WHERE id IN (SELECT campaign_id FROM r)`,
    { replacements: { recipientId, status, ...fields }, type: QueryTypes.UPDATE }
  );
}

/** A sending campaign with nothing left in line: sent, or failed when nothing at all went out. */
async function finish(campaignId, { now = new Date() } = {}) {
  const [row] = await run(
    `UPDATE email_campaigns c
        SET status = CASE WHEN c.sent_count = 0 AND c.failed_count > 0 THEN 'failed' ELSE 'sent' END,
            failure_reason = CASE WHEN c.sent_count = 0 AND c.failed_count > 0 THEN 'all_failed' ELSE NULL END,
            finished_at = :now, paused_until = NULL, updated_at = NOW()
      WHERE c.id = :campaignId AND c.status = 'sending'
        AND NOT EXISTS (SELECT 1 FROM email_campaign_recipients r WHERE r.campaign_id = c.id AND r.status IN ('queued', 'sending'))
      RETURNING c.id, c.status, c.sent_count, c.failed_count, c.skipped_count`,
    { campaignId, now }
  );
  if (row) logger.info(`[emailCampaigns] campaign ${row.id} ${row.status}: ${row.sent_count} sent, ${row.failed_count} failed, ${row.skipped_count} skipped`);
  return Boolean(row);
}

/** The From name: the store's sender name for its customers (notifications/orderEmailSender.js), header-safe. */
async function senderOf(workspaceId, campaign) {
  const own = await require('../notifications/orderEmailSender').senderFor(workspaceId);
  const fromName = content.headerLine(own.fromName, 70).replace(/["<>]/g, '') || 'Store';
  const replyTo = campaign.replyTo || own.replyTo || null;
  return { fromName, fromAddress: env.emailCampaigns.fromAddress, replyTo };
}

/** One job: up to a batch of this campaign's queued rows. */
async function sendBatch(campaignId, { now = () => new Date() } = {}) {
  if (!flagOn()) return { skipped: 'off' };
  const campaign = await db.EmailCampaign.findByPk(campaignId);
  if (!campaign || campaign.status !== 'sending') return { skipped: 'not_sending' };
  const startedAt = now();
  if (campaign.pausedUntil && campaign.pausedUntil > startedAt) return { skipped: 'paused' };
  const provider = providers.current();
  if (!provider || !provider.configured()) {
    logger.error(`[emailCampaigns] campaign ${campaign.id} waits: the email provider is not configured`);
    return { skipped: 'provider' };
  }

  await recoverStale({ campaignId: campaign.id, now: startedAt });

  // The store's daily cap: past it, the campaign waits for the next Cairo day.
  const day = await quota.daily(campaign.workspaceId, { now: startedAt });
  if (day.remaining <= 0) {
    await campaign.update({ pausedUntil: day.resetsAt });
    logger.info(`[emailCampaigns] campaign ${campaign.id} paused until ${day.resetsAt.toISOString()}: the store's daily cap is reached`);
    return { skipped: 'daily_cap' };
  }
  if (campaign.pausedUntil) await campaign.update({ pausedUntil: null });

  const limit = Math.min(env.emailCampaigns.batchSize, day.remaining);
  const claimed = await run(
    `UPDATE email_campaign_recipients SET status = 'sending', claimed_at = :now
      WHERE id IN (
        SELECT id FROM email_campaign_recipients
         WHERE campaign_id = :campaignId AND status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= :now)
         ORDER BY created_at, id
         LIMIT :limit
         FOR UPDATE SKIP LOCKED)
      RETURNING id, email, customer_id AS "customerId", attempts`,
    { campaignId: campaign.id, now: startedAt, limit }
  );

  if (claimed.length === 0) {
    if (await finish(campaign.id, { now: startedAt })) return { sent: 0, failed: 0, skipped: 0, finished: true };
    // Only rows waiting for a retry, or held by another batch: the tick comes back for them.
    return { sent: 0, failed: 0, skipped: 0, finished: false, waiting: true };
  }

  const brand = await content.storeBrand(campaign.workspaceId);
  const rendered = await content.render(campaign.workspaceId, campaign, { brand });
  const sender = await senderOf(campaign.workspaceId, campaign);
  const counts = { sent: 0, failed: 0, skipped: 0, retried: 0, cancelled: 0 };

  for (let i = 0; i < claimed.length; i += 1) {
    const row = claimed[i];
    // Cancelled while this batch ran: what it still holds is let go, unsent.
    const [state] = await run('SELECT status FROM email_campaigns WHERE id = :id', { id: campaign.id });
    if (!state || state.status !== 'sending') {
      const rest = claimed.slice(i).map((r) => r.id);
      await db.sequelize.query(
        "UPDATE email_campaign_recipients SET status = 'cancelled' WHERE id IN (:ids) AND status = 'sending' AND handed_at IS NULL",
        { replacements: { ids: rest } }
      );
      counts.cancelled += rest.length;
      break;
    }

    const refusal = await audience.stillReachable(campaign.workspaceId, row);
    if (refusal) {
      await settle(row.id, { status: 'skipped', counter: 'skipped_count', fields: { error: refusal } });
      counts.skipped += 1;
      continue;
    }

    const token = tokens.tokenFor(campaign.workspaceId, row.id);
    const oneClick = tokens.oneClickLink(token);
    const page = tokens.pageLink(brand && brand.origin, token) || oneClick;
    const body = rendered.withLink(page);
    const attempt = row.attempts + 1;
    await db.sequelize.query(
      "UPDATE email_campaign_recipients SET handed_at = NOW(), attempts = :attempt, provider = :provider WHERE id = :id AND status = 'sending'",
      { replacements: { id: row.id, attempt, provider: provider.name } }
    );
    try {
      const sent = await provider.send({
        to: row.email,
        fromName: sender.fromName,
        fromAddress: sender.fromAddress,
        replyTo: sender.replyTo,
        subject: rendered.subject,
        html: body.html,
        text: body.text,
        headers: { 'List-Unsubscribe': `<${oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        tags: ['campaign', `campaign-${campaign.id}`],
      });
      await settle(row.id, {
        status: 'sent',
        counter: 'sent_count',
        fields: { sent_at: new Date(), provider_message_id: sent.messageId ? String(sent.messageId).slice(0, 255) : null, error: null },
      });
      counts.sent += 1;
    } catch (err) {
      const definite = typeof (err.status ?? err.statusCode) === 'number';
      if (err.transient && definite && attempt < MAX_ATTEMPTS) {
        await db.sequelize.query(
          `UPDATE email_campaign_recipients
              SET status = 'queued', handed_at = NULL, claimed_at = NULL, error = :error,
                  next_attempt_at = NOW() + (:delayMs * INTERVAL '1 millisecond')
            WHERE id = :id AND status = 'sending'`,
          { replacements: { id: row.id, error: clip(err.message, 300), delayMs: RETRY_DELAYS_MS[attempt - 1] } }
        );
        counts.retried += 1;
      } else {
        const error = definite ? clip(err.message, 300) : clip(`no answer from the provider, not retried: ${err.message}`, 300);
        await settle(row.id, { status: 'failed', counter: 'failed_count', fields: { error } });
        counts.failed += 1;
      }
      // The address stays out of the log: the row id finds it.
      logger.warn(`[emailCampaigns] campaign ${campaign.id} recipient ${row.id} attempt ${attempt}: ${clip(err.message, 200)}`);
    }
  }

  if (await finish(campaign.id)) return { ...counts, finished: true };
  // More waiting now: the next batch at the pace — one every batchSize / ratePerMinute
  // minutes, less the time this one took. Only retries left: the tick's.
  const [ready] = await run(
    "SELECT count(*)::int AS n FROM email_campaign_recipients WHERE campaign_id = :campaignId AND status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())",
    { campaignId: campaign.id }
  );
  const fresh = await db.EmailCampaign.findByPk(campaign.id, { attributes: ['id', 'workspaceId', 'status'] });
  if (ready.n > 0 && fresh && fresh.status === 'sending') {
    const interval = (env.emailCampaigns.batchSize / env.emailCampaigns.ratePerMinute) * 60 * 1000;
    await queueBatch(fresh, Math.max(0, interval - (Date.now() - startedAt.getTime())));
  }
  return { ...counts, finished: false };
}

/** Sending → cancelled: nothing queued goes out any more; a batch running stops at its next address. */
async function cancel(campaign, { now = new Date() } = {}) {
  await db.sequelize.transaction(async (transaction) => {
    await campaign.update({ status: 'cancelled', cancelledAt: now, finishedAt: now, pausedUntil: null }, { transaction });
    await db.sequelize.query("UPDATE email_campaign_recipients SET status = 'cancelled' WHERE campaign_id = :id AND status = 'queued'", {
      replacements: { id: campaign.id },
      transaction,
    });
  });
}

/** Every minute (jobs.js). */
async function tick({ now = new Date() } = {}) {
  if (!flagOn()) return { started: 0 };
  const due = await db.EmailCampaign.findAll({
    where: { status: 'scheduled', scheduledAt: { [db.Sequelize.Op.lte]: now } },
    order: [['scheduledAt', 'ASC']],
    limit: 20,
  });
  for (const campaign of due) await startScheduled(campaign, { now });

  await recoverStale({ now });

  // A sending campaign with no batch on the way (a lost job, a restart before it was queued): queue one.
  const orphans = await run(
    `SELECT c.id, c.workspace_id AS "workspaceId" FROM email_campaigns c
      WHERE c.status = 'sending' AND (c.paused_until IS NULL OR c.paused_until <= :now)
        AND NOT EXISTS (
          SELECT 1 FROM queue_jobs j
           WHERE j.name = :job AND j.status IN ('pending', 'active') AND j.payload->>'campaignId' = c.id::text)
      LIMIT 50`,
    { now, job: BATCH_JOB }
  );
  for (const campaign of orphans) await queueBatch(campaign);
  return { started: due.length, requeued: orphans.length };
}

module.exports = { BATCH_JOB, MAX_ATTEMPTS, RETRY_DELAYS_MS, STALE_MS, start, startScheduled, sendBatch, recoverStale, finish, cancel, tick, contentProblem, senderOf };
