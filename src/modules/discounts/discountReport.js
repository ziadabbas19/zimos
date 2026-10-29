'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { scoped } = require('../../core/utils/scopedRepository');
const { PERMISSIONS } = require('../../core/security/permissions');
const { csvCell } = require('../../core/utils/csvCell');

/*
 * One coupon's results (GET /discounts/:id/report, and .csv): how many orders
 * used it, the discount it gave, the revenue of those orders (not cancelled
 * or rejected), how many customers, and who used it, newest first.
 *
 * The customer's name and phone show only to someone who may see customers
 * (customers.view), and are hidden on a locked order (orders/orderLock) like
 * everywhere else. Amounts are minor units.
 */

// Spreadsheets read the file as UTF-8 (Arabic names) only with a byte order mark.
const BOM = String.fromCharCode(0xfeff);

const orderState = (row) => {
  if (row.cancelled_at || row.confirmation_state === 'rejected') return 'cancelled';
  if (row.fulfillment_state === 'fulfilled') return 'delivered';
  if (row.fulfillment_state === 'returned') return 'returned';
  return 'open';
};

async function couponReport(workspaceId, discountId, { limit = 200 } = {}, req = null) {
  const discount = await scoped(db.Discount, workspaceId).findByPkOrThrow(discountId);
  const replacements = { workspaceId, discountId: discount.id, limit };
  const [summary] = await db.sequelize.query(
    `SELECT COUNT(*)::int AS uses,
            COALESCE(SUM(dr.amount_allocated), 0)::bigint AS discount_given,
            COALESCE(SUM(o.total_amount) FILTER (WHERE o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected'), 0)::bigint AS revenue,
            COUNT(*) FILTER (WHERE o.cancelled_at IS NOT NULL OR o.confirmation_state = 'rejected')::int AS cancelled,
            COUNT(DISTINCT dr.customer_id)::int AS customers
       FROM discount_redemptions dr JOIN orders o ON o.id = dr.order_id
      WHERE dr.workspace_id = :workspaceId AND dr.discount_id = :discountId`,
    { replacements, type: QueryTypes.SELECT }
  );
  const rows = await db.sequelize.query(
    `SELECT dr.order_id, dr.amount_allocated, dr.created_at, dr.customer_id,
            o.order_number, o.total_amount, o.currency, o.cancelled_at, o.confirmation_state, o.fulfillment_state,
            c.full_name, c.phone_raw, c.phone_normalized
       FROM discount_redemptions dr
       JOIN orders o ON o.id = dr.order_id
       LEFT JOIN customers c ON c.id = dr.customer_id
      WHERE dr.workspace_id = :workspaceId AND dr.discount_id = :discountId
      ORDER BY dr.created_at DESC, dr.id DESC
      LIMIT :limit`,
    { replacements, type: QueryTypes.SELECT }
  );

  const orderLock = require('../orders/orderLock');
  const ctx = await orderLock.contextFor(workspaceId);
  const orders = rows.length ? await db.Order.findAll({ where: { id: rows.map((r) => r.order_id), workspaceId }, attributes: orderLock.ORDER_ATTRIBUTES }) : [];
  const locked = await orderLock.lockedIds(ctx, orders);
  const seesContact = !req || !req.tenant || req.tenant.hasPermission(PERMISSIONS.CUSTOMERS_VIEW);

  return {
    discount: { id: discount.id, code: discount.code, type: discount.type, value: discount.value === null ? null : Number(discount.value), usageCount: discount.usageCount, usageLimit: discount.usageLimit },
    summary: {
      uses: summary.uses,
      discountGiven: Number(summary.discount_given),
      revenue: Number(summary.revenue),
      cancelled: summary.cancelled,
      customers: summary.customers,
    },
    uses: rows.map((row) => {
      const hidden = locked.has(row.order_id);
      const show = (value) => (hidden && value ? orderLock.MASK : value);
      return {
        orderId: row.order_id,
        orderNumber: row.order_number,
        usedAt: row.created_at,
        discountAmount: Number(row.amount_allocated),
        orderTotal: Number(row.total_amount),
        currency: row.currency,
        orderState: orderState(row),
        customerId: row.customer_id,
        customerName: show(row.full_name),
        customerPhone: seesContact ? show(row.phone_raw || row.phone_normalized) : null,
        contactLocked: hidden,
      };
    }),
  };
}

/** The same report as a CSV file staff open in a spreadsheet (every cell through csvCell). */
async function couponReportCsv(workspaceId, discountId, req) {
  const report = await couponReport(workspaceId, discountId, { limit: 1000 }, req);
  const header = ['order_number', 'used_at', 'customer', 'phone', 'discount', 'order_total', 'currency', 'order_state'];
  const lines = report.uses.map((use) =>
    [
      use.orderNumber,
      new Date(use.usedAt).toISOString(),
      use.customerName,
      use.customerPhone,
      (use.discountAmount / 100).toFixed(2),
      (use.orderTotal / 100).toFixed(2),
      use.currency,
      use.orderState,
    ]
      .map(csvCell)
      .join(',')
  );
  const name = String(report.discount.code || 'automatic').replace(/[^A-Za-z0-9_-]/g, '');
  return { filename: `coupon-${name || 'report'}.csv`, body: `${BOM}${[header.join(','), ...lines].join('\r\n')}\r\n` };
}

module.exports = { couponReport, couponReportCsv };
