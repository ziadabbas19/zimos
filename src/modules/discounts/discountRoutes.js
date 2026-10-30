'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./discountController');
const schemas = require('./discountValidation');
// The plan's advanced_coupons with GROWTH_REQUIRE_PLAN_FEATURE (advancedCoupons.js).
const { controlsGate, reportGate } = require('./advancedCoupons');

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.DISCOUNTS_MANAGE));

router.post('/', validate(schemas.create), controlsGate, controller.create);
// N random codes sharing one set of rules (couponExtras.js).
router.post(
  '/bulk',
  validate(require('./couponExtras').schemas.bulk),
  controlsGate,
  require('express-async-handler')(async (req, res) =>
    res.status(201).json(await require('./couponExtras').bulkGenerate(req.tenant.workspaceId, req.body, req))
  )
);
router.get('/', validate(schemas.list), controller.list);
router.get('/:discountId', validate(schemas.get), controller.get);
// One coupon's results: uses, discount given, revenue, who used it (discountReport.js), and as a CSV file.
router.get(
  '/:discountId/report',
  validate(schemas.report),
  reportGate,
  require('express-async-handler')(async (req, res) =>
    res.json({ report: await require('./discountReport').couponReport(req.tenant.workspaceId, req.params.discountId, req.query, req) })
  )
);
router.get(
  '/:discountId/report.csv',
  validate(schemas.get),
  reportGate,
  require('express-async-handler')(async (req, res) => {
    const file = await require('./discountReport').couponReportCsv(req.tenant.workspaceId, req.params.discountId, req);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.body);
  })
);
router.patch('/:discountId/status', validate(schemas.setStatus), controller.setStatus);
router.patch('/:discountId', validate(schemas.update), controlsGate, controller.update);
router.delete('/:discountId', validate(schemas.remove), controller.remove);

module.exports = router;
