'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { storeFeatureOn } = require('../../core/middleware/storeFeatures');
const { recordAudit } = require('../audit/auditService');
const audience = require('./campaignAudience');
const content = require('./campaignContent');
const quota = require('./campaignQuota');
const providers = require('./campaignProviders');
const sender = require('./campaignSender');

/**
 * The merchant's side of email campaigns: drafts, the audience count, the
 * preview, a test to themselves, sending now or later, cancelling, and the
 * numbers afterwards. Every read and write is by (id, workspace_id): a
 * campaign of another store is "not found", never shown or changed.
 */

const EDITABLE = new Set(['draft', 'scheduled']);
const DELETABLE = new Set(['draft', 'scheduled', 'failed', 'cancelled']);
const MAX_SCHEDULE_DAYS = 90;

const flagOn = () => Boolean(env.emailCampaigns.enabled);

function serialize(c) {
  return {
    id: c.id,
    name: c.name,
    subject: c.subject,
    preheader: c.preheader || null,
    blocks: Array.isArray(c.blocks) ? c.blocks : [],
    locale: c.locale,
    replyTo: c.replyTo || null,
    audience: c.audience || { type: 'all' },
    status: c.status,
    scheduledAt: c.scheduledAt,
    startedAt: c.startedAt,
    finishedAt: c.finishedAt,
    cancelledAt: c.cancelledAt,
    pausedUntil: c.pausedUntil,
    failureReason: c.failureReason || null,
    stats: {
      recipients: c.recipientsCount,
      sent: c.sentCount,
      failed: c.failedCount,
      skipped: c.skippedCount,
      delivered: c.deliveredCount,
      opened: c.openedCount,
      clicked: c.clickedCount,
      bounced: c.bouncedCount,
      complained: c.complainedCount,
      unsubscribed: c.unsubscribedCount,
    },
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

async function load(workspaceId, campaignId, options = {}) {
  const row = await db.EmailCampaign.findOne({ where: { id: campaignId, workspaceId }, ...options });
  if (!row) throw new NotFoundError('Campaign');
  return row;
}

/** A saved segment must be the store's own, and RFM groups need the RFM feature. */
async function checkAudience(workspaceId, value) {
  if (!value) return;
  if (value.type === 'segment') {
    const found = await db.Segment.count({ where: { id: value.segmentId, workspaceId } });
    if (!found) throw new ValidationError([{ field: 'audience.segmentId', message: 'Segment not found' }], 'Invalid body');
  }
  if (value.type === 'rfm' && !storeFeatureOn('rfm')) {
    throw new ValidationError([{ field: 'audience.type', message: 'Customer groups are not available' }], 'Invalid body');
  }
}

function defaultLocale(workspace) {
  return String((workspace && workspace.defaultLocale) || 'ar').toLowerCase().startsWith('en') ? 'en' : 'ar';
}

async function list(workspaceId, { status, cursor, limit = 20 } = {}) {
  const where = ['c.workspace_id = :workspaceId'];
  const replacements = { workspaceId, limit: limit + 1 };
  if (status) {
    where.push('c.status = :status');
    replacements.status = status;
  }
  if (cursor) {
    const [at, id] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|');
    if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw new ValidationError([{ field: 'cursor', message: 'Invalid cursor' }], 'Invalid query');
    }
    where.push('(c.created_at, c.id) < (:at, :id)');
    Object.assign(replacements, { at: new Date(at), id });
  }
  const ids = await db.sequelize.query(
    `SELECT c.id FROM email_campaigns c WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC, c.id DESC LIMIT :limit`,
    { replacements, type: QueryTypes.SELECT }
  );
  const page = ids.slice(0, limit).map((r) => r.id);
  const rows = page.length ? await db.EmailCampaign.findAll({ where: { id: page, workspaceId } }) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const campaigns = page.map((id) => byId.get(id)).filter(Boolean);
  const last = campaigns[campaigns.length - 1];
  return {
    campaigns: campaigns.map(serialize),
    nextCursor: ids.length > limit && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url') : null,
  };
}

async function get(workspaceId, campaignId) {
  return serialize(await load(workspaceId, campaignId));
}

async function create(workspaceId, body, req) {
  await checkAudience(workspaceId, body.audience);
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'defaultLocale'] });
  const row = await db.EmailCampaign.create({
    workspaceId,
    name: body.name,
    subject: body.subject || '',
    preheader: body.preheader || null,
    blocks: body.blocks || [],
    locale: body.locale || defaultLocale(workspace),
    replyTo: body.replyTo ? String(body.replyTo).trim().toLowerCase() : null,
    audience: body.audience || { type: 'all' },
    status: 'draft',
    createdByUserId: req.user.id,
  });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_campaign.create', entityType: 'EmailCampaign', entityId: row.id, after: { name: row.name }, req });
  return serialize(row);
}

async function update(workspaceId, campaignId, body, req) {
  const row = await load(workspaceId, campaignId);
  if (!EDITABLE.has(row.status)) throw new AppError('CAMPAIGN_LOCKED', `A ${row.status} campaign can't be edited`, 409);
  await checkAudience(workspaceId, body.audience);
  const changes = {};
  for (const key of ['name', 'subject', 'blocks', 'locale', 'audience']) if (body[key] !== undefined) changes[key] = body[key];
  if (body.preheader !== undefined) changes.preheader = body.preheader || null;
  if (body.replyTo !== undefined) changes.replyTo = body.replyTo ? String(body.replyTo).trim().toLowerCase() : null;
  await row.update(changes);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_campaign.update', entityType: 'EmailCampaign', entityId: row.id, after: { fields: Object.keys(changes) }, req });
  return serialize(row);
}

async function remove(workspaceId, campaignId, req) {
  const row = await load(workspaceId, campaignId);
  if (!DELETABLE.has(row.status)) throw new AppError('CAMPAIGN_LOCKED', `A ${row.status} campaign can't be deleted`, 409);
  await row.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_campaign.delete', entityType: 'EmailCampaign', entityId: campaignId, before: { name: row.name, status: row.status }, req });
  return { deleted: true };
}

async function previewAudience(workspaceId, value) {
  await checkAudience(workspaceId, value);
  const [count, subscribed] = await Promise.all([audience.count(workspaceId, value), audience.count(workspaceId, { type: 'all' })]);
  return { count, subscribed };
}

async function sendNow(workspaceId, campaignId, req) {
  await load(workspaceId, campaignId);
  const started = await sender.start(workspaceId, campaignId);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_campaign.send', entityType: 'EmailCampaign', entityId: campaignId, after: { recipients: started.recipientsCount }, req });
  return serialize(started);
}

async function schedule(workspaceId, campaignId, scheduledAt, req, { now = new Date() } = {}) {
  const row = await load(workspaceId, campaignId);
  if (!EDITABLE.has(row.status)) throw new AppError('CAMPAIGN_LOCKED', `A ${row.status} campaign can't be scheduled`, 409);
  const at = new Date(scheduledAt);
  if (at.getTime() < now.getTime() + 60 * 1000) {
    throw new ValidationError([{ field: 'scheduledAt', message: 'Pick a time at least a minute from now' }], 'Invalid body');
  }
  if (at.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * 86400000) {
    throw new ValidationError([{ field: 'scheduledAt', message: `Pick a time within ${MAX_SCHEDULE_DAYS} days` }], 'Invalid body');
  }
  const problem = sender.contentProblem(row);
  if (problem) throw new AppError('CAMPAIGN_INCOMPLETE', problem === 'subject' ? 'Add a subject first' : 'Add some content first', 422, { field: problem });
  // Checked now as well as when the time comes: a merchant hears about it today, not on the day.
  const count = await audience.count(workspaceId, row.audience);
  if (count === 0) throw new AppError('NO_RECIPIENTS', 'No customer in this audience can receive marketing emails', 422);
  const refusal = quota.overQuota(await quota.monthly(workspaceId, { now: at }), count);
  if (refusal) throw refusal;
  await row.update({ status: 'scheduled', scheduledAt: at, failureReason: null });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_campaign.schedule', entityType: 'EmailCampaign', entityId: row.id, after: { scheduledAt: at }, req });
  return serialize(row);
}

async function unschedule(workspaceId, campaignId, req) {
  const row = await load(workspaceId, campaignId);
  if (row.status !== 'scheduled') throw new AppError('CAMPAIGN_NOT_SCHEDULED', 'This campaign is not scheduled', 409);
  await row.update({ status: 'draft', scheduledAt: null });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_campaign.unschedule', entityType: 'EmailCampaign', entityId: row.id, req });
  return serialize(row);
}

async function cancel(workspaceId, campaignId, req) {
  const row = await load(workspaceId, campaignId);
  if (!['scheduled', 'sending'].includes(row.status)) throw new AppError('CAMPAIGN_NOT_CANCELLABLE', `A ${row.status} campaign can't be cancelled`, 409);
  await sender.cancel(row);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'email_campaign.cancel', entityType: 'EmailCampaign', entityId: row.id, req });
  return serialize(await load(workspaceId, campaignId));
}

async function preview(workspaceId, body) {
  const rendered = await content.render(workspaceId, body);
  const page = rendered.withLink('#');
  return { subject: rendered.subject, html: page.html, text: page.text };
}

/** The draft as it stands, to the teammate's own sign-in address — nobody else's. */
async function sendTest(workspaceId, body, req) {
  if (!providers.ready()) throw new AppError('EMAIL_PROVIDER_NOT_CONFIGURED', 'Email sending is not set up on the platform yet', 503);
  const user = await db.User.findByPk(req.user.id, { attributes: ['id', 'email'] });
  if (!user || !user.email) throw new AppError('NO_EMAIL', 'Your account has no email address', 422);
  const rendered = await content.render(workspaceId, body);
  const brand = await content.storeBrand(workspaceId);
  const page = rendered.withLink(brand && brand.origin ? `${brand.origin}/unsubscribe` : '#');
  const from = await sender.senderOf(workspaceId, body);
  const prefix = body.locale === 'en' ? '[Test] ' : '[تجربة] ';
  try {
    await providers.current().send({
      to: user.email,
      fromName: from.fromName,
      fromAddress: from.fromAddress,
      replyTo: from.replyTo,
      subject: `${prefix}${rendered.subject}`.slice(0, 220),
      html: page.html,
      text: page.text,
      tags: ['campaign-test'],
    });
  } catch (err) {
    throw new AppError('TEST_EMAIL_FAILED', 'The test email could not be sent. Try again in a moment.', 502);
  }
  return { sent: true, to: user.email };
}

async function recipients(workspaceId, campaignId, { status, cursor, limit = 50 } = {}) {
  await load(workspaceId, campaignId, { attributes: ['id'] });
  const where = { campaignId, workspaceId };
  if (status) where.status = status;
  const { Op } = db.Sequelize;
  if (cursor) {
    const [at, id] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|');
    if (!at || !id || Number.isNaN(Date.parse(at))) throw new ValidationError([{ field: 'cursor', message: 'Invalid cursor' }], 'Invalid query');
    where[Op.or] = [{ createdAt: { [Op.gt]: new Date(at) } }, { createdAt: new Date(at), id: { [Op.gt]: id } }];
  }
  const rows = await db.EmailCampaignRecipient.findAll({
    where,
    order: [['createdAt', 'ASC'], ['id', 'ASC']],
    limit: limit + 1,
    attributes: ['id', 'email', 'status', 'error', 'attempts', 'sentAt', 'deliveryStatus', 'openedAt', 'clickedAt', 'unsubscribedAt', 'createdAt'],
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    recipients: page.map((r) => ({
      id: r.id,
      email: r.email,
      status: r.status,
      error: r.error || null,
      attempts: r.attempts,
      sentAt: r.sentAt,
      deliveryStatus: r.deliveryStatus || null,
      openedAt: r.openedAt,
      clickedAt: r.clickedAt,
      unsubscribedAt: r.unsubscribedAt,
    })),
    nextCursor: rows.length > limit && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url') : null,
  };
}

/**
 * The settings the screens need: the quota, who the email is from, whether
 * the provider is ready and reports opens and clicks, the store's language,
 * and the saved segments to pick from.
 */
async function overview(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'defaultLocale'] });
  const [limits, from, segments] = await Promise.all([
    quota.summary(workspaceId),
    sender.senderOf(workspaceId, {}),
    db.Segment.findAll({ where: { workspaceId }, attributes: ['id', 'name'], order: [['name', 'ASC']], limit: 200 }),
  ]);
  const provider = providers.current();
  const tracked = Boolean(provider && provider.name === 'brevo' && env.notifications.brevo.webhookToken);
  return {
    quota: limits,
    sender: from,
    provider: { ready: providers.ready(), reportsDelivery: tracked, reportsEngagement: tracked },
    locale: defaultLocale(workspace),
    audiences: { segments: segments.map((s) => ({ id: s.id, name: s.name })), rfm: storeFeatureOn('rfm') },
  };
}

/** The store's active products for the products block, by name. */
async function products(workspaceId, { q, limit = 20 } = {}) {
  const text = String(q || '').trim();
  const rows = await db.sequelize.query(
    `SELECT p.id, p.name, p.media,
            (SELECT min(v.price_amount) FROM product_variants v WHERE v.product_id = p.id AND v.status = 'active') AS price,
            (SELECT v.currency FROM product_variants v WHERE v.product_id = p.id AND v.status = 'active' ORDER BY v.price_amount, v.id LIMIT 1) AS currency
       FROM products p
      WHERE p.workspace_id = :workspaceId AND p.status = 'active' ${text ? 'AND p.name ILIKE :q' : ''}
      ORDER BY p.priority DESC, p.created_at DESC, p.id
      LIMIT :limit`,
    { replacements: { workspaceId, q: `%${text.replace(/[\\%_]/g, '\\$&')}%`, limit }, type: QueryTypes.SELECT }
  );
  return rows.map((r) => {
    const media = Array.isArray(r.media) ? r.media : [];
    const first = media.find((m) => m && typeof m.url === 'string' && m.url);
    return { id: r.id, name: r.name, imageUrl: first ? first.url : null, price: r.price === null ? null : Number(r.price), currency: r.currency || null };
  });
}

module.exports = {
  flagOn,
  serialize,
  list,
  get,
  create,
  update,
  remove,
  previewAudience,
  sendNow,
  schedule,
  unschedule,
  cancel,
  preview,
  sendTest,
  recipients,
  overview,
  products,
};
