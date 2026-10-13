'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError, ValidationError, ConflictError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { validatePageTree } = require('../pages/pageTree');
const logger = require('../../core/utils/logger');

/**
 * Split tests on a funnel step (SPEC §9.6), on the Experiment and
 * ExperimentAssignment tables.
 *
 * A test belongs to one step of one funnel. Its variants each take a share of
 * the visitors (the shares add up to 100):
 *   - the variant keyed 'A' is the step's own page — the control;
 *   - every other variant carries a page of its own in `data.builderData`
 *     (a copy of the page the merchant then changes).
 * The funnel's map does not change: the step keeps its links, a visitor in
 * variant B simply sees B's page on it.
 *
 * A visitor is pinned to a variant the first time they reach the step
 * (experiment_assignments is unique on experiment + visitor). An order placed
 * in the funnel is credited to the visitor's variant. Results per variant:
 * visits, orders, conversion rate, revenue, revenue per visit — and how sure
 * the difference between the two best is.
 *
 * The winner is picked by hand, or automatically once the test has had
 * `autoWinner.afterVisits` visits. A finished test serves its winner to
 * everyone.
 */

const METRICS = ['conversion_rate', 'revenue_per_visit'];
const STATUSES = ['running', 'paused', 'completed'];
const CONTROL_KEY = 'A';

// --- shape ----------------------------------------------------------------

function cleanVariants(variants) {
  const problems = [];
  const keys = new Set();
  let total = 0;
  variants.forEach((v, i) => {
    if (keys.has(v.key)) problems.push({ field: `variants[${i}].key`, message: `Duplicate variant "${v.key}"` });
    keys.add(v.key);
    total += v.weight;
    if (v.key !== CONTROL_KEY) {
      try {
        validatePageTree(v.builderData, { label: `variant "${v.key}"` });
      } catch (err) {
        if (err instanceof ValidationError && Array.isArray(err.details)) {
          err.details.forEach((d) => problems.push({ field: `variants[${i}].builderData.${d.field}`, message: d.message }));
        } else throw err;
      }
    }
  });
  if (!keys.has(CONTROL_KEY)) problems.push({ field: 'variants', message: `One variant must be "${CONTROL_KEY}" — the original page` });
  if (total !== 100) problems.push({ field: 'variants', message: `The shares must add up to 100 (they add up to ${total})` });
  if (problems.length) throw new ValidationError(problems, 'Invalid split test');
  return variants.map((v) => ({
    key: v.key,
    name: v.name || v.key,
    weight: v.weight,
    data: v.key === CONTROL_KEY ? {} : { builderData: v.builderData },
  }));
}

function present(experiment, { withPages = false } = {}) {
  return {
    id: experiment.id,
    name: experiment.name,
    funnelId: experiment.funnelId,
    stepKey: experiment.stepKey,
    status: experiment.status,
    autoWinner: experiment.autoWinner || { enabled: false, afterVisits: 2000, metric: 'conversion_rate' },
    winnerVariantKey: experiment.winnerVariantKey || null,
    variants: (experiment.variants || []).map((v) => ({
      key: v.key,
      name: v.name || v.key,
      weight: v.weight,
      ...(withPages && v.key !== CONTROL_KEY ? { builderData: (v.data && v.data.builderData) || null } : {}),
    })),
    createdAt: experiment.createdAt,
    updatedAt: experiment.updatedAt,
  };
}

/**
 * A test as the audit trail keeps it. A variant's page is what shoppers of a
 * live funnel are served, and no funnel revision holds it, so the row that
 * records the change carries the page itself (`withPages`) and a digest of it.
 * The digest alone names which page a later row is about.
 */
function auditView(experiment, { withPages = false } = {}) {
  return {
    name: experiment.name,
    funnelId: experiment.funnelId,
    stepKey: experiment.stepKey,
    status: experiment.status,
    winnerVariantKey: experiment.winnerVariantKey || null,
    variants: (experiment.variants || []).map((v) => {
      const page = v.key !== CONTROL_KEY && v.data ? v.data.builderData : null;
      return {
        key: v.key,
        name: v.name || v.key,
        weight: v.weight,
        ...(page ? { pageDigest: crypto.createHash('sha256').update(JSON.stringify(page)).digest('hex') } : {}),
        ...(page && withPages ? { builderData: page } : {}),
      };
    }),
  };
}

// --- results --------------------------------------------------------------

/** Two-proportion z-test, as the chance the better conversion rate is really better (0.5–1). */
function confidence(a, b) {
  if (!a || !b || a.visits < 1 || b.visits < 1) return null;
  const p1 = a.orders / a.visits;
  const p2 = b.orders / b.visits;
  const pooled = (a.orders + b.orders) / (a.visits + b.visits);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.visits + 1 / b.visits));
  if (!se) return null;
  const z = Math.abs(p1 - p2) / se;
  // Normal CDF by the Abramowitz–Stegun approximation.
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return Math.round((1 - tail) * 1000) / 1000;
}

async function results(experiment, transaction) {
  const rows = await db.ExperimentAssignment.findAll({
    where: { experimentId: experiment.id },
    attributes: ['variantKey', 'orderId'],
    transaction,
  });
  const orderIds = rows.map((r) => r.orderId).filter(Boolean);
  const orders = orderIds.length
    ? await db.Order.findAll({
        where: { id: orderIds, workspaceId: experiment.workspaceId },
        attributes: ['id', 'totalAmount'],
        transaction,
      })
    : [];
  const totalOf = new Map(orders.map((o) => [o.id, Number(o.totalAmount) || 0]));

  const variants = (experiment.variants || []).map((v) => {
    const mine = rows.filter((r) => r.variantKey === v.key);
    const withOrder = mine.filter((r) => r.orderId && totalOf.has(r.orderId));
    const revenue = withOrder.reduce((sum, r) => sum + totalOf.get(r.orderId), 0);
    const visits = mine.length;
    return {
      key: v.key,
      name: v.name || v.key,
      weight: v.weight,
      visits,
      orders: withOrder.length,
      // Rates in basis points (100 = 1%), money in minor units — like the rest of the API.
      conversionRateBp: visits ? Math.round((withOrder.length / visits) * 10000) : 0,
      revenueAmount: String(Math.round(revenue)),
      revenuePerVisitAmount: String(visits ? Math.round(revenue / visits) : 0),
    };
  });
  const ranked = [...variants].sort((x, y) => y.conversionRateBp - x.conversionRateBp);
  return {
    totalVisits: rows.length,
    variants,
    leaderKey: ranked[0] && ranked[0].visits > 0 ? ranked[0].key : null,
    confidence: confidence(ranked[0], ranked[1]),
  };
}

function bestBy(metric, variants) {
  const score = (v) => (metric === 'revenue_per_visit' ? Number(v.revenuePerVisitAmount) : v.conversionRateBp);
  return [...variants].sort((x, y) => score(y) - score(x) || y.visits - x.visits)[0] || null;
}

// --- staff ----------------------------------------------------------------

async function load(workspaceId, id, transaction) {
  const experiment = await db.Experiment.findOne({ where: { id, workspaceId, subjectType: 'funnel_step' }, transaction });
  if (!experiment) throw new NotFoundError('Split test');
  return experiment;
}

async function list(workspaceId, { funnelId } = {}) {
  const rows = await db.Experiment.findAll({
    where: { workspaceId, subjectType: 'funnel_step', ...(funnelId ? { funnelId } : {}) },
    order: [['createdAt', 'DESC']],
  });
  return rows.map((r) => present(r));
}

async function create(workspaceId, body, req) {
  const step = await db.FunnelStep.findOne({ where: { workspaceId, funnelId: body.funnelId, key: body.stepKey } });
  if (!step) throw new NotFoundError('Funnel step');
  const running = await db.Experiment.findOne({
    where: { workspaceId, funnelId: body.funnelId, stepKey: body.stepKey, status: ['running', 'paused'] },
    attributes: ['id'],
  });
  if (running) throw new ConflictError('This page already has a split test — finish or delete it first', 'SPLIT_TEST_EXISTS');

  const experiment = await db.Experiment.create({
    workspaceId,
    subjectType: 'funnel_step',
    subjectId: step.id,
    funnelId: body.funnelId,
    stepKey: body.stepKey,
    name: body.name,
    // A variant's countdown gets its fixed date once the test is live (splitTestCountdowns.js).
    variants: await require('./splitTestCountdowns').forSave(workspaceId, body.funnelId, cleanVariants(body.variants)),
    autoWinner: body.autoWinner || null,
    status: 'running',
  });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'split_test.create',
    entityType: 'Experiment',
    entityId: experiment.id,
    after: auditView(experiment, { withPages: true }),
    req,
  });
  return present(experiment, { withPages: true });
}

async function update(workspaceId, id, body, req) {
  const experiment = await load(workspaceId, id);
  const before = auditView(experiment);
  const patch = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.autoWinner !== undefined) patch.autoWinner = body.autoWinner;
  if (body.variants !== undefined) {
    if (experiment.status === 'completed') throw new ConflictError('A finished test cannot be changed', 'SPLIT_TEST_COMPLETED');
    patch.variants = await require('./splitTestCountdowns').forSave(workspaceId, experiment.funnelId, cleanVariants(body.variants));
  }
  if (body.status !== undefined) {
    // Reopening a finished test forgets its winner; finishing one needs a winner (POST …/winner).
    if (body.status === 'completed') throw new ValidationError([{ field: 'status', message: 'Pick a winner to finish the test' }]);
    patch.status = body.status;
    patch.winnerVariantKey = null;
  }
  await experiment.update(patch);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'split_test.update',
    entityType: 'Experiment',
    entityId: experiment.id,
    before,
    // The pages themselves only when this change replaced them.
    after: auditView(experiment, { withPages: body.variants !== undefined }),
    req,
  });
  return present(experiment, { withPages: true });
}

/** Finishes the test: from now on every visitor sees the winner's page. */
async function chooseWinner(workspaceId, id, variantKey, req) {
  const experiment = await load(workspaceId, id);
  if (!(experiment.variants || []).some((v) => v.key === variantKey)) {
    throw new ValidationError([{ field: 'variantKey', message: `Unknown variant "${variantKey}"` }]);
  }
  const before = auditView(experiment);
  await experiment.update({ winnerVariantKey: variantKey, status: 'completed' });
  await recordAudit({
    workspaceId,
    actorUserId: req ? req.user.id : null,
    action: 'split_test.winner',
    entityType: 'Experiment',
    entityId: experiment.id,
    before: { status: before.status, winnerVariantKey: before.winnerVariantKey },
    // From now on every visitor is served this variant's page: its digest says which.
    after: { ...auditView(experiment), by: req ? 'merchant' : 'auto' },
    req,
  });
  return present(experiment);
}

async function remove(workspaceId, id, req) {
  const experiment = await load(workspaceId, id);
  await db.ExperimentAssignment.destroy({ where: { experimentId: experiment.id } });
  await experiment.destroy();
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'split_test.delete',
    entityType: 'Experiment',
    entityId: id,
    before: auditView(experiment),
    req,
  });
  return { deleted: true, id };
}

// --- runtime --------------------------------------------------------------

function pickByWeight(variants) {
  let roll = Math.random() * 100;
  for (const v of variants) {
    roll -= v.weight;
    if (roll < 0) return v;
  }
  return variants[variants.length - 1];
}

/** The visitor's variant for a running test, assigning one on first sight. */
async function assign(experiment, visitorId) {
  const existing = await db.ExperimentAssignment.findOne({ where: { experimentId: experiment.id, visitorId } });
  if (existing) return existing.variantKey;
  const chosen = pickByWeight(experiment.variants || []);
  try {
    await db.ExperimentAssignment.create({ experimentId: experiment.id, visitorId, variantKey: chosen.key });
  } catch (err) {
    // Two first requests at once: the unique index kept one; read it back.
    if (err.name !== 'SequelizeUniqueConstraintError') throw err;
    const row = await db.ExperimentAssignment.findOne({ where: { experimentId: experiment.id, visitorId } });
    return row ? row.variantKey : chosen.key;
  }
  await maybeAutoWinner(experiment);
  return chosen.key;
}

async function maybeAutoWinner(experiment) {
  const auto = experiment.autoWinner;
  if (!auto || auto.enabled !== true || !Number.isInteger(auto.afterVisits)) return;
  const visits = await db.ExperimentAssignment.count({ where: { experimentId: experiment.id } });
  if (visits < auto.afterVisits) return;
  const { variants } = await results(experiment);
  const best = bestBy(METRICS.includes(auto.metric) ? auto.metric : 'conversion_rate', variants);
  if (best) await chooseWinner(experiment.workspaceId, experiment.id, best.key, null);
}

/**
 * Swaps the step's page for the visitor's variant. Called by the funnel
 * runtime with the payload it is about to send; never throws — a problem with
 * a test must not take a funnel page down, so the original page is served.
 */
async function applyToPayload(workspaceId, payload, session) {
  try {
    if (!payload || !payload.step || !session || !session.funnelId || !session.visitorId) return payload;
    const experiment = await db.Experiment.findOne({
      where: {
        workspaceId,
        subjectType: 'funnel_step',
        funnelId: session.funnelId,
        stepKey: payload.step.key,
        status: ['running', 'completed'],
      },
      order: [['createdAt', 'DESC']],
    });
    if (!experiment) return payload;
    const key =
      experiment.status === 'completed' ? experiment.winnerVariantKey : await assign(experiment, session.visitorId);
    const variant = (experiment.variants || []).find((v) => v.key === key);
    if (variant && variant.key !== CONTROL_KEY && variant.data && variant.data.builderData) {
      payload.step = { ...payload.step, tree: variant.data.builderData };
    }
    payload.splitTest = { id: experiment.id, variantKey: key || CONTROL_KEY };
    return payload;
  } catch (err) {
    logger.warn('Split test could not be applied', { error: err.message });
    return payload;
  }
}

/** Credits an order placed in the funnel to the visitor's variant in each of its tests. */
async function recordOrder(workspaceId, funnelId, visitorId, orderId, transaction) {
  try {
    const experiments = await db.Experiment.findAll({
      where: { workspaceId, subjectType: 'funnel_step', funnelId, status: 'running' },
      attributes: ['id'],
      transaction,
    });
    if (experiments.length === 0) return;
    await db.ExperimentAssignment.update(
      { orderId },
      { where: { experimentId: experiments.map((e) => e.id), visitorId, orderId: null }, transaction }
    );
  } catch (err) {
    logger.warn('Split test order could not be recorded', { error: err.message });
  }
}

// --- routes ---------------------------------------------------------------

const uuid = Joi.string().uuid();
const variant = Joi.object({
  key: Joi.string().trim().uppercase().pattern(/^[A-Z]$/).required(),
  name: Joi.string().trim().max(80).allow('', null).optional(),
  weight: Joi.number().integer().min(0).max(100).required(),
  // Checked by the page validator in the service; absent on the control.
  builderData: Joi.object().unknown(true).optional(),
});
const autoWinner = Joi.object({
  enabled: Joi.boolean().required(),
  afterVisits: Joi.number().integer().min(50).max(1000000).required(),
  metric: Joi.string().valid(...METRICS).required(),
});
const params = Joi.object({ workspaceId: uuid.required(), experimentId: uuid.required() });
const schemas = {
  list: { params: Joi.object({ workspaceId: uuid.required() }), query: Joi.object({ funnelId: uuid.optional() }) },
  create: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      funnelId: uuid.required(),
      stepKey: Joi.string().max(100).required(),
      name: Joi.string().trim().min(1).max(200).required(),
      variants: Joi.array().items(variant).min(2).max(5).required(),
      autoWinner: autoWinner.allow(null).optional(),
    }),
  },
  update: {
    params,
    body: Joi.object({
      name: Joi.string().trim().min(1).max(200).optional(),
      variants: Joi.array().items(variant).min(2).max(5).optional(),
      autoWinner: autoWinner.allow(null).optional(),
      status: Joi.string().valid(...STATUSES).optional(),
    }).min(1),
  },
  winner: { params, body: Joi.object({ variantKey: Joi.string().trim().uppercase().pattern(/^[A-Z]$/).required() }) },
  one: { params },
};

// Mounted at /api/v1/workspaces/:workspaceId/experiments — funnels.manage to
// read. A variant's page is served to the shoppers of a live funnel as soon as
// it is saved, with no publish in between, so every write also takes
// funnels.publish: starting a test, changing it, picking its winner, deleting it.
const PUBLISH = requirePermission(PERMISSIONS.FUNNELS_PUBLISH);
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.FUNNELS_MANAGE));
router.get(
  '/',
  validate(schemas.list),
  asyncHandler(async (req, res) => res.json({ experiments: await list(req.tenant.workspaceId, req.query) }))
);
router.post(
  '/',
  validate(schemas.create),
  PUBLISH,
  asyncHandler(async (req, res) => res.status(201).json({ experiment: await create(req.tenant.workspaceId, req.body, req) }))
);
router.get(
  '/:experimentId',
  validate(schemas.one),
  asyncHandler(async (req, res) => {
    const experiment = await load(req.tenant.workspaceId, req.params.experimentId);
    res.json({ experiment: present(experiment, { withPages: true }), results: await results(experiment) });
  })
);
router.patch(
  '/:experimentId',
  validate(schemas.update),
  PUBLISH,
  asyncHandler(async (req, res) =>
    res.json({ experiment: await update(req.tenant.workspaceId, req.params.experimentId, req.body, req) })
  )
);
router.post(
  '/:experimentId/winner',
  validate(schemas.winner),
  PUBLISH,
  asyncHandler(async (req, res) =>
    res.json({ experiment: await chooseWinner(req.tenant.workspaceId, req.params.experimentId, req.body.variantKey, req) })
  )
);
router.delete(
  '/:experimentId',
  validate(schemas.one),
  PUBLISH,
  asyncHandler(async (req, res) => res.json(await remove(req.tenant.workspaceId, req.params.experimentId, req)))
);

module.exports = { router, applyToPayload, recordOrder, results, confidence, auditView, SPLIT_TEST_METRICS: METRICS };
