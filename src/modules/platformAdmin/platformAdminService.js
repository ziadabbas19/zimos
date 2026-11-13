'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { NotFoundError, ConflictError, AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { planPrice, yearlyPriceFor } = require('../billing/planPricing');
const { effectivePrice } = require('../billing/manualPricing');
const publicPlans = require('../billing/publicPlansService');
const { catalogForAdmin, featureDefinition, isAvailableFeature } = require('../billing/featureCatalog');

/**
 * Every write below is audited as a platform-level entry: workspace_id NULL,
 * the admin as actor, the row's editable state before and after, written in
 * the same transaction as the change so neither can exist without the other.
 * A refused write (a duplicate key, a plan still in use) records nothing.
 */
async function audit(req, fields, transaction) {
  await recordAudit({ actorUserId: req.user.id, req, transaction, ...fields });
}

/** The audited state of a row: its serialized form without id and timestamps. */
function auditState(serialized, omit = []) {
  const out = { ...serialized };
  for (const key of ['id', 'createdAt', 'updatedAt', ...omit]) delete out[key];
  return out;
}

// ---------------------------------------------------------------- serializers

/**
 * `plans.features` is JSONB and has been written two ways over the life of the
 * table: as a `{ key: true }` map (the original seed) and as a plain array (the
 * admin editor). Readers only ever want the enabled keys, so normalise to an
 * array here rather than migrating the column.
 */
function featureList(features) {
  if (Array.isArray(features)) return features;
  if (features && typeof features === 'object') {
    return Object.keys(features).filter((k) => features[k]);
  }
  return [];
}

function serializePlan(p) {
  return {
    id: p.id,
    name: p.name,
    // The admin UI calls this `code`; the column is `key`.
    code: p.key,
    // BIGINT arrives from pg as a string — hand the client a number.
    monthlyPrice: Number(p.monthlyPriceAmount),
    // Derived: 10 × monthlyPrice (billing/planPricing).
    yearlyPrice: planPrice(p, 'yearly'),
    currency: p.currency,
    trialDays: p.trialDays,
    // null = unlimited.
    orderQuota: p.softOrderQuota,
    transactionFeeBp: p.transactionFeeBp,
    codFeeBp: p.codFeeBp,
    features: featureList(p.features),
    active: p.isActive,
    // Limits (null = unlimited), checked when a store or funnel is created.
    maxStores: p.maxStores,
    maxFunnelsPerMonth: p.maxFunnelsPerMonth,
    // Email campaigns a store may send a month (migration 748); null = unlimited, 0 = none.
    maxCampaignEmailsPerMonth: p.maxCampaignEmailsPerMonth === undefined ? 0 : p.maxCampaignEmailsPerMonth,
    // Campaigns a month and the largest audience of one (migration 749); null = unlimited.
    maxCampaignsPerMonth: p.maxCampaignsPerMonth === undefined ? null : p.maxCampaignsPerMonth,
    maxRecipientsPerCampaign: p.maxRecipientsPerCampaign === undefined ? null : p.maxRecipientsPerCampaign,
    // On the marketing site and at sign-up, in this order.
    isPublic: p.isPublic,
    displayOrder: p.displayOrder,
    // The pay-per-order fee, minor units; 0 = none (billing/walletService).
    perOrderFee: Number(p.perOrderFeeAmount || 0),
    // Free orders before any fee, and the debt limit (minor units; null =
    // the fixed overdraft and the old refusal). Migration 220.
    walletFreeOrders: Number(p.walletFreeOrders || 0),
    walletDebtLimit: p.walletDebtLimitAmount === null || p.walletDebtLimitAmount === undefined ? null : Number(p.walletDebtLimitAmount),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function serializeFlag(f) {
  return {
    id: f.id,
    key: f.key,
    description: f.description,
    enabled: f.enabled,
    rollout: f.rollout,
    targetWorkspaceIds: Array.isArray(f.targetWorkspaceIds) ? f.targetWorkspaceIds : [],
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

function serializeAnnouncement(a) {
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    severity: a.severity,
    audience: a.audience,
    planId: a.planId,
    workspaceId: a.workspaceId,
    workspaceName: a.workspace ? a.workspace.name : null,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    dismissible: a.dismissible,
    createdBy: a.createdBy ? a.createdBy.fullName || a.createdBy.email : null,
    createdAt: a.createdAt,
  };
}

function serializeSubscription(s) {
  const mrr = monthlyRunRate(s);
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    workspaceName: s.workspace ? s.workspace.name : null,
    workspaceSlug: s.workspace ? s.workspace.slug : null,
    planId: s.planId,
    planName: s.plan ? s.plan.name : null,
    planCode: s.plan ? s.plan.key : null,
    billingCycle: s.billingCycle,
    status: s.status,
    trialEndsAt: s.trialEndsAt,
    currentPeriodStart: s.currentPeriodStart,
    currentPeriodEnd: s.currentPeriodEnd,
    graceUntil: s.graceUntil,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    externalProvider: s.externalProvider,
    // billing/manualPricing: paid, free (a gift) or discounted; effectivePrice
    // is one billing period as the merchant pays it, minor units.
    pricingKind: s.pricingKind || 'paid',
    discountPercent: s.discountPercent ?? null,
    priceOverrideAmount: s.priceOverrideAmount == null ? null : Number(s.priceOverrideAmount),
    effectivePrice: effectivePrice(s, s.plan),
    pricingExpiredAt: s.pricingExpiredAt || null,
    // Minor units, normalised to a month so a yearly and a monthly plan can be
    // compared. Only a paying subscription contributes.
    mrr,
    // The currency `mrr` is actually denominated in. Null when the row
    // contributes nothing, so that a consumer answering "do all the
    // contributing rows agree on a currency?" can simply skip the nulls
    // instead of having to re-derive which rows counted.
    mrrCurrency: mrr > 0 && s.plan ? s.plan.currency : null,
    createdAt: s.createdAt,
  };
}

/**
 * One subscription's monthly run rate, in the minor units of ITS OWN plan's
 * currency. This number is only meaningful next to that currency: plans.currency
 * is per-plan, and there is no FX layer anywhere in the backend, so two of these
 * may not be added together unless their currencies match. Use `aggregateMrr`
 * rather than summing the column by hand.
 */
function monthlyRunRate(s) {
  if (!s.plan) return 0;
  if (s.status !== 'active' && s.status !== 'past_due') return 0;
  // A free one never counts; a discounted one counts at its own price, until
  // its period ran out (billing/manualPricing).
  if (s.pricingKind && s.pricingKind !== 'paid' && s.pricingExpiredAt) return 0;
  const price = effectivePrice(s, s.plan);
  return s.billingCycle === 'yearly' ? Math.round(price / 12) : price;
}

/**
 * Totals serialized subscription rows without ever adding two currencies
 * together. There is deliberately no conversion here: the backend has no rate
 * source, and a converted total would look authoritative while being wrong the
 * moment rates moved, and unauditable after the fact. Refusing to answer is the
 * honest result.
 *
 *   no contributing rows  -> { mrr: 0,    mrrCurrency: null }  (really is zero)
 *   one currency          -> { mrr: N,    mrrCurrency: 'USD' }
 *   two or more           -> { mrr: null, mrrCurrency: null }  (cannot be said)
 *
 * `mrr: 0` and `mrr: null` are different answers on purpose — "you have no
 * paying subscriptions" is a fact, "this cannot be expressed as one number" is
 * not. `mrrByCurrency` always carries the per-currency breakdown, so a caller
 * that hits the mixed case still has something real to display.
 */
function aggregateMrr(rows) {
  const mrrByCurrency = {};
  for (const row of rows) {
    if (!row.mrr || !row.mrrCurrency) continue;
    mrrByCurrency[row.mrrCurrency] = (mrrByCurrency[row.mrrCurrency] || 0) + row.mrr;
  }

  const currencies = Object.keys(mrrByCurrency);
  if (currencies.length === 1) {
    return { mrr: mrrByCurrency[currencies[0]], mrrCurrency: currencies[0], mrrByCurrency };
  }
  return { mrr: currencies.length === 0 ? 0 : null, mrrCurrency: null, mrrByCurrency };
}

// ---------------------------------------------------------------------- plans

/**
 * Every plan, in the order the pricing page lists them (display order, then
 * price, then name — publicPlansService.PLAN_ORDER), with the feature
 * catalogue the editor ticks from: each key's names and whether it can be
 * added to a plan (billing/featureCatalog).
 */
async function listPlans() {
  const plans = await db.Plan.findAll({ order: publicPlans.PLAN_ORDER });
  return { plans: plans.map(serializePlan), featureCatalog: catalogForAdmin() };
}

/**
 * A feature a plan didn't list before must exist today (catalogue
 * `available`); one the plan already lists may stay, so an older plan still
 * saves as it is. 422 PLAN_FEATURE_NOT_AVAILABLE names each refused key.
 */
function assertFeaturesAllowed(features, previous) {
  const had = new Set(previous);
  const refused = [...new Set(features)].filter((key) => !had.has(key) && !isAvailableFeature(key));
  if (refused.length === 0) return;
  throw new AppError(
    'PLAN_FEATURE_NOT_AVAILABLE',
    `Not available yet, so it can't be added to a plan: ${refused
      .map((key) => (featureDefinition(key) ? featureDefinition(key).label.en : key))
      .join(', ')}`,
    422,
    refused.map((key) => ({
      field: 'features',
      key,
      message: featureDefinition(key) ? `"${featureDefinition(key).label.en}" isn't available yet` : `"${key}" isn't a feature`,
    }))
  );
}

async function savePlan(input, req) {
  const fields = {
    key: input.code,
    name: input.name,
    monthlyPriceAmount: input.monthlyPrice,
    // Always 10 × monthly (billing/planPricing); a yearlyPrice sent by an
    // older client is ignored.
    yearlyPriceAmount: yearlyPriceFor(input.monthlyPrice),
    trialDays: input.trialDays,
    softOrderQuota: input.orderQuota === undefined ? null : input.orderQuota,
    transactionFeeBp: input.transactionFeeBp,
    codFeeBp: input.codFeeBp,
    features: input.features,
    isActive: input.active,
  };
  if (input.currency) fields.currency = input.currency;
  // Sent: written (null clears a limit). Left out: kept as it is.
  if (input.maxStores !== undefined) fields.maxStores = input.maxStores;
  if (input.maxFunnelsPerMonth !== undefined) fields.maxFunnelsPerMonth = input.maxFunnelsPerMonth;
  if (input.maxCampaignEmailsPerMonth !== undefined) fields.maxCampaignEmailsPerMonth = input.maxCampaignEmailsPerMonth;
  if (input.maxCampaignsPerMonth !== undefined) fields.maxCampaignsPerMonth = input.maxCampaignsPerMonth;
  if (input.maxRecipientsPerCampaign !== undefined) fields.maxRecipientsPerCampaign = input.maxRecipientsPerCampaign;
  if (input.isPublic !== undefined) fields.isPublic = input.isPublic;
  if (input.displayOrder !== undefined) fields.displayOrder = input.displayOrder;
  if (input.perOrderFee !== undefined) fields.perOrderFeeAmount = input.perOrderFee;
  if (input.walletFreeOrders !== undefined) fields.walletFreeOrders = input.walletFreeOrders;
  if (input.walletDebtLimit !== undefined) fields.walletDebtLimitAmount = input.walletDebtLimit;

  // A fee per order belongs to a plan with nothing monthly, in EGP — the
  // balance's currency (Q13).
  const assertFeeAllowed = (plan) => {
    const fee = fields.perOrderFeeAmount !== undefined ? fields.perOrderFeeAmount : Number((plan && plan.perOrderFeeAmount) || 0);
    const currency = fields.currency || (plan && plan.currency) || 'EGP';
    if (fee > 0 && (fields.monthlyPriceAmount !== 0 || currency !== 'EGP')) {
      throw new AppError(
        'PER_ORDER_FEE_NOT_ALLOWED',
        'A fee per order is only for a plan priced 0 a month, in EGP.',
        422,
        [{ field: 'perOrderFee', message: 'Set the monthly price to 0 and the currency to EGP, or the fee to 0' }]
      );
    }
  };

  // New limits apply from the next store or funnel created; nothing that
  // exists is touched. The public list drops its cached copy either way.
  const saved = await db.sequelize.transaction(async (transaction) => {
    // `key` is unique — check first so a duplicate reads as a 409 with a useful
    // message instead of a raw constraint violation.
    const clash = await db.Plan.findOne({ where: { key: fields.key }, transaction });
    if (clash && clash.id !== input.id) {
      throw new ConflictError(`Another plan already uses the code "${fields.key}"`, 'PLAN_CODE_TAKEN');
    }

    if (input.id) {
      const plan = await db.Plan.findByPk(input.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!plan) throw new NotFoundError('Plan');
      assertFeeAllowed(plan);
      assertFeaturesAllowed(fields.features, featureList(plan.features));
      const before = auditState(serializePlan(plan));
      await plan.update(fields, { transaction });
      const after = serializePlan(plan);
      await audit(req, { action: 'plan.update', entityType: 'Plan', entityId: plan.id, before, after: auditState(after) }, transaction);
      return after;
    }
    assertFeeAllowed(null);
    assertFeaturesAllowed(fields.features, []);
    const created = serializePlan(await db.Plan.create(fields, { transaction }));
    await audit(req, { action: 'plan.create', entityType: 'Plan', entityId: created.id, after: auditState(created) }, transaction);
    return created;
  });
  publicPlans.invalidate();
  return saved;
}

async function deletePlan(planId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const plan = await db.Plan.findByPk(planId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!plan) throw new NotFoundError('Plan');

    // The subscriptions FK is ON DELETE RESTRICT, so this would fail at the
    // database anyway; catching it here makes the reason legible.
    const inUse = await db.Subscription.count({ where: { planId }, transaction });
    if (inUse > 0) {
      throw new ConflictError(
        `${inUse} subscription(s) still use this plan — deactivate it instead`,
        'PLAN_IN_USE'
      );
    }
    const before = auditState(serializePlan(plan));
    await plan.destroy({ transaction });
    await audit(req, { action: 'plan.delete', entityType: 'Plan', entityId: planId, before }, transaction);
    return { success: true };
  }).finally(() => publicPlans.invalidate());
}

// -------------------------------------------------------------- subscriptions

async function listSubscriptions({ status } = {}) {
  const subs = await db.Subscription.findAll({
    where: status ? { status } : undefined,
    order: [['createdAt', 'DESC']],
    include: [
      { model: db.Workspace, as: 'workspace' },
      { model: db.Plan, as: 'plan' },
    ],
  });

  const subscriptions = subs.map(serializeSubscription);
  // Totalled here rather than left to the client: every consumer that adds the
  // mrr column up needs the same currency check, and one that forgets it gets a
  // number that is silently wrong rather than visibly absent. `paidOnly` is
  // the same total over the subscriptions at the plan's price.
  const paid = aggregateMrr(subscriptions.filter((row) => row.pricingKind === 'paid'));
  return { subscriptions, ...aggregateMrr(subscriptions), paidOnly: { mrr: paid.mrr, mrrCurrency: paid.mrrCurrency, mrrByCurrency: paid.mrrByCurrency } };
}

// -------------------------------------------------------------- feature flags

async function listFlags() {
  const flags = await db.FeatureFlag.findAll({ order: [['key', 'ASC']] });
  return flags.map(serializeFlag);
}

async function saveFlag(input, req) {
  const fields = {
    key: input.key,
    description: input.description ?? '',
    enabled: input.enabled,
    rollout: input.rollout,
    targetWorkspaceIds: input.targetWorkspaceIds ?? [],
  };

  return db.sequelize.transaction(async (transaction) => {
    const clash = await db.FeatureFlag.findOne({ where: { key: fields.key }, transaction });
    if (clash && clash.id !== input.id) {
      throw new ConflictError(`A flag with the key "${fields.key}" already exists`, 'FLAG_KEY_TAKEN');
    }

    if (input.id) {
      const flag = await db.FeatureFlag.findByPk(input.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!flag) throw new NotFoundError('Feature flag');
      const before = auditState(serializeFlag(flag));
      await flag.update(fields, { transaction });
      const after = serializeFlag(flag);
      await audit(
        req,
        { action: 'feature_flag.update', entityType: 'FeatureFlag', entityId: flag.id, before, after: auditState(after) },
        transaction
      );
      return after;
    }
    const created = serializeFlag(await db.FeatureFlag.create(fields, { transaction }));
    await audit(
      req,
      { action: 'feature_flag.create', entityType: 'FeatureFlag', entityId: created.id, after: auditState(created) },
      transaction
    );
    return created;
  });
}

async function deleteFlag(flagId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const flag = await db.FeatureFlag.findByPk(flagId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!flag) throw new NotFoundError('Feature flag');
    const before = auditState(serializeFlag(flag));
    await flag.destroy({ transaction });
    await audit(req, { action: 'feature_flag.delete', entityType: 'FeatureFlag', entityId: flagId, before }, transaction);
    return { success: true };
  });
}

// -------------------------------------------------------------- announcements

const ANNOUNCEMENT_INCLUDES = [
  { model: db.Workspace, as: 'workspace' },
  { model: db.User, as: 'createdBy' },
];

async function listAnnouncements() {
  const rows = await db.Announcement.findAll({
    order: [['startsAt', 'DESC']],
    include: ANNOUNCEMENT_INCLUDES,
  });
  return rows.map(serializeAnnouncement);
}

/**
 * `audience` decides which target column must be set. Joi enforces the same
 * pairing, but it is re-checked here so a direct service call can't write a
 * row that targets nothing (which would show the banner to every workspace).
 */
async function resolveAudience(input, transaction) {
  if (input.audience === 'plan') {
    if (!input.planId) throw new AppError('AUDIENCE_TARGET_REQUIRED', 'A plan is required for a plan announcement', 422);
    if (!(await db.Plan.findByPk(input.planId, { transaction }))) throw new NotFoundError('Plan');
    return { planId: input.planId, workspaceId: null };
  }
  if (input.audience === 'workspace') {
    if (!input.workspaceId) {
      throw new AppError('AUDIENCE_TARGET_REQUIRED', 'A workspace is required for a workspace announcement', 422);
    }
    if (!(await db.Workspace.findByPk(input.workspaceId, { transaction }))) throw new NotFoundError('Workspace');
    return { planId: null, workspaceId: input.workspaceId };
  }
  return { planId: null, workspaceId: null };
}

// An announcement's audited state: the columns an admin sets, not the names
// the serializer resolves for display (workspaceName, createdBy).
function announcementAuditState(row) {
  return {
    title: row.title,
    body: row.body,
    severity: row.severity,
    audience: row.audience,
    planId: row.planId,
    workspaceId: row.workspaceId,
    startsAt: row.startsAt ? new Date(row.startsAt).toISOString() : null,
    endsAt: row.endsAt ? new Date(row.endsAt).toISOString() : null,
    dismissible: row.dismissible,
  };
}

async function saveAnnouncement(input, req) {
  return db.sequelize.transaction(async (transaction) => {
    const targets = await resolveAudience(input, transaction);
    const startsAt = input.startsAt ? new Date(input.startsAt) : new Date();
    const endsAt = input.endsAt ? new Date(input.endsAt) : null;
    if (endsAt && endsAt <= startsAt) {
      throw new AppError('INVALID_WINDOW', 'The end time must be after the start time', 422);
    }

    const fields = {
      title: input.title,
      body: input.body,
      severity: input.severity,
      audience: input.audience,
      ...targets,
      startsAt,
      endsAt,
      dismissible: input.dismissible,
    };

    if (input.id) {
      const row = await db.Announcement.findByPk(input.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!row) throw new NotFoundError('Announcement');
      const before = announcementAuditState(row);
      await row.update(fields, { transaction });
      await audit(
        req,
        {
          action: 'announcement.update',
          entityType: 'Announcement',
          entityId: row.id,
          before,
          after: announcementAuditState(row),
        },
        transaction
      );
      return serializeAnnouncement(await reload(row.id, transaction));
    }
    // The author is recorded once, at creation; an edit does not reassign it.
    const created = await db.Announcement.create({ ...fields, createdByUserId: req.user.id }, { transaction });
    await audit(
      req,
      { action: 'announcement.create', entityType: 'Announcement', entityId: created.id, after: announcementAuditState(created) },
      transaction
    );
    return serializeAnnouncement(await reload(created.id, transaction));
  });
}

function reload(id, transaction) {
  return db.Announcement.findByPk(id, { include: ANNOUNCEMENT_INCLUDES, transaction });
}

async function deleteAnnouncement(announcementId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const row = await db.Announcement.findByPk(announcementId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw new NotFoundError('Announcement');
    const before = announcementAuditState(row);
    await row.destroy({ transaction });
    await audit(
      req,
      { action: 'announcement.delete', entityType: 'Announcement', entityId: announcementId, before },
      transaction
    );
    return { success: true };
  });
}

// ------------------------------------------------------------------ audit log

/**
 * How to render the record an entry points at, per `entity_type`. Types absent
 * from this map (and rows whose target has since been deleted) yield a null
 * `entityLabel` — the admin UI renders that absence explicitly rather than
 * showing a placeholder, so there is nothing to invent here.
 */
const ENTITY_LABELS = {
  User: { model: 'User', label: (r) => r.fullName || r.email },
  Customer: { model: 'Customer', label: (r) => r.fullName || r.email },
  Order: { model: 'Order', label: (r) => r.orderNumber },
  Workspace: { model: 'Workspace', label: (r) => r.name },
  Product: { model: 'Product', label: (r) => r.name },
  ProductVariant: { model: 'ProductVariant', label: (r) => r.sku },
  Collection: { model: 'Collection', label: (r) => r.name },
  Funnel: { model: 'Funnel', label: (r) => r.name },
  FunnelStep: { model: 'FunnelStep', label: (r) => r.name },
  Website: { model: 'Website', label: (r) => r.name },
  WebsitePage: { model: 'WebsitePage', label: (r) => r.title },
  Offer: { model: 'Offer', label: (r) => r.name },
  Discount: { model: 'Discount', label: (r) => r.code },
  TaxRate: { model: 'TaxRate', label: (r) => r.name },
  ShippingZone: { model: 'ShippingZone', label: (r) => r.name },
  ShippingRate: { model: 'ShippingRate', label: (r) => r.name },
  Role: { model: 'Role', label: (r) => r.name },
  Domain: { model: 'Domain', label: (r) => r.hostname },
  Shipment: { model: 'Shipment', label: (r) => r.trackingCode },
  Membership: { model: 'Membership', label: (r) => r.invitedEmail },
  Plan: { model: 'Plan', label: (r) => r.name },
  FeatureFlag: { model: 'FeatureFlag', label: (r) => r.key },
  Announcement: { model: 'Announcement', label: (r) => r.title },
  PlatformBlocklistEntry: { model: 'PlatformBlocklistEntry', label: (r) => `${r.type}: ${r.label}` },
  Template: { model: 'Template', label: (r) => r.name },
  TemplateVersion: { model: 'TemplateVersion', label: (r) => `v${r.version}` },
  SupportTicket: { model: 'SupportTicket', label: (r) => r.subject },
  ReferralCode: { model: 'ReferralCode', label: (r) => r.code },
  BillingInvoice: { model: 'BillingInvoice', label: (r) => `Charge ${r.amount} ${r.currency} (${r.status})` },
  SubscriptionTerm: {
    model: 'SubscriptionTerm',
    label: (r) => (r.kind === 'free_months' ? `${r.months} free month(s)` : `Special price ${r.priceAmount} ${r.currency} × ${r.chargesTotal}`),
  },
  Subscription: { model: 'Subscription', label: (r) => `Subscription ${r.status}` },
  AgentCommission: { model: 'AgentCommission', label: (r) => `${r.suggestedCommission} ${r.currency}` },
};

// `audit_logs.entity_id` is a STRING(100) but every model it points at has a
// UUID primary key. An entry written with a non-UUID id (or a truncated one)
// must not reach a `WHERE id IN (...)`, or Postgres rejects the whole query
// with "invalid input syntax for type uuid" and the page 500s.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves display labels for a page of entries: one query per entity type
 * present, never one per row. Returns a `${entityType}:${entityId}` -> label
 * map; a miss means "deleted or unlabelable" and serializes to null.
 */
async function resolveEntityLabels(entries) {
  const byType = new Map();
  for (const e of entries) {
    if (!e.entityId || !ENTITY_LABELS[e.entityType] || !UUID_RE.test(e.entityId)) continue;
    if (!byType.has(e.entityType)) byType.set(e.entityType, new Set());
    byType.get(e.entityType).add(e.entityId);
  }

  const labels = new Map();
  await Promise.all(
    [...byType].map(async ([entityType, ids]) => {
      const spec = ENTITY_LABELS[entityType];
      const model = db[spec.model];
      if (!model) return;
      const rows = await model.findAll({ where: { id: [...ids] } });
      for (const row of rows) {
        const label = spec.label(row);
        // An empty-string label is as uninformative as a missing one.
        if (label) labels.set(`${entityType}:${row.id}`, String(label));
      }
    })
  );
  return labels;
}

function serializeAuditEntry(e, labels) {
  return {
    id: e.id,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    // null, never a placeholder: the referenced record may be gone.
    entityLabel: labels.get(`${e.entityType}:${e.entityId}`) || null,
    workspaceId: e.workspaceId,
    workspaceName: e.workspace ? e.workspace.name : null,
    actorUserId: e.actorUserId,
    actorName: e.actor ? e.actor.fullName || null : null,
    actorEmail: e.actor ? e.actor.email : null,
    ip: e.ipAddress,
    userAgent: e.userAgent,
    before: e.beforeState,
    after: e.afterState,
    metadata: e.metadata,
    createdAt: e.createdAt,
  };
}

// `limit`/`offset` rather than `page`/`pageSize`: those are the names the
// admin UI already puts on the wire (it sends limit=200 and nothing else).
const AUDIT_LIMIT_DEFAULT = 50;
// A ceiling the client cannot raise — the UI's own window is exactly 200.
const AUDIT_LIMIT_MAX = 200;

async function listAuditLog(filters = {}) {
  const where = {};
  if (filters.workspaceId) where.workspaceId = filters.workspaceId;
  if (filters.actorUserId) where.actorUserId = filters.actorUserId;
  if (filters.action) where.action = filters.action;
  if (filters.entityType) where.entityType = filters.entityType;
  if (filters.entityId) where.entityId = String(filters.entityId);
  if (filters.from || filters.to) {
    where.createdAt = {
      ...(filters.from ? { [Op.gte]: filters.from } : {}),
      ...(filters.to ? { [Op.lte]: filters.to } : {}),
    };
  }

  const limit = Math.min(filters.limit || AUDIT_LIMIT_DEFAULT, AUDIT_LIMIT_MAX);
  const offset = Math.max(filters.offset || 0, 0);

  const { rows, count } = await db.AuditLog.findAndCountAll({
    where,
    // `id` breaks the tie: created_at defaults to NOW() and a request that
    // writes several entries gives them the same timestamp, which would
    // otherwise let a row shift between pages and be shown twice or skipped.
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit,
    offset,
    include: [
      { model: db.User, as: 'actor', attributes: ['id', 'fullName', 'email'], required: false },
      { model: db.Workspace, as: 'workspace', attributes: ['id', 'name'], required: false },
    ],
  });

  const labels = await resolveEntityLabels(rows);
  return {
    auditLog: rows.map((e) => serializeAuditEntry(e, labels)),
    // The UI currently renders a capped recent window and, without this, has
    // to infer "there are older entries" from rows.length === limit — which
    // is wrong exactly when the log holds precisely that many. `total` is the
    // fact that replaces the heuristic.
    total: count,
    limit,
    offset,
  };
}

module.exports = {
  featureList,
  aggregateMrr,
  listPlans,
  savePlan,
  deletePlan,
  listSubscriptions,
  listFlags,
  saveFlag,
  deleteFlag,
  listAnnouncements,
  saveAnnouncement,
  deleteAnnouncement,
  listAuditLog,
};
