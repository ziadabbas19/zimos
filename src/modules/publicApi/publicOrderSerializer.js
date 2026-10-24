'use strict';

/**
 * The order as the public API and outbound webhooks show it.
 *
 * A deliberate, documented subset of what orderService returns — not the model
 * dumped as-is. An integration written against this shape must keep working
 * when a column is added, renamed or turned internal, so every field here is
 * picked by name and nothing internal (risk flags, payment tokens, idempotency
 * keys, carrier responses) rides along by accident.
 *
 * Money is an integer in the currency's minor unit, as stored: 12550 with
 * currency EGP is 125.50 EGP. Postgres BIGINTs arrive as strings and are
 * turned back into numbers here.
 */

const money = (value) => (value === null || value === undefined ? null : Number(value));

function serializeItem(item) {
  return {
    id: item.id,
    productId: item.productId,
    variantId: item.variantId,
    name: item.productNameSnapshot,
    variantOptions: item.variantOptionsSnapshot || null,
    sku: item.skuSnapshot || null,
    offerName: item.offerNameSnapshot || null,
    quantity: item.quantity,
    unitPrice: money(item.unitPriceAmount),
    lineDiscount: money(item.lineDiscountAmount),
    lineTotal: money(item.lineTotalAmount),
    isOrderBump: Boolean(item.isOrderBump),
    isUpsell: Boolean(item.isUpsell),
  };
}

function serializeShipment(shipment) {
  return {
    id: shipment.id,
    carrierCode: shipment.carrierCode,
    waybillNumber: shipment.waybillNumber || null,
    trackingCode: shipment.trackingCode || null,
    trackingUrl: shipment.trackingUrl || null,
    status: shipment.status,
    shippedAt: shipment.shippedAt || null,
    deliveredAt: shipment.deliveredAt || null,
    createdAt: shipment.createdAt,
    updatedAt: shipment.updatedAt,
  };
}

function serializeOrder(order) {
  const out = {
    id: order.id,
    orderNumber: order.orderNumber,
    stage: order.stage || null,
    confirmationState: order.confirmationState,
    financialState: order.financialState,
    fulfillmentState: order.fulfillmentState,
    paymentMethod: order.paymentMethod,
    currency: order.currency,
    amounts: {
      subtotal: money(order.subtotalAmount),
      discount: money(order.discountAmount),
      shipping: money(order.shippingAmount),
      tax: money(order.taxAmount),
      total: money(order.totalAmount),
      paid: money(order.amountPaid),
      refunded: money(order.amountRefunded),
    },
    contact: order.contactSnapshot || null,
    shippingAddress: order.shippingAddressSnapshot || null,
    notes: order.notes || null,
    items: (order.items || []).map(serializeItem),
    confirmedAt: order.confirmedAt || null,
    cancelledAt: order.cancelledAt || null,
    cancellationReason: order.cancellationReason || null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
  // The list endpoint doesn't load shipments; the single-order read and the
  // webhooks do. Absent means "not loaded here", never "none".
  if (Array.isArray(order.shipments)) out.shipments = order.shipments.map(serializeShipment);
  // A locked order (orders/orderLock): contact, address and notes come hidden.
  // Only the API reads one; a webhook never sends it.
  if (order.contactLocked) out.contactLocked = true;
  return out;
}

module.exports = { serializeOrder, serializeShipment, serializeItem };
