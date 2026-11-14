'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const db = require('../../db/models');
const cartSheet = require('./cartSheet');

/*
 * Staff, /api/v1/workspaces/:workspaceId/cart-sheet — the store's cart
 * behavior as the dashboard edits it (storefront/cartSheet.js staffView),
 * with the trust lines read from wherever they are now. Any member may read
 * it, as any member reads the store settings; it is written through the
 * store settings' PATCH /workspaces/:id (website.edit), `settings.cart_sheet`.
 */

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);
router.get(
  '/',
  validate({ params: Joi.object({ workspaceId: Joi.string().uuid().required() }) }),
  asyncHandler(async (req, res) => {
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'settings'] });
    res.json({ cartSheet: await cartSheet.staffView(workspace) });
  })
);

module.exports = router;
