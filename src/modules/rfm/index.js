'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError } = require('../../core/errors/AppError');
const { STAGE_SQL, ORDERS_WITH_STAGE_FROM } = require('../orders/orderStage');
const { requireStoreFeature } = require('../../core/middleware/storeFeatures');

/*
 * RFM customer scores. From each customer's DELIVERED
 * orders (money really received, refunds taken off):
 *   R  recency   days since the last delivered order (fewer = better)
 *   F  frequency how many delivered orders
 *   M  money     what they spent
 * Each is scored 1–5 by quintile among the store's customers with at least
 * one delivered order (NTILE(5)), so the scores follow the store's own
 * customers. The usual labels follow from R and F/M (first match wins):
 *   champions        R≥4, F≥4, M≥4
 *   cant_lose        R≤2, F≥4, M≥4   (big buyers gone quiet)
 *   at_risk          R≤2, F≥3
 *   loyal            R≥3, F≥4
 *   new              R≥4, F=1
 *   potential        R≥4, F 2–3
 *   lost             R=1, F≤2
 *   hibernating      R≤2, F≤2
 *   need_attention   the rest
 * Worked out on request (no table); test orders are left out.
 */

const LABELS = ['champions', 'cant_lose', 'at_risk', 'loyal', 'new', 'potential', 'lost', 'hibernating', 'need_attention'];

const LABEL_SQL = `CASE
  WHEN r >= 4 AND f >= 4 AND m >= 4 THEN 'champions'
  WHEN r <= 2 AND f >= 4 AND m >= 4 THEN 'cant_lose'
  WHEN r <= 2 AND f >= 3 THEN 'at_risk'
  WHEN r >= 3 AND f >= 4 THEN 'loyal'
  WHEN r >= 4 AND orders = 1 THEN 'new'
  WHEN r >= 4 AND f BETWEEN 2 AND 3 THEN 'potential'
  WHEN r = 1 AND f <= 2 THEN 'lost'
  WHEN r <= 2 AND f <= 2 THEN 'hibernating'
  ELSE 'need_attention' END`;

// One row per customer with delivered orders: raw figures, scores and label.
const SCORED = `
  WITH delivered AS (
    SELECT x.customer_id, x.created_at, x.amount
      FROM (SELECT o.customer_id, o.created_at, (o.total_amount - o.amount_refunded) AS amount, ${STAGE_SQL} AS stage
              FROM ${ORDERS_WITH_STAGE_FROM}
             WHERE o.workspace_id = :ws AND o.is_test = false AND o.cancelled_at IS NULL) x
     WHERE x.stage = 'delivered'
  ), per AS (
    SELECT customer_id, MAX(created_at) AS last_at, COUNT(*)::int AS orders, SUM(amount)::bigint AS spent
      FROM delivered GROUP BY customer_id
  ), scored AS (
    SELECT per.*,
           NTILE(5) OVER (ORDER BY last_at ASC) AS r,
           NTILE(5) OVER (ORDER BY orders ASC, spent ASC) AS f,
           NTILE(5) OVER (ORDER BY spent ASC) AS m
      FROM per
  )
  SELECT scored.*, ${LABEL_SQL} AS label FROM scored`;

const row = (r) => ({
  customerId: r.customer_id,
  fullName: r.full_name,
  lastOrderAt: r.last_at,
  daysSinceLastOrder: Math.floor((Date.now() - new Date(r.last_at).getTime()) / 86400000),
  orders: r.orders,
  spent: String(r.spent),
  scores: { r: r.r, f: r.f, m: r.m },
  label: r.label,
});

// Mounted at /api/v1/workspaces/:workspaceId/rfm (customers.view).
const router = Router({ mergeParams: true });
router.use(requireStoreFeature('rfm'));
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.CUSTOMERS_VIEW));
const ws = { workspaceId: Joi.string().uuid().required() };

router.get('/', validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => {
  const rows = await db.sequelize.query(
    `SELECT label, COUNT(*)::int AS customers, SUM(spent)::bigint AS spent, ROUND(AVG(orders), 1)::float AS "avgOrders" FROM (${SCORED}) s GROUP BY label`,
    { replacements: { ws: req.tenant.workspaceId }, type: QueryTypes.SELECT }
  );
  const byLabel = new Map(rows.map((r) => [r.label, r]));
  const labels = LABELS.map((l) => ({ label: l, customers: byLabel.has(l) ? byLabel.get(l).customers : 0, spent: byLabel.has(l) ? String(byLabel.get(l).spent) : '0', avgOrders: byLabel.has(l) ? byLabel.get(l).avgOrders : 0 }));
  res.json({ total: labels.reduce((n, l) => n + l.customers, 0), labels, computedAt: new Date() });
}));

router.get(
  '/customers',
  validate({ params: Joi.object(ws), query: Joi.object({ label: Joi.string().valid(...LABELS), sort: Joi.string().valid('spent', 'recent', 'orders').default('spent'), limit: Joi.number().integer().min(1).max(200).default(50), offset: Joi.number().integer().min(0).default(0) }) }),
  asyncHandler(async (req, res) => {
    const order = { spent: 's.spent DESC', recent: 's.last_at DESC', orders: 's.orders DESC' }[req.query.sort];
    const replacements = { ws: req.tenant.workspaceId, label: req.query.label || null, limit: req.query.limit, offset: req.query.offset };
    const where = req.query.label ? 'WHERE s.label = :label' : '';
    const rows = await db.sequelize.query(
      `SELECT s.*, c.full_name FROM (${SCORED}) s JOIN customers c ON c.id = s.customer_id ${where} ORDER BY ${order}, s.customer_id LIMIT :limit OFFSET :offset`,
      { replacements, type: QueryTypes.SELECT }
    );
    const [{ total }] = await db.sequelize.query(`SELECT COUNT(*)::int AS total FROM (${SCORED}) s ${where}`, { replacements, type: QueryTypes.SELECT });
    // A customer known only from locked orders is not named (orders/orderLock).
    const orderLock = require('../orders/orderLock');
    const customers = await orderLock.presentCustomers(req.tenant.workspaceId, rows.map(row), {
      pick: (r) => r.customerId,
      mask: (r) => ({ ...r, fullName: r.fullName && orderLock.MASK, contactLocked: true }),
    });
    res.json({ customers, total });
  })
);

router.get('/customers/:customerId', validate({ params: Joi.object({ ...ws, customerId: Joi.string().uuid().required() }) }), asyncHandler(async (req, res) => {
  const c = await db.Customer.findOne({ where: { id: req.params.customerId, workspaceId: req.tenant.workspaceId }, attributes: ['id'] });
  if (!c) throw new NotFoundError('Customer');
  const [r] = await db.sequelize.query(`SELECT s.*, NULL AS full_name FROM (${SCORED}) s WHERE s.customer_id = :c`, { replacements: { ws: req.tenant.workspaceId, c: c.id }, type: QueryTypes.SELECT });
  res.json({ rfm: r ? row(r) : null });
}));

module.exports = { router, LABELS };
