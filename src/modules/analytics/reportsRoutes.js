'use strict';

const { Router } = require('express');
const Joi = require('joi');
const validate = require('../../core/middleware/validate');
const asyncHandler = require('express-async-handler');
const reports = require('./reportsService');

// Mounted by analyticsRoutes at /api/v1/workspaces/:workspaceId/analytics/reports,
// behind its authenticate → resolveTenant → requirePermission(ANALYTICS_VIEW).
const router = Router({ mergeParams: true });

const params = Joi.object({ workspaceId: Joi.string().uuid().required() });
const range = {
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
};
const schemas = {
  sales: {
    params,
    query: Joi.object({
      ...range,
      compare: Joi.string().valid('previous', 'year', 'none').optional(),
      unit: Joi.string().valid(...reports.UNITS).optional(),
    }),
  },
  list: { params, query: Joi.object({ ...range, limit: Joi.number().integer().min(1).max(200).optional() }) },
  plain: { params, query: Joi.object(range) },
  export: {
    params,
    query: Joi.object({ ...range, report: Joi.string().valid(...reports.EXPORT_REPORTS).required() }),
  },
};

const send = (key, load) =>
  asyncHandler(async (req, res) => {
    res.json({ [key]: await load(req.tenant.workspaceId, req.query) });
  });

router.get('/sales', validate(schemas.sales), send('report', reports.getSalesReport));
router.get('/products', validate(schemas.list), send('report', reports.getProductsReport));
router.get('/delivery', validate(schemas.plain), send('report', reports.getDeliveryReport));
router.get('/customers', validate(schemas.plain), send('report', reports.getCustomersReport));
router.get('/insights', validate(schemas.plain), send('insights', reports.getInsights));
router.get(
  '/export',
  validate(schemas.export),
  asyncHandler(async (req, res) => {
    const file = await reports.exportReport(req.tenant.workspaceId, req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.body);
  })
);

// The orders report and the products report (orderProductReports.js), while
// STORE_FEATURES names order_product_reports; otherwise 404 FEATURE_UNAVAILABLE.
// The order table names customers only to a teammate who may see orders.
const detailed = require('./orderProductReports');
const { requireStoreFeature } = require('../../core/middleware/storeFeatures');
const { PERMISSIONS } = require('../../core/security/permissions');

const gated = requireStoreFeature('order_product_reports');
const STAGE_KEYS = require('../orders/orderStage').STAGES;
const ordersQuery = Joi.object({
  ...range,
  compare: Joi.string().valid('previous', 'year', 'none').optional(),
  unit: Joi.string().valid(...reports.UNITS).optional(),
});
const tableQuery = Joi.object({
  ...range,
  status: Joi.string().valid(...STAGE_KEYS).optional(),
  // '' = orders with none (no governorate on the address, not shipped yet).
  governorate: Joi.string().trim().max(100).allow('').optional(),
  paymentMethod: Joi.string().trim().max(40).optional(),
  carrier: Joi.string().trim().max(60).allow('').optional(),
  cursor: Joi.string().max(200).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
});
const withCustomers = (req) => req.tenant.hasPermission(PERMISSIONS.ORDERS_VIEW);
const csv = (res, file) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.send(file.body);
};

router.get('/orders-overview', gated, validate({ params, query: ordersQuery }), send('report', detailed.getOrdersReport));
router.get(
  '/orders-overview/orders',
  gated,
  validate({ params, query: tableQuery }),
  asyncHandler(async (req, res) => res.json(await detailed.listOrders(req.tenant.workspaceId, req.query, { withCustomers: withCustomers(req) })))
);
router.get(
  '/orders-overview/export',
  gated,
  validate({ params, query: tableQuery }),
  asyncHandler(async (req, res) => csv(res, await detailed.exportOrders(req.tenant.workspaceId, req.query, { withCustomers: withCustomers(req) })))
);
router.get(
  '/products-overview',
  gated,
  validate({ params, query: Joi.object({ ...range, limit: Joi.number().integer().min(1).max(50).optional() }) }),
  send('report', detailed.getProductsReport)
);
router.get(
  '/products-overview/export',
  gated,
  validate({ params, query: Joi.object(range) }),
  asyncHandler(async (req, res) => csv(res, await detailed.exportProducts(req.tenant.workspaceId, req.query)))
);
router.get(
  '/products-overview/:productId/trend',
  gated,
  validate({ params: params.keys({ productId: Joi.string().uuid().required() }), query: Joi.object(range) }),
  asyncHandler(async (req, res) => res.json({ trend: await detailed.getProductTrend(req.tenant.workspaceId, req.params.productId, req.query) }))
);

module.exports = router;
