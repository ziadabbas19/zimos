'use strict';

const db = require('../../db/models');
const { QueryTypes } = require('sequelize');
const { normalizePhone } = require('../../core/utils/phone');
const { PERMISSIONS } = require('../../core/security/permissions');
const orderLock = require('../orders/orderLock');

/**
 * Global search (SPEC §18.6, ⌘K): a few of the best matches from each kind of
 * record, in one request. Each group is only searched when the member's role
 * may see it; settings pages and commands are matched in the dashboard itself.
 */

const PER_GROUP = 5;
const like = (text) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

// Locked orders (orders/orderLock): never found by their customer, and named
// without them when found by number.
async function searchOrders(workspaceId, term) {
  const lockCtx = await orderLock.contextFor(workspaceId);
  const visible = orderLock.visibleSql(lockCtx, 'o');
  const customerArm = (sql) => (visible === 'TRUE' ? sql : `(${sql} AND ${visible})`);
  const arms = ['zimos_normalize_search(o.order_number) LIKE zimos_normalize_search(:number)', customerArm("o.contact_snapshot->>'fullName' ILIKE :text")];
  const replacements = { workspaceId, number: like(term.replace(/^#/, '')), text: like(term), limit: PER_GROUP };
  const digits = term.replace(/\D/g, '');
  if (digits.length >= 4) {
    // Phones are matched on their last digits, so 010… and +2010… both find it.
    const tail = digits.length >= 10 ? (normalizePhone(term) || digits).slice(-10) : digits.replace(/^0+/, '');
    arms.push(customerArm("regexp_replace(coalesce(o.contact_snapshot->>'phone', ''), '[^0-9]', '', 'g') LIKE :phone"));
    replacements.phone = `%${tail}%`;
  }
  const rows = await db.sequelize.query(
    `SELECT o.id, o.order_number, o.total_amount, o.currency, o.created_at,
            o.contact_snapshot->>'fullName' AS customer_name, ${visible} AS visible
       FROM orders o
      WHERE o.workspace_id = :workspaceId AND (${arms.join(' OR ')})
      ORDER BY o.created_at DESC
      LIMIT :limit`,
    { replacements, type: QueryTypes.SELECT }
  );
  return rows.map((r) => ({
    id: r.id,
    orderNumber: r.order_number,
    customerName: r.visible ? r.customer_name : r.customer_name && orderLock.MASK,
    ...(lockCtx.enabled ? { contactLocked: !r.visible } : {}),
    totalAmount: String(r.total_amount),
    currency: r.currency,
    createdAt: r.created_at,
  }));
}

async function searchProducts(workspaceId, term) {
  const rows = await db.sequelize.query(
    `SELECT p.id, p.name, p.product_code, p.status, p.media
       FROM products p
      WHERE p.workspace_id = :workspaceId AND p.status <> 'archived'
        AND (p.name ILIKE :text OR p.product_code LIKE :code
             OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.sku ILIKE :text))
      ORDER BY (p.name ILIKE :prefix) DESC, p.updated_at DESC
      LIMIT :limit`,
    {
      replacements: { workspaceId, text: like(term), prefix: `${term.replace(/[\\%_]/g, '\\$&')}%`, code: `${term.replace(/\D/g, '') || '\u0000'}%`, limit: PER_GROUP },
      type: QueryTypes.SELECT,
    }
  );
  return rows.map((r) => {
    const first = Array.isArray(r.media) ? r.media[0] : null;
    return { id: r.id, name: r.name, productCode: r.product_code, status: r.status, imageUrl: (first && (first.url || first.src)) || null };
  });
}

async function searchCustomers(workspaceId, term) {
  const parts = ['c.full_name ILIKE :text', 'c.email ILIKE :text'];
  const replacements = { workspaceId, text: like(term), limit: PER_GROUP };
  const digits = term.replace(/\D/g, '');
  if (digits.length >= 3) {
    parts.push('c.phone_normalized LIKE :phone');
    replacements.phone = `%${digits.replace(/^0+/, '')}%`;
  }
  // A customer known only from locked orders is never found (orders/orderLock).
  const visible = orderLock.customerVisibleSql(await orderLock.contextFor(workspaceId), 'c');
  const rows = await db.sequelize.query(
    `SELECT c.id, c.full_name, c.phone_normalized, c.phone_raw, c.total_orders
       FROM customers c
      WHERE c.workspace_id = :workspaceId AND (${parts.join(' OR ')}) AND ${visible}
      ORDER BY c.total_orders DESC, c.created_at DESC
      LIMIT :limit`,
    { replacements, type: QueryTypes.SELECT }
  );
  return rows.map((r) => ({ id: r.id, fullName: r.full_name, phone: r.phone_raw || r.phone_normalized, totalOrders: r.total_orders }));
}

async function searchFunnels(workspaceId, term) {
  const rows = await db.Funnel.findAll({
    where: { workspaceId, name: { [db.Sequelize.Op.iLike]: like(term) } },
    attributes: ['id', 'name', 'status'],
    order: [['updatedAt', 'DESC']],
    limit: PER_GROUP,
  });
  return rows.map((f) => ({ id: f.id, name: f.name, status: f.status }));
}

async function search(tenant, q) {
  const term = String(q || '').trim();
  const empty = { orders: [], products: [], customers: [], funnels: [] };
  if (term.length < 2) return empty;
  const { workspaceId } = tenant;
  const when = (permission, run) => (tenant.hasPermission(permission) ? run(workspaceId, term) : Promise.resolve([]));

  const [orders, products, customers, funnels] = await Promise.all([
    when(PERMISSIONS.ORDERS_VIEW, searchOrders),
    when(PERMISSIONS.PRODUCTS_VIEW, searchProducts),
    when(PERMISSIONS.CUSTOMERS_VIEW, searchCustomers),
    when(PERMISSIONS.FUNNELS_MANAGE, searchFunnels),
  ]);
  return { orders, products, customers, funnels };
}

module.exports = { search };
