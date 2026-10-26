'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const { ipv6Prefix, inPrefix } = require('./ipPrefix');

/**
 * Merchant-configured fraud rules for storefront orders.
 *
 * Stored under `workspaces.settings.fraud_rules` (PATCH /workspaces/:id, same
 * merge semantics as checkout_settings). Every rule is off until the merchant
 * sets it, so a workspace that never touched this setting places orders
 * exactly as it did before the rules existed.
 *
 * A rule is stored either as its bare value (the older shape) or as
 * `{ value, action }`; a rule without its own action uses the store-wide
 * `action`. resolveFraudRules reads both.
 *
 *   action                                  default action: 'flag' (default), 'block', 'require_otp', 'to_lost'
 *   block_blacklisted                       refuse blacklisted customers and blocked entries, whatever the actions say
 *   duplicate_window_minutes                same customer + any same variant within N minutes
 *   max_orders_per_phone_per_day            customer already has N orders in the last 24h
 *   high_rejection_threshold                customer.totalRejectedOrders >= N
 *   max_items_per_order                     more than N units of one product (0 or null = unlimited)
 *   min_minutes_between_cod_orders_per_ip   a COD order from the same IP less than N minutes ago
 *   block_outside_country                   the IP's country is not in allowed_countries
 *   allowed_countries                       ISO2 list; empty = the store's own country
 *   block_vpn                               the IP is a VPN or a hosting provider
 *   min_network_delivery_rate               the customer's platform-wide delivery rate (%) is below N
 *   high_risk                               the order's risk level is `high` (action only)
 *   phone_validation                        'strict' refuses a phone that is not a mobile of the store's country
 *
 * What an action does when its rule fires:
 *
 *   flag         the order is placed and carries the rule's risk flag
 *   block        the order is refused
 *   to_lost      the order is refused and kept as a lost order the merchant can recover
 *   require_otp  the order needs a verified phone first (checkout OTP)
 *
 * Only storefront orders are evaluated — see orderService.createOrder for
 * the scoping and for the follow-on exemption.
 */

const FRAUD_ACTIONS = ['flag', 'block', 'require_otp', 'to_lost'];
const PHONE_VALIDATION_MODES = ['strict', 'off'];

// Rules that take an action, with the risk flag each puts on the order and
// the reason a refused order is filed under in Lost orders.
const RULES = Object.freeze({
  duplicate_window_minutes: { flag: 'duplicate_order', lostReason: 'limit_exceeded' },
  max_orders_per_phone_per_day: { flag: 'phone_daily_limit', lostReason: 'limit_exceeded' },
  high_rejection_threshold: { flag: 'high_rejection_customer', lostReason: 'limit_exceeded' },
  max_items_per_order: { flag: 'max_items_exceeded', lostReason: 'limit_exceeded' },
  min_minutes_between_cod_orders_per_ip: { flag: 'ip_order_rate', lostReason: 'limit_exceeded' },
  block_outside_country: { flag: 'outside_country', lostReason: 'outside_country' },
  block_vpn: { flag: 'vpn_ip', lostReason: 'vpn' },
  min_network_delivery_rate: { flag: 'low_delivery_rate', lostReason: 'limit_exceeded' },
  high_risk: { flag: 'high_risk', lostReason: 'limit_exceeded' },
});
const RULE_KEYS = Object.keys(RULES);

const FLAGS = Object.freeze({
  DUPLICATE_ORDER: 'duplicate_order',
  PHONE_DAILY_LIMIT: 'phone_daily_limit',
  HIGH_REJECTION_CUSTOMER: 'high_rejection_customer',
  MAX_ITEMS_EXCEEDED: 'max_items_exceeded',
  IP_ORDER_RATE: 'ip_order_rate',
  OUTSIDE_COUNTRY: 'outside_country',
  VPN_IP: 'vpn_ip',
  LOW_DELIVERY_RATE: 'low_delivery_rate',
  HIGH_RISK: 'high_risk',
});

// Buyer-facing. Deliberately says nothing about which check failed, or that a
// check exists at all: naming the rule tells whoever is probing the store
// exactly what to change on the next attempt.
const REJECTION_MESSAGE = 'We could not place this order. Please contact the store for help.';

// "Not cancelled" as the orders screen means it — the `cancelled` arm of
// orderStage.STAGE_SQL. An order the COD call rejected is as dead as one the
// merchant cancelled, and counting it would let one refused order hold a
// genuine buyer's retry against them.
const NOT_CANCELLED_SQL = "o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected'";

function isRuleObject(stored) {
  return stored !== null && typeof stored === 'object' && !Array.isArray(stored);
}

/**
 * The effective rules for a workspace settings blob: stored values over the
 * defaults. Each rule's value sits under its key (as it always did) and its
 * action under `actions[key]`.
 */
function resolveFraudRules(settings) {
  const stored = (settings && settings.fraud_rules) || {};
  const action = FRAUD_ACTIONS.includes(stored.action) ? stored.action : 'flag';
  const valueOf = (key) => {
    const raw = isRuleObject(stored[key]) ? stored[key].value : stored[key];
    return raw === undefined ? null : raw;
  };
  const actions = {};
  for (const key of RULE_KEYS) {
    const own = isRuleObject(stored[key]) ? stored[key].action : null;
    actions[key] = FRAUD_ACTIONS.includes(own) ? own : action;
  }
  const allowed = stored.allowed_countries;
  return {
    action,
    actions,
    block_blacklisted: stored.block_blacklisted === true,
    duplicate_window_minutes: valueOf('duplicate_window_minutes'),
    max_orders_per_phone_per_day: valueOf('max_orders_per_phone_per_day'),
    high_rejection_threshold: valueOf('high_rejection_threshold'),
    max_items_per_order: valueOf('max_items_per_order') || null,
    min_minutes_between_cod_orders_per_ip: valueOf('min_minutes_between_cod_orders_per_ip') || null,
    block_outside_country: valueOf('block_outside_country') === true,
    allowed_countries: Array.isArray(allowed) ? allowed.map((c) => String(c).toUpperCase()) : [],
    block_vpn: valueOf('block_vpn') === true,
    min_network_delivery_rate: valueOf('min_network_delivery_rate'),
    high_risk: valueOf('high_risk') === true,
    phone_validation: stored.phone_validation === 'strict' ? 'strict' : 'off',
  };
}

/** The rule key a risk flag belongs to, or null for a flag no rule raises. */
function ruleOfFlag(flag) {
  return RULE_KEYS.find((key) => RULES[key].flag === flag) || null;
}

/** Whether any of these rule flags belongs to a rule whose action refuses the order. */
function refusesFlags(rules, flags) {
  return flags.some((flag) => {
    const key = ruleOfFlag(flag);
    return key && ['block', 'to_lost'].includes(rules.actions[key]);
  });
}

/** The store's country, from its locale (`ar-EG` → `EG`). */
function storeCountry(workspace) {
  // The country set in the store's settings, else its language's region (core/utils/storeCountry.js).
  return require('../../core/utils/storeCountry').countryOf(workspace);
}

// Mobile numbers, digits only with the country code, per store country.
const MOBILE_PATTERNS = {
  EG: /^201[0125]\d{8}$/,
  SA: /^9665\d{8}$/,
  AE: /^9715\d{8}$/,
  KW: /^965[569]\d{7}$/,
  QA: /^974[3567]\d{7}$/,
  BH: /^973[36]\d{7}$/,
  OM: /^968[79]\d{7}$/,
  JO: /^9627[789]\d{7}$/,
  MA: /^212[67]\d{8}$/,
  DZ: /^213[567]\d{8}$/,
  TN: /^216[2459]\d{7}$/,
  IQ: /^9647\d{9}$/,
  LY: /^2189[1-5]\d{7}$/,
};
const { CALLING_CODES } = require('../../core/utils/storeCountry');

/**
 * Whether `phone` is a mobile number of `country`. A country without a
 * pattern here only needs to normalize to 10–15 digits.
 */
function isValidMobile(phone, country = 'EG') {
  const normalized = normalizePhone(phone, CALLING_CODES[country] || '20');
  if (!normalized) return false;
  const pattern = MOBILE_PATTERNS[country];
  return pattern ? pattern.test(normalized) : /^\d{10,15}$/.test(normalized);
}

/** Thrown to refuse a storefront order. The public error carries no rule names. */
class OrderRejectedError extends AppError {
  constructor({ customerId, flags, platformBlock = null, lostReason = 'blocked', toLost = false }) {
    super('ORDER_REJECTED', REJECTION_MESSAGE, 422);
    // Kept off the serialized error (the handler only emits code, message and
    // details) — createOrder reads it to log and audit the refusal.
    // `platformBlock` is the platform blocklist entry ({ id, type }) when that
    // is what refused the order. `lostReason` files the refused checkout under
    // Lost orders; `toLost` says the merchant asked to keep it there.
    Object.defineProperty(this, 'refusal', {
      value: { customerId, flags, platformBlock, lostReason, toLost },
      enumerable: false,
    });
  }
}

/** A phone the strict validation refuses. The shopper is told, so they can fix it. */
function invalidPhoneError() {
  const err = new AppError('INVALID_PHONE', 'Enter a valid mobile number', 422);
  Object.defineProperty(err, 'refusal', {
    value: { customerId: null, flags: ['invalid_phone'], platformBlock: null, lostReason: 'invalid_data', toLost: true },
    enumerable: false,
  });
  return err;
}

/**
 * Serializes storefront orders for one customer until the transaction ends.
 *
 * Without it two identical submissions landing together both run the
 * duplicate/daily-count queries before either has inserted its order, both
 * see nothing, and both go through. The lock is transaction-scoped
 * (pg_advisory_xact_lock), so it is released by the same COMMIT that makes
 * the winner's order visible — the loser's queries, run after it acquires the
 * lock, see that order under READ COMMITTED.
 *
 * Key: one bigint, hashtextextended('fraud_rules:<workspaceId>:<customerId>', 0).
 * The 'fraud_rules:' prefix keeps it out of the way of any other advisory
 * lock the app might take later; the workspace and customer ids pin it to
 * exactly the rows the rules read. The 64-bit hash makes a collision
 * vanishingly rare, and one would only make two unrelated buyers' checkouts
 * queue behind each other for a few milliseconds — never a wrong answer.
 */
async function lockCustomer(workspaceId, customerId, transaction) {
  await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended($key, 0))', {
    bind: { key: `fraud_rules:${workspaceId}:${customerId}` },
    transaction,
  });
}

async function hasDuplicateOrder(workspaceId, customerId, variantIds, windowMinutes, transaction) {
  if (variantIds.length === 0) return false;
  // Rides orders_workspace_id_customer_id_idx to this customer's orders, then
  // order_items_order_id_idx per order for the EXISTS probe.
  const rows = await db.sequelize.query(
    `SELECT 1
       FROM orders o
      WHERE o.workspace_id = $workspaceId
        AND o.customer_id = $customerId
        AND ${NOT_CANCELLED_SQL}
        AND o.created_at >= $since::timestamptz
        AND EXISTS (
              SELECT 1 FROM order_items oi
               WHERE oi.order_id = o.id
                 AND oi.variant_id = ANY($variantIds::uuid[])
            )
      LIMIT 1`,
    {
      bind: {
        workspaceId,
        customerId,
        variantIds,
        since: new Date(Date.now() - windowMinutes * 60 * 1000).toISOString(),
      },
      type: QueryTypes.SELECT,
      transaction,
    }
  );
  return rows.length > 0;
}

async function ordersInLastDay(workspaceId, customerId, transaction) {
  const [row] = await db.sequelize.query(
    `SELECT COUNT(*)::int AS count
       FROM orders o
      WHERE o.workspace_id = $workspaceId
        AND o.customer_id = $customerId
        AND ${NOT_CANCELLED_SQL}
        AND o.created_at >= $since::timestamptz`,
    {
      bind: { workspaceId, customerId, since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
      type: QueryTypes.SELECT,
      transaction,
    }
  );
  return row.count;
}

/**
 * A live COD order from this IP inside the window (orders_ws_ip_created_idx).
 * An IPv6 address counts its whole /64 with IPV6_PREFIX_RULES_ENABLED (./ipPrefix).
 */
async function hasRecentCodOrderFromIp(workspaceId, ip, minutes, transaction) {
  const prefix = ipv6Prefix(ip);
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const rows = await db.sequelize.query(
    `SELECT ${prefix ? 'DISTINCT o.ip_address' : '1'}
       FROM orders o
      WHERE o.workspace_id = $workspaceId
        AND ${prefix ? "o.ip_address LIKE '%:%'" : 'o.ip_address = $ip'}
        AND o.payment_method = 'cod'
        AND ${NOT_CANCELLED_SQL}
        AND o.created_at >= $since::timestamptz
      ${prefix ? '' : 'LIMIT 1'}`,
    {
      bind: prefix ? { workspaceId, since } : { workspaceId, ip, since },
      type: QueryTypes.SELECT,
      transaction,
    }
  );
  return prefix ? rows.some((row) => inPrefix(prefix, row.ip_address)) : rows.length > 0;
}

/** The largest number of units of one product in the order. */
async function maxUnitsOfOneProduct(items, transaction) {
  const perVariant = new Map();
  for (const item of items) {
    if (!item.variantId) continue;
    perVariant.set(item.variantId, (perVariant.get(item.variantId) || 0) + (Number(item.quantity) || 1));
  }
  if (perVariant.size === 0) return 0;
  const variants = await db.ProductVariant.findAll({
    where: { id: [...perVariant.keys()] },
    attributes: ['id', 'productId'],
    transaction,
  });
  const perProduct = new Map();
  for (const variant of variants) {
    perProduct.set(variant.productId, (perProduct.get(variant.productId) || 0) + perVariant.get(variant.id));
  }
  return Math.max(0, ...perProduct.values(), ...(variants.length ? [] : perVariant.values()));
}

/**
 * Runs the configured rules for one storefront order, inside createOrder's
 * transaction, after the customer is resolved and before anything is
 * reserved. Returns `{ flags, requireOtp }` — the rule flags that fired, and
 * whether one of them asks for a verified phone; throws OrderRejectedError
 * when the rules say the order must not be placed.
 *
 * `onlinePayment`: the order is paid through a gateway before anything ships,
 * so a refusing action only flags it — the money is real, and the merchant
 * decides. The blocklist still refuses.
 *
 * `visitor`: `{ ip, ipCountry, isVpn }` of the shopper, when known.
 * `network`: the customer's platform-wide delivery numbers, when known.
 * `riskLevel`: the order's risk level, when it was scored.
 *
 * The platform blocklist is not evaluated here: orderService.createOrder
 * refuses a platform match before any store rule runs.
 */
async function evaluateStorefrontOrder({
  workspaceId,
  customer,
  variantIds,
  transaction,
  onlinePayment = false,
  blockedEntry = null,
  items = [],
  paymentMethod = null,
  phone = null,
  visitor = {},
  network = null,
  riskLevel = null,
}) {
  const workspace = await db.Workspace.findByPk(workspaceId, {
    attributes: ['id', 'settings', 'defaultLocale'],
    transaction,
  });
  const rules = resolveFraudRules(workspace && workspace.settings);
  const country = storeCountry(workspace);

  if (rules.phone_validation === 'strict' && phone && !isValidMobile(phone, country)) throw invalidPhoneError();

  // blockedEntry: a blocked_entries row (IP, email, device, name + address, or
  // a phone that never ordered) matched this order — as good as a blacklisted customer.
  if (rules.block_blacklisted && (customer.isBlacklisted || blockedEntry)) {
    throw new OrderRejectedError({ customerId: customer.id, flags: ['blacklisted_customer'], lostReason: 'blocked' });
  }

  const fired = [];
  const fire = (key) => fired.push(key);

  if (rules.max_items_per_order != null && (await maxUnitsOfOneProduct(items, transaction)) > rules.max_items_per_order) {
    fire('max_items_per_order');
  }
  if (rules.block_outside_country && visitor.ipCountry) {
    const allowed = rules.allowed_countries.length ? rules.allowed_countries : [country];
    if (!allowed.includes(String(visitor.ipCountry).toUpperCase())) fire('block_outside_country');
  }
  if (rules.block_vpn && visitor.isVpn) fire('block_vpn');
  if (
    rules.min_minutes_between_cod_orders_per_ip != null &&
    visitor.ip &&
    paymentMethod === 'cod' &&
    (await hasRecentCodOrderFromIp(workspaceId, visitor.ip, rules.min_minutes_between_cod_orders_per_ip, transaction))
  ) {
    fire('min_minutes_between_cod_orders_per_ip');
  }
  if (
    rules.min_network_delivery_rate != null &&
    network &&
    network.rate != null &&
    network.rate < rules.min_network_delivery_rate
  ) {
    fire('min_network_delivery_rate');
  }
  if (rules.high_risk && riskLevel === 'high') fire('high_risk');

  if (
    rules.duplicate_window_minutes != null ||
    rules.max_orders_per_phone_per_day != null ||
    rules.high_rejection_threshold != null
  ) {
    await lockCustomer(workspaceId, customer.id, transaction);
    if (
      rules.duplicate_window_minutes != null &&
      (await hasDuplicateOrder(workspaceId, customer.id, variantIds, rules.duplicate_window_minutes, transaction))
    ) {
      fire('duplicate_window_minutes');
    }
    if (
      rules.max_orders_per_phone_per_day != null &&
      (await ordersInLastDay(workspaceId, customer.id, transaction)) >= rules.max_orders_per_phone_per_day
    ) {
      fire('max_orders_per_phone_per_day');
    }
    if (rules.high_rejection_threshold != null && customer.totalRejectedOrders >= rules.high_rejection_threshold) {
      fire('high_rejection_threshold');
    }
  }

  const flags = fired.map((key) => RULES[key].flag);
  const refusing = fired.filter((key) => ['block', 'to_lost'].includes(rules.actions[key]));
  if (refusing.length > 0 && !onlinePayment) {
    const kept = refusing.find((key) => rules.actions[key] === 'to_lost');
    throw new OrderRejectedError({
      customerId: customer.id,
      flags,
      lostReason: RULES[kept || refusing[0]].lostReason,
      toLost: Boolean(kept),
    });
  }
  const requireOtp = !onlinePayment && fired.some((key) => rules.actions[key] === 'require_otp');
  return { flags, requireOtp };
}

module.exports = {
  FRAUD_ACTIONS,
  PHONE_VALIDATION_MODES,
  RULES,
  RULE_KEYS,
  FLAGS,
  REJECTION_MESSAGE,
  OrderRejectedError,
  resolveFraudRules,
  refusesFlags,
  ruleOfFlag,
  hasRecentCodOrderFromIp,
  storeCountry,
  isValidMobile,
  evaluateStorefrontOrder,
};
