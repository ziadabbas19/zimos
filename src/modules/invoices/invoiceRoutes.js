'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const orderLock = require('../orders/orderLock');

/** Customer invoices issued for orders (and their credit notes), newest first. */
const listInvoices = asyncHandler(async (req, res) => {
  const { limit, before } = req.query;
  const where = { workspaceId: req.tenant.workspaceId };
  if (before) where.issuedAt = { [Op.lt]: new Date(before) };

  const rows = await db.Invoice.findAll({
    where,
    order: [['issuedAt', 'DESC']],
    limit,
    include: [
      { model: db.Order, as: 'order', attributes: [...new Set([...orderLock.ORDER_ATTRIBUTES, 'orderNumber', 'contactSnapshot'])] },
      { model: db.CreditNote, as: 'creditNotes', required: false },
    ],
  });
  // A locked order's customer is not named (orders/orderLock).
  const lockCtx = await orderLock.contextFor(req.tenant.workspaceId);
  const locked = await orderLock.lockedIds(lockCtx, rows.map((i) => i.order).filter(Boolean));
  const customerName = (order) => {
    const name = (order.contactSnapshot || {}).fullName || null;
    return locked.has(order.id) && name ? orderLock.MASK : name;
  };

  res.json({
    invoices: rows.map((i) => ({
      id: i.id,
      invoiceNumber: i.invoiceNumber,
      issuedAt: i.issuedAt,
      currency: i.currency,
      totalAmount: Number(i.totalAmount),
      lineItems: i.lineItems,
      order: i.order ? { id: i.order.id, orderNumber: i.order.orderNumber, customerName: customerName(i.order), ...(lockCtx.enabled ? { contactLocked: locked.has(i.order.id) } : {}) } : null,
      creditNotes: (i.creditNotes || []).map((c) => ({ id: c.id, creditNoteNumber: c.creditNoteNumber, amount: Number(c.amount), reason: c.reason, issuedAt: c.issuedAt })),
    })),
    nextCursor: rows.length === limit ? rows[rows.length - 1].issuedAt.toISOString() : null,
  });
});

// Mounted at /api/v1/workspaces/:workspaceId/invoices
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.FINANCIAL_REPORTS_VIEW));
router.get(
  '/',
  validate({
    params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
    query: Joi.object({ limit: Joi.number().integer().min(1).max(100).default(50), before: Joi.date().iso().optional() }),
  }),
  listInvoices
);

module.exports = router;
