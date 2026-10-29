'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { createIpMinuteLimiter } = require('../../core/middleware/rateLimiters');
const { NotFoundError, ValidationError, ConflictError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { results, SPLIT_TEST_METRICS } = require('../funnels/splitTests');
const logger = require('../../core/utils/logger');

/**
 * A/B tests on a product page (SPEC §9.6 "A/B for products"): the split-test
 * engine (Experiment + ExperimentAssignment, funnels/splitTests.js) with
 * subjectType 'product_page' and subjectId = the product.
 *
 * Variant 'A' is the product as it is — the control. Every other variant
 * changes the price of some of its variants (`data.prices`, variantId → minor
 * units) and/or its pictures (`data.media`, the product's media shape).
 *
 * The price is the server's, never the browser's:
 *  - a visitor is pinned to a variant the first time the product page asks
 *    (GET /store/:ws/products/:id/test, X-Visitor-Id);
 *  - the cart remembers who filled it (carts.visitor_id), and the cart, the
 *    shipping quote, the abandoned checkout and the order all price a plain
 *    variant line for that visitor at their variant's price
 *    (pinPrices → orderService.priceLine). Offer lines keep the offer's price.
 *  - only a running test changes prices, only for visitors it already
 *    assigned; a paused test shows everyone the control, a finished one wrote
 *    its winner into the product.
 * Funnels price their own way and are left alone.
 *
 * An order with the product, from an assigned visitor, is credited to their
 * variant; results are the split tests' (visits, orders, conversion,
 * revenue per visit, confidence). Picking the winner writes its prices and
 * pictures into the product and finishes the test.
 */

const SUBJECT = 'product_page';
const CONTROL_KEY = 'A';
const OPEN = ['running', 'paused'];
// Carried on an order item by pinPrices; a Symbol, so no request body can set it.
const TEST_PRICE = Symbol.for('zimos.productTestPrice');
const VISITOR_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The X-Visitor-Id header when it is a valid visitor id, else null (never throws). */
function visitorOf(req) {
  const value = req && req.headers ? req.headers['x-visitor-id'] : null;
  return typeof value === 'string' && VISITOR_ID.test(value) ? value : null;
}

// --- shape ----------------------------------------------------------------

function cleanVariants(product, variants) {
  const problems = [];
  const keys = new Set();
  const own = new Set((product.variants || []).map((v) => v.id));
  let total = 0;
  let changes = false;
  variants.forEach((v, i) => {
    if (keys.has(v.key)) problems.push({ field: `variants[${i}].key`, message: `Duplicate variant "${v.key}"` });
    keys.add(v.key);
    total += v.weight;
    if (v.key === CONTROL_KEY) return;
    for (const id of Object.keys(v.prices || {})) {
      if (!own.has(id)) problems.push({ field: `variants[${i}].prices.${id}`, message: 'Not a variant of this product' });
    }
    if (Object.keys(v.prices || {}).length > 0 || Array.isArray(v.media)) changes = true;
  });
  if (!keys.has(CONTROL_KEY)) problems.push({ field: 'variants', message: `One variant must be "${CONTROL_KEY}" — the product as it is` });
  if (total !== 100) problems.push({ field: 'variants', message: `The shares must add up to 100 (they add up to ${total})` });
  if (!changes) problems.push({ field: 'variants', message: 'Change a price or the pictures in at least one variant' });
  if (problems.length) throw new ValidationError(problems, 'Invalid product test');
  return variants.map((v) => ({
    key: v.key,
    name: v.name || v.key,
    weight: v.weight,
    data:
      v.key === CONTROL_KEY
        ? {}
        : { prices: Object.fromEntries(Object.entries(v.prices || {}).map(([id, amount]) => [id, Number(amount)])), media: Array.isArray(v.media) ? v.media : null },
  }));
}

function present(experiment) {
  return {
    id: experiment.id,
    productId: experiment.subjectId,
    name: experiment.name,
    status: experiment.status,
    autoWinner: experiment.autoWinner || { enabled: false, afterVisits: 2000, metric: 'conversion_rate' },
    winnerVariantKey: experiment.winnerVariantKey || null,
    variants: (experiment.variants || []).map((v) => ({
      key: v.key,
      name: v.name || v.key,
      weight: v.weight,
      prices: (v.data && v.data.prices) || {},
      media: (v.data && v.data.media) || null,
    })),
    createdAt: experiment.createdAt,
    updatedAt: experiment.updatedAt,
  };
}

// --- staff ----------------------------------------------------------------

async function loadProduct(workspaceId, productId, transaction) {
  const product = await db.Product.findOne({
    where: { id: productId, workspaceId },
    include: [{ model: db.ProductVariant, as: 'variants', attributes: ['id', 'priceAmount', 'optionValues', 'status'] }],
    transaction,
  });
  if (!product) throw new NotFoundError('Product');
  return product;
}

async function load(workspaceId, id, transaction) {
  const experiment = await db.Experiment.findOne({ where: { id, workspaceId, subjectType: SUBJECT }, transaction });
  if (!experiment) throw new NotFoundError('Product test');
  return experiment;
}

async function list(workspaceId, { productId } = {}) {
  const rows = await db.Experiment.findAll({
    where: { workspaceId, subjectType: SUBJECT, ...(productId ? { subjectId: productId } : {}) },
    order: [['createdAt', 'DESC']],
  });
  return rows.map(present);
}

async function create(workspaceId, body, req) {
  const product = await loadProduct(workspaceId, body.productId);
  const open = await db.Experiment.findOne({
    where: { workspaceId, subjectType: SUBJECT, subjectId: product.id, status: OPEN },
    attributes: ['id'],
  });
  if (open) throw new ConflictError('This product already has a test — finish or delete it first', 'PRODUCT_TEST_EXISTS');
  const experiment = await db.Experiment.create({
    workspaceId,
    subjectType: SUBJECT,
    subjectId: product.id,
    name: body.name,
    variants: cleanVariants(product, body.variants),
    autoWinner: body.autoWinner || null,
    status: 'running',
  });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'product_test.create',
    entityType: 'Experiment',
    entityId: experiment.id,
    after: { name: experiment.name, productId: product.id },
    req,
  });
  return present(experiment);
}

async function update(workspaceId, id, body, req) {
  const experiment = await load(workspaceId, id);
  const before = { name: experiment.name, status: experiment.status };
  const patch = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.autoWinner !== undefined) patch.autoWinner = body.autoWinner;
  if (experiment.status === 'completed' && (body.variants !== undefined || body.status !== undefined)) {
    throw new ConflictError('A finished test cannot be changed', 'PRODUCT_TEST_COMPLETED');
  }
  if (body.variants !== undefined) patch.variants = cleanVariants(await loadProduct(workspaceId, experiment.subjectId), body.variants);
  // Finishing takes a winner (POST …/winner).
  if (body.status !== undefined) patch.status = body.status;
  await experiment.update(patch);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'product_test.update',
    entityType: 'Experiment',
    entityId: experiment.id,
    before,
    after: { name: experiment.name, status: experiment.status },
    req,
  });
  return present(experiment);
}

/**
 * Finishes the test: the winner's prices and pictures become the product's
 * own, so every shopper sees them from now on. `req` is null for the automatic winner.
 */
async function chooseWinner(workspaceId, id, variantKey, req) {
  return db.sequelize.transaction(async (transaction) => {
    const experiment = await load(workspaceId, id, transaction);
    if (experiment.status === 'completed') throw new ConflictError('This test is already finished', 'PRODUCT_TEST_COMPLETED');
    const winner = (experiment.variants || []).find((v) => v.key === variantKey);
    if (!winner) throw new ValidationError([{ field: 'variantKey', message: `Unknown variant "${variantKey}"` }]);

    const product = await loadProduct(workspaceId, experiment.subjectId, transaction);
    const applied = { prices: {}, media: false };
    if (winner.key !== CONTROL_KEY) {
      const data = winner.data || {};
      for (const variant of product.variants) {
        const amount = data.prices && data.prices[variant.id];
        if (amount === undefined || Number(amount) === Number(variant.priceAmount)) continue;
        applied.prices[variant.id] = { before: Number(variant.priceAmount), after: Number(amount) };
        await variant.update({ priceAmount: amount }, { transaction });
      }
      if (Array.isArray(data.media)) {
        await product.update({ media: data.media }, { transaction });
        applied.media = true;
      }
    }
    await experiment.update({ winnerVariantKey: winner.key, status: 'completed' }, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req ? req.user.id : null,
      action: 'product_test.winner',
      entityType: 'Experiment',
      entityId: experiment.id,
      after: { winnerVariantKey: winner.key, productId: product.id, applied, by: req ? 'merchant' : 'auto' },
      req,
      transaction,
    });
    return present(experiment);
  });
}

async function remove(workspaceId, id, req) {
  const experiment = await load(workspaceId, id);
  await db.ExperimentAssignment.destroy({ where: { experimentId: experiment.id } });
  await experiment.destroy();
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'product_test.delete',
    entityType: 'Experiment',
    entityId: id,
    before: { name: experiment.name, productId: experiment.subjectId },
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
  await maybeAutoWinner(experiment).catch((err) => logger.warn('Product test auto winner failed', { error: err.message }));
  return chosen.key;
}

async function maybeAutoWinner(experiment) {
  const auto = experiment.autoWinner;
  if (!auto || auto.enabled !== true || !Number.isInteger(auto.afterVisits)) return;
  const visits = await db.ExperimentAssignment.count({ where: { experimentId: experiment.id } });
  if (visits < auto.afterVisits) return;
  const { variants } = await results(experiment);
  const score = (v) => (auto.metric === 'revenue_per_visit' ? Number(v.revenuePerVisitAmount) : v.conversionRateBp);
  const best = [...variants].sort((x, y) => score(y) - score(x) || y.visits - x.visits)[0];
  if (best) await chooseWinner(experiment.workspaceId, experiment.id, best.key, null);
}

/** What the product page shows this visitor, assigning them on first sight; null without a running test. */
async function forVisitor(workspaceId, productId, visitorId) {
  if (!visitorId) return null;
  const experiment = await db.Experiment.findOne({
    where: { workspaceId, subjectType: SUBJECT, subjectId: productId, status: 'running' },
    order: [['createdAt', 'DESC']],
  });
  if (!experiment) return null;
  const key = await assign(experiment, visitorId);
  const variant = (experiment.variants || []).find((v) => v.key === key);
  const data = (variant && variant.data) || {};
  return { id: experiment.id, variantKey: key, prices: data.prices || {}, media: data.media || null };
}

/** Whether the product has a running test (the product page then waits for the visitor's prices). */
async function hasRunningTest(workspaceId, productId) {
  const row = await db.Experiment.findOne({
    where: { workspaceId, subjectType: SUBJECT, subjectId: productId, status: 'running' },
    attributes: ['id'],
  });
  return Boolean(row);
}

/** variantId → the price this visitor was assigned, for the running tests among these variants. */
async function visitorPrices(workspaceId, variantIds, visitorId, transaction) {
  const prices = new Map();
  const ids = [...new Set((variantIds || []).filter(Boolean))];
  if (!visitorId || ids.length === 0) return prices;
  try {
    const running = await db.Experiment.findAll({
      where: { workspaceId, subjectType: SUBJECT, status: 'running' },
      attributes: ['id', 'subjectId', 'variants'],
      transaction,
    });
    if (running.length === 0) return prices;
    const variants = await db.ProductVariant.findAll({ where: { id: ids, workspaceId }, attributes: ['id', 'productId'], transaction });
    const products = new Set(variants.map((v) => v.productId));
    const mine = running.filter((e) => products.has(e.subjectId));
    if (mine.length === 0) return prices;
    const assignments = await db.ExperimentAssignment.findAll({
      where: { experimentId: mine.map((e) => e.id), visitorId },
      attributes: ['experimentId', 'variantKey'],
      transaction,
    });
    for (const a of assignments) {
      const experiment = mine.find((e) => e.id === a.experimentId);
      const variant = (experiment.variants || []).find((v) => v.key === a.variantKey);
      const set = (variant && variant.data && variant.data.prices) || {};
      for (const [variantId, amount] of Object.entries(set)) if (ids.includes(variantId)) prices.set(variantId, Number(amount));
    }
  } catch (err) {
    // A problem with a test never stops a sale: the product's own price applies.
    logger.warn('Product test prices could not be read', { error: err.message });
  }
  return prices;
}

/** The items with each plain variant line marked with this visitor's test price (read by priceLine). */
async function pinPrices(workspaceId, items, visitorId, transaction) {
  if (!visitorId || !Array.isArray(items) || items.length === 0) return items;
  // A combo's lines are priced by the combo (combos/comboPricing.js), never by a test.
  const plain = (item) => !item.offerId && !item[Symbol.for('zimos.combo')];
  const prices = await visitorPrices(workspaceId, items.filter(plain).map((i) => i.variantId), visitorId, transaction);
  if (prices.size === 0) return items;
  return items.map((item) => (plain(item) && prices.has(item.variantId) ? { ...item, [TEST_PRICE]: prices.get(item.variantId) } : item));
}

/** The test price pinPrices put on an item, or undefined. */
function testPriceOf(item) {
  return item ? item[TEST_PRICE] : undefined;
}

/** Credits an order to the visitor's variant in the running tests of the products it holds. */
async function recordOrder(workspaceId, productIds, visitorId, orderId, transaction) {
  if (!visitorId || !orderId || !productIds || productIds.length === 0) return;
  const experiments = await db.Experiment.findAll({
    where: { workspaceId, subjectType: SUBJECT, subjectId: [...new Set(productIds)], status: 'running' },
    attributes: ['id'],
    transaction,
  });
  if (experiments.length === 0) return;
  await db.ExperimentAssignment.update(
    { orderId },
    { where: { experimentId: experiments.map((e) => e.id), visitorId, orderId: null }, transaction }
  );
}

// --- routes ---------------------------------------------------------------

const uuid = Joi.string().uuid();
const amount = Joi.number().integer().min(0).max(1e12);
const mediaItem = Joi.object({
  url: Joi.string().trim().max(2000).required(),
  path: Joi.string().trim().max(2000).optional(),
  id: Joi.string().max(100).optional(),
  mimeType: Joi.string().max(100).optional(),
  size: Joi.number().integer().min(0).optional(),
}).unknown(true);
const variant = Joi.object({
  key: Joi.string().trim().uppercase().pattern(/^[A-Z]$/).required(),
  name: Joi.string().trim().max(80).allow('', null).optional(),
  weight: Joi.number().integer().min(0).max(100).required(),
  prices: Joi.object().pattern(uuid, amount).max(100).optional(),
  // Absent or null: the product's own pictures.
  media: Joi.array().items(mediaItem).min(1).max(20).allow(null).optional(),
});
const autoWinner = Joi.object({
  enabled: Joi.boolean().required(),
  afterVisits: Joi.number().integer().min(50).max(1000000).required(),
  metric: Joi.string().valid(...SPLIT_TEST_METRICS).required(),
});
const wsParams = Joi.object({ workspaceId: uuid.required() });
const params = Joi.object({ workspaceId: uuid.required(), testId: uuid.required() });
const schemas = {
  list: { params: wsParams, query: Joi.object({ productId: uuid.optional() }) },
  create: {
    params: wsParams,
    body: Joi.object({
      productId: uuid.required(),
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
      status: Joi.string().valid(...OPEN).optional(),
    }).min(1),
  },
  winner: { params, body: Joi.object({ variantKey: Joi.string().trim().uppercase().pattern(/^[A-Z]$/).required() }) },
  one: { params },
  public: { params: Joi.object({ workspaceId: uuid.required(), productId: uuid.required() }) },
};

// Mounted at /api/v1/workspaces/:workspaceId/product-tests.
const router = Router({ mergeParams: true });
const canView = requirePermission(PERMISSIONS.PRODUCTS_VIEW);
const canManage = requirePermission(PERMISSIONS.PRODUCTS_MANAGE);
router.use(authenticate, resolveTenant);
router.get(
  '/',
  canView,
  validate(schemas.list),
  asyncHandler(async (req, res) => res.json({ tests: await list(req.tenant.workspaceId, req.query) }))
);
router.post(
  '/',
  canManage,
  validate(schemas.create),
  asyncHandler(async (req, res) => res.status(201).json({ test: await create(req.tenant.workspaceId, req.body, req) }))
);
router.get(
  '/:testId',
  canView,
  validate(schemas.one),
  asyncHandler(async (req, res) => {
    const experiment = await load(req.tenant.workspaceId, req.params.testId);
    res.json({ test: present(experiment), results: await results(experiment) });
  })
);
router.patch(
  '/:testId',
  canManage,
  validate(schemas.update),
  asyncHandler(async (req, res) => res.json({ test: await update(req.tenant.workspaceId, req.params.testId, req.body, req) }))
);
router.post(
  '/:testId/winner',
  canManage,
  validate(schemas.winner),
  asyncHandler(async (req, res) =>
    res.json({ test: await chooseWinner(req.tenant.workspaceId, req.params.testId, req.body.variantKey, req) })
  )
);
router.delete(
  '/:testId',
  canManage,
  validate(schemas.one),
  asyncHandler(async (req, res) => res.json(await remove(req.tenant.workspaceId, req.params.testId, req)))
);

// Mounted on the public store router (/store/:workspaceId). Assigns, so never cached.
const publicRouter = Router({ mergeParams: true });
publicRouter.get(
  '/products/:productId/test',
  createIpMinuteLimiter('product-test', 120),
  validate(schemas.public),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ test: await forVisitor(req.tenant.workspaceId, req.params.productId, visitorOf(req)) });
  })
);

module.exports = {
  router,
  publicRouter,
  visitorOf,
  hasRunningTest,
  visitorPrices,
  pinPrices,
  testPriceOf,
  recordOrder,
};
