'use strict';

const db = require('../../db/models');
const { maskPhone } = require('../../core/utils/phoneMask');
const { PERMISSIONS } = require('../../core/security/permissions');

/**
 * Who may see a store's customers in full through its webhooks. The rule is
 * the one the orders list, the export and API keys already follow:
 * customers.reveal_sensitive.
 *
 *   sent to an endpoint   in full only while the teammate who last set its
 *                         address (webhook_endpoints.configured_by_user_id,
 *                         migration 719) is an active member of the store
 *                         whose role holds customers.reveal_sensitive. An
 *                         endpoint with no known configurer, or one who lost
 *                         the permission or left, gets the masked form. An
 *                         address set through an API key without
 *                         customers:read has no configurer. Checked when the
 *                         row is written and again at every attempt
 *                         (webhookDispatcher.js): a stored row goes out
 *                         masked once its endpoint is.
 *   shown in the log      in full only to a viewer holding the permission.
 *
 * Masked: names (initials), phones (operator prefix and last digits), emails
 * (first letter and domain) and street addresses (country, governorate and
 * city kept, the rest hidden), at any depth of the payload. Order ids,
 * numbers, lines and amounts are untouched. Free text the customer typed
 * (order notes, custom-field answers) is not inspected.
 */

const PHONE_KEYS = new Set(['phone', 'alternatePhone', 'phoneNormalized', 'phoneRaw', 'phoneE164', 'customerPhone']);
const NAME_KEYS = new Set(['fullName', 'firstName', 'lastName', 'customerName', 'recipientName']);
const EMAIL_KEYS = new Set(['email', 'customerEmail']);
const ADDRESS_KEYS = new Set(['shippingAddress', 'billingAddress', 'shippingAddressSnapshot', 'address', 'savedAddresses']);
const ADDRESS_KEEP = new Set(['country', 'province', 'region', 'governorate', 'city', 'zone', 'id', 'label', 'isDefault']);
const HIDDEN = '••••';

const maskName = (name) =>
  String(name)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${[...word][0]}***`)
    .join(' ');

function maskEmail(email) {
  const text = String(email);
  const at = text.lastIndexOf('@');
  if (at < 1) return HIDDEN;
  return `${[...text][0]}***${text.slice(at)}`;
}

function maskAddress(address) {
  if (Array.isArray(address)) return address.map(maskAddress);
  if (!address || typeof address !== 'object') return address === null || address === undefined ? address : HIDDEN;
  const out = {};
  for (const [key, value] of Object.entries(address)) {
    if (ADDRESS_KEEP.has(key) || value === null || value === undefined || value === '') out[key] = value;
    else if (typeof value === 'object') out[key] = maskCustomerData(value);
    else out[key] = HIDDEN;
  }
  return out;
}

/** A copy of `value` with every customer name, phone, email and street address masked, at any depth. */
function maskCustomerData(value) {
  if (Array.isArray(value)) return value.map(maskCustomerData);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const plain = typeof value.toJSON === 'function' ? value.toJSON() : value;
  if (!plain || typeof plain !== 'object' || plain instanceof Date) return plain;
  const out = {};
  for (const [key, inner] of Object.entries(plain)) {
    const text = typeof inner === 'string' || typeof inner === 'number';
    if (PHONE_KEYS.has(key) && text) out[key] = maskPhone(inner);
    else if (NAME_KEYS.has(key) && typeof inner === 'string' && inner) out[key] = maskName(inner);
    else if (EMAIL_KEYS.has(key) && typeof inner === 'string' && inner) out[key] = maskEmail(inner);
    else if (ADDRESS_KEYS.has(key) && inner && typeof inner === 'object') out[key] = maskAddress(inner);
    else out[key] = maskCustomerData(inner);
  }
  return out;
}

const roleReveals = (role) => {
  const permissions = (role && role.permissions) || [];
  return permissions.includes('*') || permissions.includes(PERMISSIONS.CUSTOMERS_REVEAL_SENSITIVE);
};

/**
 * endpointId → whether its deliveries may carry customers in full, for
 * endpoints of one store (see the rule above). One query for all of them.
 */
async function revealsByEndpoint(workspaceId, endpoints) {
  const userIds = [...new Set(endpoints.map((e) => e.configuredByUserId).filter(Boolean))];
  const allowed = new Set();
  if (userIds.length > 0) {
    const memberships = await db.Membership.findAll({
      where: { workspaceId, userId: userIds, status: 'active' },
      include: [
        { model: db.Role, as: 'role', attributes: ['permissions'] },
        { model: db.User, as: 'user', attributes: ['id', 'status'], required: true, where: { status: 'active' } },
      ],
    });
    for (const m of memberships) if (roleReveals(m.role)) allowed.add(m.userId);
  }
  return new Map(endpoints.map((e) => [e.id, Boolean(e.configuredByUserId) && allowed.has(e.configuredByUserId)]));
}

/** The payload an endpoint is sent: as it is, or masked. */
const forEndpoint = (payload, reveals) => (reveals ? payload : maskCustomerData(payload));

/** Whether the teammate behind this request sees customers in full (dashboard or API key). */
const viewerReveals = (req) => Boolean(req && req.tenant && req.tenant.hasPermission(PERMISSIONS.CUSTOMERS_REVEAL_SENSITIVE));

/**
 * The configurer an endpoint is saved with when this request sets its
 * address: the teammate behind it — or nobody when it comes through an API
 * key that may not read customers in full itself (no customers:read), so the
 * endpoint is sent them masked, as that key reads them.
 */
const configurerFor = (req) => (req.apiKey && !viewerReveals(req) ? null : req.user.id);

module.exports = { maskCustomerData, revealsByEndpoint, forEndpoint, viewerReveals, configurerFor };
