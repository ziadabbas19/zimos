'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');

/**
 * Merchant-configured fraud rules for storefront orders.
 *
 * Stored under `workspaces.settings.fraud_rules` (PATCH /workspaces/:id, same
 * merge semantics as checkout_settings). Every rule is off until the merchant
 * sets it, so a workspace that never touched this setting places orders
 * exactly as it did before the rules existed.
 *
 *   action                        'flag' (default) or 'block'
 *   block_blacklisted             refuse blacklisted customers, whatever `action` says
 *   duplicate_window_minutes      same customer + any same variant within N minutes
 *   max_orders_per_phone_per_day  customer already has N orders in the last 24h
 *   high_rejection_threshold      customer.totalRejectedOrders >= N
 *
 * Only storefront orders are evaluated — see orderService.createOrder for
 * the scoping and for the follow-on exemption.
 */

const FRAUD_ACTIONS = ['flag', 'block'];

const FLAGS = Object.freeze({
  DUPLICATE_ORDER: 'duplicate_order',
  PHONE_DAILY_LIMIT: 'phone_daily_limit',
  HIGH_REJECTION_CUSTOMER: 'high_rejection_customer',
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

/** The effective rules for a workspace settings blob: stored values over the defaults. */
function resolveFraudRules(settings) {
  const stored = (settings && settings.fraud_rules) || {};
  return {
    action: FRAUD_ACTIONS.includes(stored.action) ? stored.action : 'flag',
    block_blacklisted: stored.block_blacklisted === true,
    duplicate_window_minutes: stored.duplicate_window_minutes ?? null,
    max_orders_per_phone_per_day: stored.max_orders_per_phone_per_day ?? null,
    high_rejection_threshold: stored.high_rejection_threshold ?? null,
  };
}

function hasCountingRule(rules) {
  return (
    rules.duplicate_window_minutes != null ||
    rules.max_orders_per_phone_per_day != null ||
    rules.high_rejection_threshold != null
  );
}

/** Thrown to refuse a storefront order. The public error carries no rule names. */
class OrderRejectedError extends AppError {
  constructor({ customerId, flags }) {
    super('ORDER_REJECTED', REJECTION_MESSAGE, 422);
    // Kept off the serialized error (the handler only emits code, message and
    // details) — createOrder reads it to log and audit the refusal.
    Object.defineProperty(this, 'refusal', { value: { customerId, flags }, enumerable: false });
  }
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
 * Runs the configured rules for one storefront order, inside createOrder's
 * transaction, after the customer is resolved and before anything is
 * reserved. Returns the rule flags that fired; throws OrderRejectedError when
 * the workspace's rules say the order must not be placed.
 *
 * `onlinePayment`: the order is paid through a gateway before anything ships,
 * so the counting rules' "block" only flags it — the money is real, and the
 * merchant decides. The blocklist still refuses.
 */
async function evaluateStorefrontOrder({ workspaceId, customer, variantIds, transaction, onlinePayment = false }) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'], transaction });
  const rules = resolveFraudRules(workspace && workspace.settings);

  if (rules.block_blacklisted && customer.isBlacklisted) {
    throw new OrderRejectedError({ customerId: customer.id, flags: ['blacklisted_customer'] });
  }
  if (!hasCountingRule(rules)) return [];

  await lockCustomer(workspaceId, customer.id, transaction);

  const flags = [];
  if (
    rules.duplicate_window_minutes != null &&
    (await hasDuplicateOrder(workspaceId, customer.id, variantIds, rules.duplicate_window_minutes, transaction))
  ) {
    flags.push(FLAGS.DUPLICATE_ORDER);
  }
  if (
    rules.max_orders_per_phone_per_day != null &&
    (await ordersInLastDay(workspaceId, customer.id, transaction)) >= rules.max_orders_per_phone_per_day
  ) {
    flags.push(FLAGS.PHONE_DAILY_LIMIT);
  }
  if (rules.high_rejection_threshold != null && customer.totalRejectedOrders >= rules.high_rejection_threshold) {
    flags.push(FLAGS.HIGH_REJECTION_CUSTOMER);
  }

  if (flags.length > 0 && rules.action === 'block' && !onlinePayment) {
    throw new OrderRejectedError({ customerId: customer.id, flags });
  }
  return flags;
}

module.exports = {
  FRAUD_ACTIONS,
  FLAGS,
  REJECTION_MESSAGE,
  OrderRejectedError,
  resolveFraudRules,
  evaluateStorefrontOrder,
};
