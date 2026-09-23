'use strict';

const db = require('../../db/models');
const { scoped } = require('../../core/utils/scopedRepository');
const { NotFoundError, ConflictError, ValidationError, AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const logger = require('../../core/utils/logger');
const slugify = require('../../core/utils/slugify');
const orderService = require('../orders/orderService');
const {
  validateStepData,
  validateGraph,
  resolveEntry,
  isTerminalStep,
  OFFER_STEP_TYPES,
  EMPTY_TREE,
} = require('./funnelGraph');
const { conditionProblem, pickNextEdge } = require('./funnelRouting');

const Op = db.Sequelize.Op;

/**
 * Funnel engine. Staff CRUD + a page-engine-style
 * draft/publish/revision/rollback lifecycle over the funnel graph
 * (funnel -> steps -> edges), plus a public runtime that walks a visitor
 * through the frozen published snapshot one step at a time.
 *
 * Draft/publish separation is absolute, exactly as in `pagesService`: staff
 * edits only ever touch the working step/edge rows; the runtime reads only
 * `FunnelRevision.snapshot` of the funnel's current `publishedRevisionId`.
 * Publishing writes a new numbered revision; rollback just repoints the
 * pointer.
 */

// --- helpers --------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One-time deep copy — the copy shares no reference with the source, so a
// later edit to one funnel can never reach the other.
function deepClone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

async function ensureUniqueSubdomain(base) {
  let root = slugify(base).replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
  if (root.length < 3) root = `${root || 'funnel'}-funnel`;
  root = root.slice(0, 55);
  let candidate = root;
  let n = 1;
  // subdomain is globally unique, so this is not workspace-scoped.
  while (await db.Funnel.findOne({ where: { subdomain: candidate }, attributes: ['id'] })) {
    candidate = `${root}-${++n}`;
  }
  return candidate;
}

async function loadFunnel(workspaceId, funnelId, transaction) {
  return scoped(db.Funnel, workspaceId).findByPkOrThrow(funnelId, transaction ? { transaction } : {});
}

async function loadStep(workspaceId, funnelId, stepId, transaction) {
  const step = await db.FunnelStep.findOne({
    where: { id: stepId, funnelId, workspaceId },
    ...(transaction ? { transaction } : {}),
  });
  if (!step) throw new NotFoundError('FunnelStep');
  return step;
}

async function loadEdge(workspaceId, funnelId, edgeId, transaction) {
  const edge = await db.FunnelEdge.findOne({
    where: { id: edgeId, funnelId, workspaceId },
    ...(transaction ? { transaction } : {}),
  });
  if (!edge) throw new NotFoundError('FunnelEdge');
  return edge;
}

async function assertOfferUsable(workspaceId, offerId) {
  const offer = await db.Offer.findOne({ where: { id: offerId, workspaceId, status: 'active' }, attributes: ['id'] });
  if (!offer) {
    throw new ValidationError([{ field: 'offerId', message: 'Offer not found or not active in this workspace' }]);
  }
}

function toSnapshotSteps(stepRows) {
  return stepRows.map((s) => ({
    key: s.key,
    stepType: s.stepType,
    name: s.name,
    builderData: s.builderData,
    offerId: s.offerId,
    seo: s.seo || {},
  }));
}

function toSnapshotEdges(edgeRows) {
  return edgeRows.map((e) => ({
    fromStepKey: e.fromStepKey,
    toStepKey: e.toStepKey,
    condition: e.condition || null,
    priority: e.priority,
  }));
}

// --- funnels -----------------------------------------------------------

async function createFunnel(workspaceId, data, req) {
  const subdomain = await ensureUniqueSubdomain(data.subdomain || data.name);
  const funnel = await scoped(db.Funnel, workspaceId).create({ name: data.name, subdomain, status: 'draft' });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'funnel.create',
    entityType: 'Funnel',
    entityId: funnel.id,
    after: funnel.toJSON(),
    req,
  });
  return funnel;
}

async function listFunnels(workspaceId) {
  return db.Funnel.findAll({ where: { workspaceId }, order: [['createdAt', 'ASC']] });
}

async function getFunnel(workspaceId, funnelId) {
  const funnel = await loadFunnel(workspaceId, funnelId);
  const steps = await db.FunnelStep.findAll({ where: { workspaceId, funnelId }, order: [['createdAt', 'ASC']] });
  const edges = await db.FunnelEdge.findAll({
    where: { workspaceId, funnelId },
    order: [['priority', 'DESC'], ['createdAt', 'ASC']],
  });
  let publishedRevision = null;
  if (funnel.publishedRevisionId) {
    const rev = await db.FunnelRevision.findOne({
      where: { id: funnel.publishedRevisionId, funnelId },
      attributes: ['id', 'revisionNumber', 'note', 'createdAt'],
    });
    if (rev) publishedRevision = rev;
  }
  return { funnel, steps, edges, publishedRevision };
}

async function updateFunnel(workspaceId, funnelId, data, req) {
  const funnel = await loadFunnel(workspaceId, funnelId);
  const before = funnel.toJSON();
  const patch = {};
  if (data.name !== undefined) patch.name = data.name;
  await funnel.update(patch);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'funnel.update',
    entityType: 'Funnel',
    entityId: funnel.id,
    before,
    after: funnel.toJSON(),
    req,
  });
  return funnel;
}

const COPY_SUFFIX = ' (copy)';

/**
 * Duplicate a funnel into a brand-new draft in the same workspace.
 *
 * Steps and edges are copied verbatim, `key` included: keys are unique per
 * funnel rather than globally, so keeping them means every copied edge still
 * points at the step it pointed at in the source and the graph needs no
 * remapping. Revisions are deliberately NOT copied — the copy has never been
 * published, so it starts at `draft` with no `publishedRevisionId`, no
 * history, and its own free subdomain. The runtime therefore can't reach it
 * until someone publishes it, which is the point of duplicating.
 */
async function duplicateFunnel(workspaceId, funnelId, data, req) {
  const source = await loadFunnel(workspaceId, funnelId);
  const name = data.name || `${source.name.slice(0, 200 - COPY_SUFFIX.length)}${COPY_SUFFIX}`;
  // Resolved before the transaction opens, exactly as createFunnel does — the
  // subdomain is globally unique, so it can't be checked workspace-scoped.
  const subdomain = await ensureUniqueSubdomain(name);

  return db.sequelize.transaction(async (t) => {
    const stepRows = await db.FunnelStep.findAll({
      where: { workspaceId, funnelId },
      order: [['createdAt', 'ASC']],
      transaction: t,
    });
    const edgeRows = await db.FunnelEdge.findAll({
      where: { workspaceId, funnelId },
      order: [['priority', 'DESC'], ['createdAt', 'ASC']],
      transaction: t,
    });

    const funnel = await scoped(db.Funnel, workspaceId).create(
      { name, subdomain, status: 'draft', publishedRevisionId: null },
      { transaction: t }
    );

    const steps = [];
    for (const s of stepRows) {
      steps.push(
        await db.FunnelStep.create(
          {
            workspaceId,
            funnelId: funnel.id,
            key: s.key,
            stepType: s.stepType,
            name: s.name,
            builderData: deepClone(s.builderData),
            // Offers are workspace-scoped, so the copy's step sells the same
            // one the source did.
            offerId: s.offerId,
            // abTestExperimentId is intentionally not carried over: an
            // experiment belongs to the step it was set up on.
            seo: deepClone(s.seo) || {},
          },
          { transaction: t }
        )
      );
    }

    const edges = [];
    for (const e of edgeRows) {
      edges.push(
        await db.FunnelEdge.create(
          {
            workspaceId,
            funnelId: funnel.id,
            fromStepKey: e.fromStepKey,
            toStepKey: e.toStepKey,
            condition: deepClone(e.condition),
            priority: e.priority,
          },
          { transaction: t }
        )
      );
    }

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'funnel.duplicate',
      entityType: 'Funnel',
      entityId: funnel.id,
      after: funnel.toJSON(),
      metadata: { sourceFunnelId: source.id, stepCount: steps.length, edgeCount: edges.length },
      req,
      transaction: t,
    });

    return { funnel, steps, edges };
  });
}

async function deleteFunnel(workspaceId, funnelId, req) {
  const funnel = await loadFunnel(workspaceId, funnelId);
  const before = funnel.toJSON();
  // steps / edges / revisions / sessions cascade via FK.
  await funnel.destroy();
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'funnel.delete',
    entityType: 'Funnel',
    entityId: funnelId,
    before,
    req,
  });
  return { deleted: true };
}

// --- steps ------------------------------------------------------------

async function createStep(workspaceId, funnelId, data, req) {
  await loadFunnel(workspaceId, funnelId);
  const builderData = data.builderData !== undefined ? data.builderData : EMPTY_TREE;
  validateStepData(builderData, { label: `step "${data.key}"` });
  if (data.offerId) await assertOfferUsable(workspaceId, data.offerId);

  const clash = await db.FunnelStep.findOne({ where: { funnelId, key: data.key }, attributes: ['id'] });
  if (clash) throw new ConflictError(`A step with key "${data.key}" already exists in this funnel`, 'FUNNEL_STEP_KEY_TAKEN');

  const step = await db.FunnelStep.create({
    workspaceId,
    funnelId,
    key: data.key,
    stepType: data.stepType,
    name: data.name,
    builderData,
    offerId: data.offerId || null,
    seo: data.seo || {},
  });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'funnel.step.create',
    entityType: 'FunnelStep',
    entityId: step.id,
    after: step.toJSON(),
    req,
  });
  return step;
}

async function listSteps(workspaceId, funnelId) {
  await loadFunnel(workspaceId, funnelId);
  return db.FunnelStep.findAll({ where: { workspaceId, funnelId }, order: [['createdAt', 'ASC']] });
}

async function getStep(workspaceId, funnelId, stepId) {
  await loadFunnel(workspaceId, funnelId);
  return loadStep(workspaceId, funnelId, stepId);
}

async function updateStep(workspaceId, funnelId, stepId, data, req) {
  await loadFunnel(workspaceId, funnelId);
  const step = await loadStep(workspaceId, funnelId, stepId);
  const before = step.toJSON();

  const patch = {};
  if (data.stepType !== undefined) patch.stepType = data.stepType;
  if (data.name !== undefined) patch.name = data.name;
  if (data.seo !== undefined) patch.seo = data.seo;
  if (data.builderData !== undefined) {
    validateStepData(data.builderData, { label: `step "${step.key}"` });
    patch.builderData = data.builderData;
  }
  if (data.offerId !== undefined) {
    if (data.offerId) await assertOfferUsable(workspaceId, data.offerId);
    patch.offerId = data.offerId; // null clears it
  }

  await step.update(patch);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'funnel.step.update',
    entityType: 'FunnelStep',
    entityId: step.id,
    before,
    after: step.toJSON(),
    req,
  });
  return step;
}

async function deleteStep(workspaceId, funnelId, stepId, req) {
  return db.sequelize.transaction(async (t) => {
    await scoped(db.Funnel, workspaceId).findByPkOrThrow(funnelId, { transaction: t });
    const step = await db.FunnelStep.findOne({ where: { id: stepId, funnelId, workspaceId }, transaction: t });
    if (!step) throw new NotFoundError('FunnelStep');
    const before = step.toJSON();

    // Draft edges that touch this step key would otherwise dangle.
    await db.FunnelEdge.destroy({
      where: { funnelId, workspaceId, [Op.or]: [{ fromStepKey: step.key }, { toStepKey: step.key }] },
      transaction: t,
    });
    await step.destroy({ transaction: t });

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'funnel.step.delete',
      entityType: 'FunnelStep',
      entityId: stepId,
      before,
      req,
      transaction: t,
    });
    return { deleted: true };
  });
}

// --- edges ----------------------------------------------------------

async function stepKeySet(workspaceId, funnelId, transaction) {
  const rows = await db.FunnelStep.findAll({
    where: { workspaceId, funnelId },
    attributes: ['key'],
    ...(transaction ? { transaction } : {}),
  });
  return new Set(rows.map((r) => r.key));
}

async function createEdge(workspaceId, funnelId, data, req) {
  await loadFunnel(workspaceId, funnelId);
  const keys = await stepKeySet(workspaceId, funnelId);

  const problems = [];
  if (!keys.has(data.fromStepKey)) {
    problems.push({ field: 'fromStepKey', message: `No step with key "${data.fromStepKey}" in this funnel` });
  }
  if (!keys.has(data.toStepKey)) {
    problems.push({ field: 'toStepKey', message: `No step with key "${data.toStepKey}" in this funnel` });
  }
  const condProblem = conditionProblem(data.condition);
  if (condProblem) problems.push({ field: 'condition', message: condProblem });
  if (problems.length) throw new ValidationError(problems, 'Invalid edge');

  const edge = await db.FunnelEdge.create({
    workspaceId,
    funnelId,
    fromStepKey: data.fromStepKey,
    toStepKey: data.toStepKey,
    condition: data.condition === undefined ? null : data.condition,
    priority: data.priority || 0,
  });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'funnel.edge.create',
    entityType: 'FunnelEdge',
    entityId: edge.id,
    after: edge.toJSON(),
    req,
  });
  return edge;
}

async function listEdges(workspaceId, funnelId) {
  await loadFunnel(workspaceId, funnelId);
  return db.FunnelEdge.findAll({
    where: { workspaceId, funnelId },
    order: [['priority', 'DESC'], ['createdAt', 'ASC']],
  });
}

async function updateEdge(workspaceId, funnelId, edgeId, data, req) {
  await loadFunnel(workspaceId, funnelId);
  const edge = await loadEdge(workspaceId, funnelId, edgeId);
  const before = edge.toJSON();

  const keys = await stepKeySet(workspaceId, funnelId);
  const problems = [];
  const patch = {};
  if (data.fromStepKey !== undefined) {
    if (!keys.has(data.fromStepKey)) problems.push({ field: 'fromStepKey', message: `No step with key "${data.fromStepKey}"` });
    patch.fromStepKey = data.fromStepKey;
  }
  if (data.toStepKey !== undefined) {
    if (!keys.has(data.toStepKey)) problems.push({ field: 'toStepKey', message: `No step with key "${data.toStepKey}"` });
    patch.toStepKey = data.toStepKey;
  }
  if (data.condition !== undefined) {
    const condProblem = conditionProblem(data.condition);
    if (condProblem) problems.push({ field: 'condition', message: condProblem });
    patch.condition = data.condition;
  }
  if (data.priority !== undefined) patch.priority = data.priority;
  if (problems.length) throw new ValidationError(problems, 'Invalid edge');

  await edge.update(patch);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'funnel.edge.update',
    entityType: 'FunnelEdge',
    entityId: edge.id,
    before,
    after: edge.toJSON(),
    req,
  });
  return edge;
}

async function deleteEdge(workspaceId, funnelId, edgeId, req) {
  await loadFunnel(workspaceId, funnelId);
  const edge = await loadEdge(workspaceId, funnelId, edgeId);
  const before = edge.toJSON();
  await edge.destroy();
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'funnel.edge.delete',
    entityType: 'FunnelEdge',
    entityId: edgeId,
    before,
    req,
  });
  return { deleted: true };
}

// --- publish / revisions / rollback --------------------------------

async function publishFunnel(workspaceId, funnelId, userId, note, req) {
  return db.sequelize.transaction(async (t) => {
    const funnel = await db.Funnel.findOne({
      where: { id: funnelId, workspaceId },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!funnel) throw new NotFoundError('Funnel');

    const stepRows = await db.FunnelStep.findAll({
      where: { workspaceId, funnelId },
      order: [['createdAt', 'ASC']],
      transaction: t,
    });
    const edgeRows = await db.FunnelEdge.findAll({
      where: { workspaceId, funnelId },
      order: [['priority', 'DESC'], ['createdAt', 'ASC']],
      transaction: t,
    });

    const steps = toSnapshotSteps(stepRows);
    const edges = toSnapshotEdges(edgeRows);

    const problems = validateGraph(steps, edges, { requireContent: true });
    edges.forEach((e, i) => {
      const p = conditionProblem(e.condition);
      if (p) problems.push({ field: `edges[${i}].condition`, message: p });
    });
    for (const s of steps) {
      if (OFFER_STEP_TYPES.has(s.stepType) && s.offerId) {
        const offer = await db.Offer.findOne({
          where: { id: s.offerId, workspaceId, status: 'active' },
          attributes: ['id'],
          transaction: t,
        });
        if (!offer) {
          problems.push({ field: `steps.${s.key}.offerId`, message: `Offer for step "${s.key}" not found or not active` });
        }
      }
    }
    if (problems.length) {
      throw new ValidationError(problems, 'Funnel cannot be published yet — fix the issues below');
    }

    const { entryKey } = resolveEntry(steps, edges);

    const maxRow = await db.FunnelRevision.findOne({
      where: { funnelId },
      order: [['revisionNumber', 'DESC']],
      attributes: ['revisionNumber'],
      transaction: t,
    });
    const revisionNumber = (maxRow ? maxRow.revisionNumber : 0) + 1;

    const snapshot = {
      funnel: { id: funnel.id, name: funnel.name, subdomain: funnel.subdomain },
      entryKey,
      steps,
      edges,
    };

    const revision = await db.FunnelRevision.create(
      { workspaceId, funnelId, revisionNumber, snapshot, publishedByUserId: userId, note: note || null },
      { transaction: t }
    );

    await funnel.update({ status: 'published', publishedRevisionId: revision.id }, { transaction: t });

    await recordAudit({
      workspaceId,
      actorUserId: userId,
      action: 'funnel.publish',
      entityType: 'Funnel',
      entityId: funnel.id,
      after: { revisionId: revision.id, revisionNumber, stepCount: steps.length },
      metadata: { revisionNumber },
      req,
      transaction: t,
    });

    return { funnel, revision };
  });
}

async function listRevisions(workspaceId, funnelId) {
  await loadFunnel(workspaceId, funnelId);
  const revisions = await db.FunnelRevision.findAll({
    where: { workspaceId, funnelId },
    order: [['revisionNumber', 'DESC']],
    attributes: ['id', 'revisionNumber', 'note', 'publishedByUserId', 'createdAt', 'snapshot'],
  });
  return revisions.map((r) => ({
    id: r.id,
    revisionNumber: r.revisionNumber,
    note: r.note,
    publishedByUserId: r.publishedByUserId,
    createdAt: r.createdAt,
    stepCount: Array.isArray(r.snapshot && r.snapshot.steps) ? r.snapshot.steps.length : 0,
  }));
}

async function rollbackToRevision(workspaceId, funnelId, revisionId, userId, req) {
  return db.sequelize.transaction(async (t) => {
    const funnel = await db.Funnel.findOne({
      where: { id: funnelId, workspaceId },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!funnel) throw new NotFoundError('Funnel');

    const revision = await db.FunnelRevision.findOne({
      where: { id: revisionId, funnelId, workspaceId },
      transaction: t,
    });
    if (!revision) throw new NotFoundError('FunnelRevision');

    await funnel.update({ status: 'published', publishedRevisionId: revision.id }, { transaction: t });

    await recordAudit({
      workspaceId,
      actorUserId: userId,
      action: 'funnel.rollback',
      entityType: 'Funnel',
      entityId: funnel.id,
      after: { revisionId: revision.id, revisionNumber: revision.revisionNumber },
      metadata: { rolledBackToRevision: revision.revisionNumber },
      req,
      transaction: t,
    });

    return { funnel, revision };
  });
}

async function setStatus(workspaceId, funnelId, targetStatus, userId, req) {
  const funnel = await loadFunnel(workspaceId, funnelId);
  if (!funnel.publishedRevisionId) {
    throw new ConflictError('Publish this funnel before pausing or resuming it', 'FUNNEL_NOT_PUBLISHED');
  }
  await funnel.update({ status: targetStatus });
  await recordAudit({
    workspaceId,
    actorUserId: userId,
    action: targetStatus === 'paused' ? 'funnel.pause' : 'funnel.resume',
    entityType: 'Funnel',
    entityId: funnel.id,
    after: { status: targetStatus },
    req,
  });
  return funnel;
}

const pauseFunnel = (workspaceId, funnelId, userId, req) => setStatus(workspaceId, funnelId, 'paused', userId, req);
const resumeFunnel = (workspaceId, funnelId, userId, req) => setStatus(workspaceId, funnelId, 'published', userId, req);

// --- public runtime -------------------------------------------------

function renderStepData(snapshot, stepKey) {
  const step = (snapshot.steps || []).find((s) => s.key === stepKey);
  if (!step) throw new NotFoundError('Step');
  return { key: step.key, name: step.name, stepType: step.stepType, tree: step.builderData, seo: step.seo || {} };
}

async function resolveStepPayload(workspaceId, snapshot, stepKey) {
  const step = (snapshot.steps || []).find((s) => s.key === stepKey);
  if (!step) throw new NotFoundError('Step');
  const payload = { step: renderStepData(snapshot, stepKey) };
  if (OFFER_STEP_TYPES.has(step.stepType) && step.offerId) {
    const offer = await db.Offer.findOne({
      where: { id: step.offerId, workspaceId },
      include: [{ model: db.OfferVariant, as: 'lines' }],
    });
    if (offer) {
      payload.offer = {
        id: offer.id,
        name: offer.name,
        priceAmount: offer.priceAmount,
        currency: offer.currency,
        badge: offer.badge,
        lines: (offer.lines || []).map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
      };
    }
  }
  return payload;
}

function publicSession(session) {
  return {
    id: session.id,
    currentStepKey: session.currentStepKey,
    path: session.path,
    status: session.status,
    orderId: session.orderId,
  };
}

const stepExists = (snapshot, stepKey) => (snapshot.steps || []).some((s) => s.key === stepKey);

/**
 * Republishing a funnel can delete the step a live session is sitting on. The
 * visitor is then mid-journey on a page that no longer exists, so put them
 * back at the funnel's entry instead of answering "Step not found". Their
 * path is cleared with it: every key in it may be gone too.
 */
async function resetSessionToEntry(session, snapshot, transaction) {
  const entryKey = snapshot.entryKey;
  if (!entryKey || !stepExists(snapshot, entryKey)) throw new NotFoundError('Step');
  logger.warn(
    `funnel session ${session.id}: step "${session.currentStepKey}" is no longer in the published revision — restarting at "${entryKey}"`
  );
  session.currentStepKey = entryKey;
  session.path = [];
  await session.save(transaction ? { transaction } : undefined);
  return session;
}

async function loadPublishedSnapshot(workspaceId, funnelId, transaction) {
  const funnel = await db.Funnel.findOne({
    where: { id: funnelId, workspaceId },
    ...(transaction ? { transaction } : {}),
  });
  if (!funnel) throw new NotFoundError('Funnel');
  if (funnel.status === 'paused') {
    throw new AppError('FUNNEL_PAUSED', 'This funnel is not currently available', 410);
  }
  if (funnel.status !== 'published' || !funnel.publishedRevisionId) throw new NotFoundError('Funnel');
  const revision = await db.FunnelRevision.findOne({
    where: { id: funnel.publishedRevisionId, funnelId: funnel.id },
    ...(transaction ? { transaction } : {}),
  });
  if (!revision) throw new NotFoundError('Funnel');
  return { funnel, snapshot: revision.snapshot || {} };
}

async function startSession(workspaceId, funnelRef, body) {
  const where = { workspaceId };
  if (UUID_RE.test(funnelRef)) where.id = funnelRef;
  else where.subdomain = funnelRef;

  const funnelLookup = await db.Funnel.findOne({ where });
  if (!funnelLookup) throw new NotFoundError('Funnel');

  const { funnel, snapshot } = await loadPublishedSnapshot(workspaceId, funnelLookup.id);

  let session = await db.FunnelSession.findOne({
    where: { workspaceId, funnelId: funnel.id, visitorId: body.visitorId, status: 'active' },
    order: [['createdAt', 'DESC']],
  });
  if (!session) {
    session = await db.FunnelSession.create({
      workspaceId,
      funnelId: funnel.id,
      visitorId: body.visitorId,
      currentStepKey: snapshot.entryKey,
      path: [],
      attribution: body.attribution || {},
      status: 'active',
    });
  }

  // Only 'active' sessions are resumed above, so a completed visitor always
  // starts a fresh journey. A resumed one may still be sitting on a step a
  // republish removed.
  if (!stepExists(snapshot, session.currentStepKey)) {
    await resetSessionToEntry(session, snapshot);
  }

  const payload = await resolveStepPayload(workspaceId, snapshot, session.currentStepKey);
  return {
    funnel: { id: funnel.id, name: funnel.name, subdomain: funnel.subdomain },
    session: publicSession(session),
    ...payload,
  };
}

async function getSessionStep(workspaceId, funnelId, sessionId) {
  const session = await db.FunnelSession.findOne({ where: { id: sessionId, funnelId, workspaceId } });
  if (!session) throw new NotFoundError('FunnelSession');
  const { snapshot } = await loadPublishedSnapshot(workspaceId, funnelId);

  if (session.status === 'completed') {
    // Still serve the step it finished on — that page is the thank-you the
    // visitor is looking at, and refreshing it must not blank it. Nothing to
    // render (or to resume) if a republish removed that step.
    if (!stepExists(snapshot, session.currentStepKey)) return { done: true, session: publicSession(session) };
    const finishedPayload = await resolveStepPayload(workspaceId, snapshot, session.currentStepKey);
    return { done: true, session: publicSession(session), ...finishedPayload };
  }

  if (!stepExists(snapshot, session.currentStepKey)) {
    await resetSessionToEntry(session, snapshot);
  }
  const payload = await resolveStepPayload(workspaceId, snapshot, session.currentStepKey);
  return { session: publicSession(session), ...payload };
}

/**
 * Creates the follow-on order for an accepted upsell/downsell through the
 * shared order engine (server-side pricing, transactional inventory,
 * idempotency) and reuses the original order's customer/address/payment.
 * Runs inside the caller's transaction, so the order and the session move that
 * routes the visitor past the offer commit together or not at all — a failure
 * after the order was created must never leave a charged visitor on a session
 * that never advanced. The caller links it via `linked_from_order_id`.
 */
async function createFollowOnOrder(workspaceId, funnelId, step, session, req, transaction) {
  if (!session.orderId) {
    throw new ValidationError(
      [{ field: 'session', message: 'This upsell has no prior order to attach to — the visitor must complete checkout first' }],
      'Cannot accept this offer'
    );
  }
  const original = await db.Order.findOne({ where: { id: session.orderId, workspaceId }, transaction });
  if (!original) throw new NotFoundError('Order');

  const offer = await db.Offer.findOne({
    where: { id: step.offerId, workspaceId, status: 'active' },
    include: [{ model: db.OfferVariant, as: 'lines' }],
    transaction,
  });
  if (!offer || (offer.lines || []).length === 0) throw new NotFoundError('Offer');

  const { order } = await orderService.createOrder(
    workspaceId,
    {
      items: [{ variantId: offer.lines[0].variantId, offerId: offer.id, quantity: 1 }],
      contact: original.contactSnapshot,
      shippingAddress: original.shippingAddressSnapshot || undefined,
      paymentMethod: original.paymentMethod,
      funnelId,
    },
    { user: null, headers: req && req.headers ? req.headers : {}, ip: req ? req.ip : null },
    { transaction }
  );
  return { order, originalId: original.id };
}

async function advanceSession(workspaceId, funnelId, sessionId, body, req) {
  const { outcome, fromStepKey } = body;

  return db.sequelize.transaction(async (t) => {
    const session = await db.FunnelSession.findOne({
      where: { id: sessionId, funnelId, workspaceId },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!session) throw new NotFoundError('FunnelSession');

    // A stale tab, a double-submitted button or a replayed request: the client
    // names the step it produced this outcome on, and the session has since
    // moved past it. Applying it would route the visitor from somewhere they
    // no longer are, so refuse and change nothing.
    if (fromStepKey && fromStepKey !== session.currentStepKey) {
      throw new AppError(
        'STEP_MISMATCH',
        `This outcome came from step "${fromStepKey}", but the session has already moved to "${session.currentStepKey}"`,
        409
      );
    }

    if (session.status === 'completed') {
      return { done: true, session: publicSession(session) };
    }

    const funnel = await db.Funnel.findOne({ where: { id: funnelId, workspaceId }, transaction: t });
    if (!funnel || !funnel.publishedRevisionId) throw new NotFoundError('Funnel');
    const revision = await db.FunnelRevision.findOne({
      where: { id: funnel.publishedRevisionId, funnelId },
      transaction: t,
    });
    if (!revision) throw new NotFoundError('Funnel');

    const snapshot = revision.snapshot || {};
    const steps = snapshot.steps || [];
    const edges = snapshot.edges || [];
    const currentStep = steps.find((s) => s.key === session.currentStepKey);
    if (!currentStep) {
      // A republish removed the step this outcome belongs to. There is nothing
      // left to route from, so restart the visitor at the entry instead of
      // dead-ending them; the outcome is dropped with the step it came from.
      await resetSessionToEntry(session, snapshot, t);
      const restarted = await resolveStepPayload(workspaceId, snapshot, session.currentStepKey);
      return { session: publicSession(session), ...restarted };
    }

    // Accepted upsell/downsell -> a linked follow-on order, in this same
    // transaction so it cannot outlive a failed advance.
    let followOn = null;
    if (outcome.type === 'accepted_offer' && OFFER_STEP_TYPES.has(currentStep.stepType)) {
      followOn = await createFollowOnOrder(workspaceId, funnelId, currentStep, session, req, t);
    }

    // completed_checkout carries the order just placed on this step.
    if (outcome.type === 'completed_checkout' && outcome.orderId) {
      const [n] = await db.Order.update(
        { funnelId },
        { where: { id: outcome.orderId, workspaceId }, transaction: t }
      );
      if (n) session.orderId = outcome.orderId;
    }

    const outbound = edges.filter((e) => e.fromStepKey === session.currentStepKey);
    const nextEdge = pickNextEdge(outbound, outcome);

    session.path = [...session.path, session.currentStepKey];
    let result;
    if (nextEdge) {
      session.currentStepKey = nextEdge.toStepKey;
      // Landing on a step no edge leaves ends the journey. Complete it here
      // rather than waiting for one more advance that has nowhere to go — but
      // still return the step, because that page is the thank-you the visitor
      // has to see.
      const finished = isTerminalStep(session.currentStepKey, edges);
      if (finished) {
        session.status = 'completed';
        session.completedAt = new Date();
      }
      await session.save({ transaction: t });
      const payload = await resolveStepPayload(workspaceId, snapshot, session.currentStepKey);
      result = { ...(finished ? { done: true } : {}), session: publicSession(session), ...payload };
    } else {
      // No matching outbound edge — the funnel ends here.
      session.status = 'completed';
      session.completedAt = new Date();
      await session.save({ transaction: t });
      result = { done: true, session: publicSession(session) };
    }

    if (followOn) {
      await db.Order.update(
        { linkedFromOrderId: followOn.originalId },
        { where: { id: followOn.order.id, workspaceId }, transaction: t }
      );
      result.followOnOrder = {
        id: followOn.order.id,
        orderNumber: followOn.order.orderNumber,
        totalAmount: followOn.order.totalAmount,
        linkedFromOrderId: followOn.originalId,
      };
    }

    return result;
  });
}

module.exports = {
  createFunnel,
  listFunnels,
  getFunnel,
  updateFunnel,
  duplicateFunnel,
  deleteFunnel,
  createStep,
  listSteps,
  getStep,
  updateStep,
  deleteStep,
  createEdge,
  listEdges,
  updateEdge,
  deleteEdge,
  publishFunnel,
  listRevisions,
  rollbackToRevision,
  pauseFunnel,
  resumeFunnel,
  startSession,
  getSessionStep,
  advanceSession,
};
