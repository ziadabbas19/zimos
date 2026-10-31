'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { productQuestionLimiter } = require('../../core/middleware/rateLimiters');
const { clientIp } = require('../../core/middleware/clientIp');
const { requireStoreFeature } = require('../../core/middleware/storeFeatures');

/*
 * Product questions and answers.
 *
 * - A shopper asks on the product page (name optional, email optional and
 *   private). Every question waits for the store: nothing a shopper writes is
 *   shown before the merchant answers and publishes it (or the merchant hides
 *   it). At most 5 questions an hour from one address.
 * - The team (products.manage) gets a `product.question` notification.
 * - Answering publishes by default; the asker who left an email is told once
 *   (a reply to their own question, not marketing).
 * - The product page lists published questions with their answers, newest
 *   first; the asker's email never leaves the dashboard.
 */

const MAX_PER_IP_HOUR = 5;

const publicView = (q) => ({ id: q.id, question: q.question, askerName: q.askerName || null, answer: q.answer, answeredAt: q.answeredAt, createdAt: q.createdAt });
const staffView = (q) => ({ ...publicView(q), productId: q.productId, productName: q.product ? q.product.name : undefined, askerEmail: q.askerEmail, status: q.status, locale: q.locale, answeredBy: q.answeredBy });

async function ask(workspace, productId, body, ip) {
  const product = await db.Product.findOne({ where: { id: productId, workspaceId: workspace.id, status: 'active' }, attributes: ['id', 'name'] });
  if (!product) throw new NotFoundError('Product');
  if (ip && (await db.ProductQuestion.count({ where: { requestIp: ip, createdAt: { [Op.gt]: new Date(Date.now() - 3600e3) } } })) >= MAX_PER_IP_HOUR) {
    throw new AppError('TOO_MANY_REQUESTS', 'Too many questions — try again later', 429);
  }
  const q = await db.ProductQuestion.create({ workspaceId: workspace.id, productId, question: body.question, askerName: body.name || null, askerEmail: body.email ? body.email.toLowerCase() : null, locale: body.locale || null, requestIp: ip || null });
  await require('../notifications/merchantNotificationService').create(workspace.id, {
    type: 'product.question',
    title: `سؤال جديد على ${product.name}`,
    body: body.question.slice(0, 200),
    link: `/products/${product.id}?tab=questions`,
    data: { questionId: q.id, productId: product.id, productName: product.name },
    dedupeKey: `question:${q.id}`,
  });
  return { received: true, status: 'pending' };
}

async function answer(workspaceId, id, body, req) {
  const q = await db.ProductQuestion.findOne({ where: { id, workspaceId }, include: [{ model: db.Product, as: 'product', attributes: ['id', 'name', 'slug'] }] });
  if (!q) throw new NotFoundError('Question');
  const firstAnswer = !q.answer && body.answer;
  const next = {
    ...(body.answer !== undefined ? { answer: body.answer || null, answeredBy: req.user.id, answeredAt: body.answer ? q.answeredAt || new Date() : null } : {}),
    ...(body.status ? { status: body.status } : body.answer ? { status: 'published' } : {}),
  };
  if ((next.status || q.status) === 'published' && !(next.answer !== undefined ? next.answer : q.answer)) {
    throw new AppError('ANSWER_REQUIRED', 'Answer the question before publishing it', 422, [{ field: 'answer', message: 'Required to publish' }]);
  }
  await q.update(next);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'product_question.answer', entityType: 'ProductQuestion', entityId: q.id, after: { status: q.status }, req });
  if (firstAnswer && q.askerEmail && q.status === 'published') {
    try {
      const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'name', 'slug', 'defaultLocale'] });
      const origin = await require('../domains/primaryHost').storeOriginOf(workspace);
      await require('../notifications/notify').email({
        recipient: q.askerEmail,
        template: 'question_answered',
        workspaceId,
        data: { productName: q.product.name, storeName: workspace.name, question: q.question, answer: q.answer, url: `${origin}/products/${encodeURIComponent(q.product.slug || q.product.id)}`, locale: (q.locale || workspace.defaultLocale) === 'en' ? 'en' : 'ar' },
      });
    } catch (err) {
      logger.warn(`[productQuestions] answer email ${q.id}: ${err.message}`);
    }
  }
  return staffView(q);
}

// ----------------------------------------------------------------- routes --

// Mounted at /api/v1/store/:workspaceId/products/:productId/questions.
const store = Router({ mergeParams: true });
store.use(requireStoreFeature('product_questions'));
const sp = Joi.object({ workspaceId: Joi.string().required(), productId: Joi.string().uuid().required() });
store.get('/', resolvePublicWorkspace, validate({ params: sp, query: Joi.object({ limit: Joi.number().integer().min(1).max(50).default(20), offset: Joi.number().integer().min(0).max(10000).default(0) }) }), asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=120');
  const { rows, count } = await db.ProductQuestion.findAndCountAll({ where: { workspaceId: req.publicWorkspace.id, productId: req.params.productId, status: 'published' }, order: [['answeredAt', 'DESC']], limit: req.query.limit, offset: req.query.offset });
  res.json({ questions: rows.map(publicView), total: count });
}));
store.post(
  '/',
  productQuestionLimiter,
  resolvePublicWorkspace,
  validate({ params: sp, body: Joi.object({ question: Joi.string().trim().min(5).max(1000).required(), name: Joi.string().trim().max(120).allow('', null), email: Joi.string().trim().email().max(255).allow('', null), locale: Joi.string().valid('ar', 'en', 'fr') }) }),
  asyncHandler(async (req, res) => res.status(201).json(await ask(req.publicWorkspace, req.params.productId, req.body, clientIp(req))))
);

// Mounted at /api/v1/workspaces/:workspaceId/product-questions.
const staff = Router({ mergeParams: true });
staff.use(requireStoreFeature('product_questions'));
staff.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const one = Joi.object({ ...ws, questionId: Joi.string().uuid().required() });
staff.get('/', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params: Joi.object(ws), query: Joi.object({ status: Joi.string().valid('pending', 'published', 'hidden'), productId: Joi.string().uuid(), limit: Joi.number().integer().min(1).max(200).default(50), offset: Joi.number().integer().min(0).default(0) }) }), asyncHandler(async (req, res) => {
  const where = { workspaceId: req.tenant.workspaceId, ...(req.query.status ? { status: req.query.status } : {}), ...(req.query.productId ? { productId: req.query.productId } : {}) };
  const { rows, count } = await db.ProductQuestion.findAndCountAll({ where, include: [{ model: db.Product, as: 'product', attributes: ['id', 'name'] }], order: [['createdAt', 'DESC']], limit: req.query.limit, offset: req.query.offset });
  const pending = await db.ProductQuestion.count({ where: { workspaceId: req.tenant.workspaceId, status: 'pending' } });
  res.json({ questions: rows.map(staffView), total: count, pending });
}));
staff.patch(
  '/:questionId',
  requirePermission(PERMISSIONS.PRODUCTS_MANAGE),
  validate({ params: one, body: Joi.object({ answer: Joi.string().trim().max(3000).allow('', null), status: Joi.string().valid('pending', 'published', 'hidden') }).min(1) }),
  asyncHandler(async (req, res) => res.json(await answer(req.tenant.workspaceId, req.params.questionId, req.body, req)))
);
staff.delete('/:questionId', requirePermission(PERMISSIONS.PRODUCTS_MANAGE), validate({ params: one }), asyncHandler(async (req, res) => {
  const n = await db.ProductQuestion.destroy({ where: { id: req.params.questionId, workspaceId: req.tenant.workspaceId } });
  if (!n) throw new NotFoundError('Question');
  // Not audited: an answered question leaves the product page (storefrontCache.js, the edge included).
  require('../storefront/storefrontCache').invalidate(req.tenant.workspaceId);
  res.status(204).end();
}));

module.exports = { store, staff };
