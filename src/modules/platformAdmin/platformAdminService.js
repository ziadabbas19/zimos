'use strict';

const db = require('../../db/models');
const { NotFoundError, ConflictError, AppError } = require('../../core/errors/AppError');

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
    yearlyPrice: Number(p.yearlyPriceAmount),
    currency: p.currency,
    trialDays: p.trialDays,
    // null = unlimited.
    orderQuota: p.softOrderQuota,
    transactionFeeBp: p.transactionFeeBp,
    codFeeBp: p.codFeeBp,
    features: featureList(p.features),
    active: p.isActive,
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
    // MRR in minor units, normalised to a month so yearly and monthly plans
    // can be summed directly. Only a paying subscription contributes.
    mrr: monthlyRunRate(s),
    createdAt: s.createdAt,
  };
}

function monthlyRunRate(s) {
  if (!s.plan) return 0;
  if (s.status !== 'active' && s.status !== 'past_due') return 0;
  return s.billingCycle === 'yearly'
    ? Math.round(Number(s.plan.yearlyPriceAmount) / 12)
    : Number(s.plan.monthlyPriceAmount);
}

// ---------------------------------------------------------------------- plans

async function listPlans() {
  const plans = await db.Plan.findAll({ order: [['monthlyPriceAmount', 'ASC']] });
  return plans.map(serializePlan);
}

async function savePlan(input) {
  const fields = {
    key: input.code,
    name: input.name,
    monthlyPriceAmount: input.monthlyPrice,
    yearlyPriceAmount: input.yearlyPrice,
    trialDays: input.trialDays,
    softOrderQuota: input.orderQuota === undefined ? null : input.orderQuota,
    transactionFeeBp: input.transactionFeeBp,
    codFeeBp: input.codFeeBp,
    features: input.features,
    isActive: input.active,
  };
  if (input.currency) fields.currency = input.currency;

  // `key` is unique — check first so a duplicate reads as a 409 with a useful
  // message instead of a raw constraint violation.
  const clash = await db.Plan.findOne({ where: { key: fields.key } });
  if (clash && clash.id !== input.id) {
    throw new ConflictError(`Another plan already uses the code "${fields.key}"`, 'PLAN_CODE_TAKEN');
  }

  if (input.id) {
    const plan = await db.Plan.findByPk(input.id);
    if (!plan) throw new NotFoundError('Plan');
    await plan.update(fields);
    return serializePlan(plan);
  }
  return serializePlan(await db.Plan.create(fields));
}

async function deletePlan(planId) {
  const plan = await db.Plan.findByPk(planId);
  if (!plan) throw new NotFoundError('Plan');

  // The subscriptions FK is ON DELETE RESTRICT, so this would fail at the
  // database anyway; catching it here makes the reason legible.
  const inUse = await db.Subscription.count({ where: { planId } });
  if (inUse > 0) {
    throw new ConflictError(
      `${inUse} subscription(s) still use this plan — deactivate it instead`,
      'PLAN_IN_USE'
    );
  }
  await plan.destroy();
  return { success: true };
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
  return subs.map(serializeSubscription);
}

// -------------------------------------------------------------- feature flags

async function listFlags() {
  const flags = await db.FeatureFlag.findAll({ order: [['key', 'ASC']] });
  return flags.map(serializeFlag);
}

async function saveFlag(input) {
  const fields = {
    key: input.key,
    description: input.description ?? '',
    enabled: input.enabled,
    rollout: input.rollout,
    targetWorkspaceIds: input.targetWorkspaceIds ?? [],
  };

  const clash = await db.FeatureFlag.findOne({ where: { key: fields.key } });
  if (clash && clash.id !== input.id) {
    throw new ConflictError(`A flag with the key "${fields.key}" already exists`, 'FLAG_KEY_TAKEN');
  }

  if (input.id) {
    const flag = await db.FeatureFlag.findByPk(input.id);
    if (!flag) throw new NotFoundError('Feature flag');
    await flag.update(fields);
    return serializeFlag(flag);
  }
  return serializeFlag(await db.FeatureFlag.create(fields));
}

async function deleteFlag(flagId) {
  const flag = await db.FeatureFlag.findByPk(flagId);
  if (!flag) throw new NotFoundError('Feature flag');
  await flag.destroy();
  return { success: true };
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
async function resolveAudience(input) {
  if (input.audience === 'plan') {
    if (!input.planId) throw new AppError('AUDIENCE_TARGET_REQUIRED', 'A plan is required for a plan announcement', 422);
    if (!(await db.Plan.findByPk(input.planId))) throw new NotFoundError('Plan');
    return { planId: input.planId, workspaceId: null };
  }
  if (input.audience === 'workspace') {
    if (!input.workspaceId) {
      throw new AppError('AUDIENCE_TARGET_REQUIRED', 'A workspace is required for a workspace announcement', 422);
    }
    if (!(await db.Workspace.findByPk(input.workspaceId))) throw new NotFoundError('Workspace');
    return { planId: null, workspaceId: input.workspaceId };
  }
  return { planId: null, workspaceId: null };
}

async function saveAnnouncement(input, actorUserId) {
  const targets = await resolveAudience(input);
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
    const row = await db.Announcement.findByPk(input.id);
    if (!row) throw new NotFoundError('Announcement');
    await row.update(fields);
    return serializeAnnouncement(await reload(row.id));
  }
  // The author is recorded once, at creation; an edit does not reassign it.
  const created = await db.Announcement.create({ ...fields, createdByUserId: actorUserId });
  return serializeAnnouncement(await reload(created.id));
}

function reload(id) {
  return db.Announcement.findByPk(id, { include: ANNOUNCEMENT_INCLUDES });
}

async function deleteAnnouncement(announcementId) {
  const row = await db.Announcement.findByPk(announcementId);
  if (!row) throw new NotFoundError('Announcement');
  await row.destroy();
  return { success: true };
}

module.exports = {
  featureList,
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
};
