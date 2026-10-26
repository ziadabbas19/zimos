'use strict';

const env = require('../../config/env');

/**
 * Keeps a delivery's body under WEBHOOKS_MAX_PAYLOAD_BYTES (256 KB unless
 * set; 0 turns the cap off). An ordinary order is a few KB; the cap is for
 * the order with hundreds of lines or a very long note, which a receiver
 * behind a body-size limit (Zapier, Apps Script, a proxy) would refuse every
 * retry.
 *
 * An event over the cap is sent — and kept in the delivery log — with
 * `truncated: true` and its data reduced to ids: each object that has an id
 * becomes { id, orderNumber? }; if that is still too large, only the plain
 * values stay. The receiver reads the rest from the public API
 * (GET /api/v1/public/orders/:id). The envelope (id, type, createdAt,
 * workspaceId) is never cut, and neither is the event id: a retry is still
 * recognised as the same event.
 */

const sizeOf = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function idsOnly(data) {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && value.id) {
      out[key] = { id: value.id, ...(value.orderNumber ? { orderNumber: value.orderNumber } : {}) };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function scalarsOnly(data) {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = typeof value === 'string' ? value.slice(0, 200) : value;
    else if (value && typeof value === 'object' && value.id) out[key] = { id: value.id };
  }
  return out;
}

/** The payload as it is when small enough, else its reduced form. */
function capPayload(payload, max = env.webhooks.maxPayloadBytes) {
  if (!max || max <= 0) return payload;
  const bytes = sizeOf(payload);
  if (bytes <= max) return payload;
  const { data, ...envelope } = payload;
  const reduced = { ...envelope, truncated: true, originalBytes: bytes, data: idsOnly(data) };
  if (sizeOf(reduced) <= max) return reduced;
  return { ...envelope, truncated: true, originalBytes: bytes, data: scalarsOnly(data) };
}

module.exports = { capPayload };
