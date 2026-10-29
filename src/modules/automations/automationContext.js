'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');

/**
 * What an automation knows about its subject: the order (or lost checkout),
 * the variables a message may use, and whether a rule's conditions hold.
 */

const TOKENS = [
  'customer_name',
  'order_number',
  'order_total',
  'cart_total',
  'store_name',
  'tracking_url',
  'city',
  'product_names',
  'product_name',
  'items_count',
  'shipping_amount',
  'carrier_name',
  'waybill_number',
  'order_link',
  'recovery_link',
  'coupon_code',
  'review_link',
];

function formatAmount(amountMinor, currency) {
  const major = Number(amountMinor || 0) / 100;
  return `${major.toLocaleString('en-US', { minimumFractionDigits: major % 1 ? 2 : 0, maximumFractionDigits: 2 })} ${currency || ''}`.trim();
}

/** Replaces {{token}} placeholders. Unknown tokens become empty. */
function render(value, ctx) {
  return String(value).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, token) => (ctx[token] !== undefined && ctx[token] !== null ? String(ctx[token]) : ''));
}

// The store's canonical address: its primary domain when it has one (domains/primaryHost.js).
const storeBase = (workspace) => require('../domains/primaryHost').storeOriginOf(workspace && workspace.slug ? workspace : null);

/** Everything a step needs about an order. Null when the order is gone. */
async function loadOrderSubject(workspaceId, orderId) {
  const order = await db.Order.findOne({
    where: { id: orderId, workspaceId },
    include: [
      { model: db.Shipment, as: 'shipments', required: false },
      { model: db.OrderItem, as: 'items', required: false },
    ],
  });
  if (!order) return null;
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'name', 'slug'] });
  const contact = order.contactSnapshot || {};
  const address = order.shippingAddressSnapshot || {};
  const shipments = (order.shipments || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const shipment = shipments[0] || null;
  const items = order.items || [];
  const base = await storeBase(workspace);

  let reviewLink = '';
  const productId = items.map((i) => i.productId).find(Boolean);
  if (productId && base) {
    const product = await db.Product.findOne({ where: { id: productId, workspaceId }, attributes: ['slug'] });
    // `review` carries the order's signed token, so the review is linked to this order (modules/reviews).
    if (product && product.slug) reviewLink = `${base}/products/${product.slug}?review=${require('../storefront/orderTrackingExtras').tokenFor(order)}#reviews`;
  }

  return {
    kind: 'order',
    order,
    workspace,
    phone: contact.phone || null,
    email: contact.email || null,
    vars: {
      customer_name: contact.fullName || '',
      order_number: order.orderNumber,
      order_total: formatAmount(order.totalAmount, order.currency),
      cart_total: formatAmount(order.totalAmount, order.currency),
      store_name: workspace ? workspace.name : '',
      tracking_url: shipment && shipment.trackingUrl ? shipment.trackingUrl : '',
      city: address.city || '',
      // A line sold with menu options names them: "برجر (الحجم: كبير · إضافات: جبنة)" (catalog/menuOptions.js).
      product_names: [
        ...new Set(
          items
            .map((i) => {
              const options = require('../catalog/menuOptions').optionsLabel(i.optionsSnapshot);
              return i.productNameSnapshot && options ? `${i.productNameSnapshot} (${options})` : i.productNameSnapshot;
            })
            .filter(Boolean)
        ),
      ].join('، '),
      product_name: (items.find((i) => i.productNameSnapshot) || {}).productNameSnapshot || '',
      items_count: items.reduce((sum, i) => sum + (i.quantity || 0), 0),
      shipping_amount: formatAmount(order.shippingAmount, order.currency),
      carrier_name: shipment ? shipment.carrierCode : '',
      waybill_number: shipment && shipment.waybillNumber ? shipment.waybillNumber : '',
      // The signed tracking link: opens the order without asking for the phone number.
      order_link: base ? `${base}/track?t=${require('../storefront/orderTrackingExtras').tokenFor(order)}` : '',
      recovery_link: '',
      review_link: reviewLink,
    },
    // What "the order moved on" is measured against.
    signature: [order.confirmationState, order.fulfillmentState, order.financialState, order.cancelledAt ? 'cancelled' : 'open'].join('|'),
  };
}

/** A lost checkout (checkout.abandoned / lost_order.created). */
async function loadCheckoutSubject(workspaceId, checkoutSessionId) {
  const session = await db.CheckoutSession.findOne({ where: { id: checkoutSessionId, workspaceId } });
  if (!session) return null;
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'name', 'slug'] });
  const contact = session.contactFields || {};
  const base = await storeBase(workspace);
  // Without a recovery token the link is the store's checkout.
  const token = session.recoveryToken || null;
  const sessionItems = Array.isArray(session.items) ? session.items : [];
  return {
    kind: 'checkout',
    session,
    workspace,
    phone: contact.phone || session.phoneNormalized || null,
    email: contact.email || null,
    vars: {
      customer_name: contact.fullName || '',
      order_number: '',
      order_total: formatAmount(session.subtotalAmount, session.currency),
      cart_total: formatAmount(session.subtotalAmount, session.currency),
      store_name: workspace ? workspace.name : '',
      tracking_url: '',
      city: contact.city || '',
      product_names: [...new Set(sessionItems.map((i) => i.productName).filter(Boolean))].join('، '),
      product_name: (sessionItems.find((i) => i.productName) || {}).productName || '',
      items_count: sessionItems.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0),
      shipping_amount: '',
      carrier_name: '',
      waybill_number: '',
      order_link: '',
      recovery_link: base ? (token ? `${base}/r/${token}` : `${base}/checkout`) : '',
      review_link: '',
    },
    // "Contacted" (the sequence's own first message, recoveryContacted.js) is still open; a merchant's recovered/lost is not.
    signature: [session.status, session.recoveryStatus === 'contacted' ? 'not_contacted' : session.recoveryStatus, session.convertedOrderId ? 'converted' : 'open'].join('|'),
  };
}

const EMPTY_ORDER_VARS = {
  order_number: '',
  order_total: '',
  cart_total: '',
  tracking_url: '',
  city: '',
  product_names: '',
  product_name: '',
  items_count: '',
  shipping_amount: '',
  carrier_name: '',
  waybill_number: '',
  order_link: '',
  recovery_link: '',
  review_link: '',
};

/** A customer with no order in hand (lead.created). */
async function loadCustomerSubject(workspaceId, customerId) {
  const customer = await db.Customer.findOne({ where: { id: customerId, workspaceId } });
  if (!customer) return null;
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'name', 'slug'] });
  return {
    kind: 'customer',
    customer,
    workspace,
    phone: customer.phoneRaw || customer.phoneNormalized || null,
    email: customer.email || null,
    vars: { ...EMPTY_ORDER_VARS, customer_name: customer.fullName || '', store_name: workspace ? workspace.name : '' },
    // Nothing for a wait to watch: a lead's sequence runs to its end.
    signature: 'customer',
  };
}

const asList = (value) => (Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value]);

/** Null when the rule applies; otherwise the reason it was skipped. */
async function conditionsFail(conditions, subject) {
  const c = conditions && !Array.isArray(conditions) ? conditions : {};
  // In / not in a segment: for any subject that names a contact (segmentCondition.js).
  const workspaceId = (subject.workspace && subject.workspace.id) || (subject.order && subject.order.workspaceId);
  const segment = await require('./segmentCondition').segmentFails(c, subject, workspaceId);
  if (segment) return segment;
  // A checkout, a lead or a subscription answers the same conditions from what it has (subjectConditions.js).
  if (subject.kind !== 'order') return require('./subjectConditions').fails(c, subject);
  const { order } = subject;

  if (c.paymentMethod && order.paymentMethod !== c.paymentMethod) return `payment method is ${order.paymentMethod}`;
  if (c.minTotalAmount !== undefined && c.minTotalAmount !== null && Number(order.totalAmount) < Number(c.minTotalAmount)) return 'order total below the minimum';

  const productIds = asList(c.productIds);
  if (productIds.length && !(order.items || []).some((i) => productIds.includes(i.productId))) return 'none of the chosen products is in the order';

  const governorates = asList(c.governorates).map((g) => String(g).trim().toLowerCase());
  if (governorates.length) {
    const address = order.shippingAddressSnapshot || {};
    const place = [address.province, address.city].filter(Boolean).map((v) => String(v).trim().toLowerCase());
    if (!place.some((p) => governorates.includes(p))) return 'governorate is not in the list';
  }

  if (c.source === 'funnel' && !order.funnelId) return 'order did not come from a funnel';
  if (c.source === 'store' && order.funnelId) return 'order came from a funnel';

  const funnelIds = asList(c.funnelIds);
  if (funnelIds.length && !funnelIds.includes(order.funnelId)) return 'order is not from one of the chosen funnels';

  // A rule saved with "medium" (the dashboard's old name) means "moderate", the level orders carry.
  const riskLevels = asList(c.riskLevel).map((level) => (level === 'medium' ? 'moderate' : level));
  if (riskLevels.length && !riskLevels.includes(order.riskLevel || 'low')) return `risk level is ${order.riskLevel || 'low'}`;

  const tags = asList(c.tags).map((t) => String(t).toLowerCase());
  if (tags.length) {
    const has = (order.tags || []).map((t) => String(t).toLowerCase());
    if (!tags.some((t) => has.includes(t))) return 'order has none of the tags';
  }

  if (typeof c.isFirstOrder === 'boolean' && order.customerId) {
    const earlier = await db.Order.count({
      where: { workspaceId: order.workspaceId, customerId: order.customerId, id: { [Op.ne]: order.id }, createdAt: { [Op.lt]: order.createdAt } },
    });
    if (c.isFirstOrder && earlier > 0) return 'not the customer\'s first order';
    if (!c.isFirstOrder && earlier === 0) return 'the customer\'s first order';
  }
  return null;
}

module.exports = { TOKENS, render, formatAmount, loadOrderSubject, loadCheckoutSubject, loadCustomerSubject, conditionsFail };
