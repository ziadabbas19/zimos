'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const walletService = require('../billing/walletService');

/**
 * Whether a store is restricted, and why. Three independent reasons, any of
 * which is enough:
 *
 *   billing    the subscription is unpaid and its grace day is over;
 *   suspended  a platform admin suspended the store by hand (workspaces.status
 *              = 'suspended', see platformAdmin/workspaceSuspensionService);
 *   balance    on the pay-per-order plan while WALLET_ENABLED is on, the
 *              prepaid balance can't pay the next order's fee within the
 *              overdraft (billing/walletService). Always applied, whatever
 *              BILLING_RESTRICTIONS says (Q17); topping up lifts it. Product
 *              and funnel creation stay open: only selling stops.
 *
 * Neither touches the other: paying lifts only the billing reason, and
 * reactivating only the suspension.
 *
 * "Restricted" means the storefront answers STORE_UNAVAILABLE on every public
 * route (core/middleware/publicWorkspace.js) and creating products and funnels
 * is refused (core/middleware/subscriptionGuard.js). Nothing else in the
 * dashboard is locked.
 *
 * The billing lifecycle is computed on the fly from the subscription's own
 * `current_period_end`, never stored, so a payment lifts a restriction the
 * moment it extends the period:
 *
 *   ok          more than 3 days of the period left;
 *   expiring    3 days or less left — the dashboard warns;
 *   payment_due past_due while the period still runs (a failed or reversed
 *               payment) — warned, not restricted;
 *   grace       the period has ended unpaid, for 1 day — warned, not
 *               restricted;
 *   restricted  more than 1 day past the period end, still unpaid.
 *
 * A trialing or active subscription whose period has ended counts as past_due
 * straight away, whether or not the sweep (billingService.expireStaleTrials)
 * has written that yet. Cancelled and billing-suspended subscriptions count
 * as unpaid too.
 *
 * `env.billing.restrictions` = 'warn' reports the phases but never restricts
 * for billing; a manual suspension is enforced regardless.
 *
 * Draft (REQUIRE_SUBSCRIPTION_TO_GO_LIVE): a store made while the flag is on
 * starts with subscription status 'draft' and stays a draft until a trial or
 * a paid subscription starts (billing/goLiveService). This is the one place a
 * draft is recognised — `isDraftSubscription` — and the guards
 * (core/middleware/subscriptionGuard.requireLive, publicWorkspace) ask here.
 * A draft is not "restricted": it may be built, edited and previewed, only
 * not published or sell. Its phase is 'draft' and it has no period to warn
 * about. With the flag off again, a draft left from while it was on reads as
 * the trial it would have had (its stored period is exactly that).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 3;
const GRACE_DAYS = 1;
const UNPAID = new Set(['past_due', 'cancelled', 'suspended']);

/** A store not subscribed yet, while drafts are enforced. */
function isDraftSubscription(subscription) {
  return Boolean(subscription && subscription.status === 'draft' && env.signup.requireSubscription === true);
}

function billingLifecycle(subscription, now = new Date()) {
  if (!subscription) {
    return { phase: 'ok', status: null, storedStatus: null, periodEnd: null, restrictsAt: null, restricted: false };
  }
  if (isDraftSubscription(subscription)) {
    return {
      phase: 'draft',
      status: 'draft',
      storedStatus: 'draft',
      trialing: false,
      periodEnd: null,
      restrictsAt: null,
      restricted: false,
      draft: true,
    };
  }
  const storedStatus = subscription.status === 'draft' ? 'trialing' : subscription.status;
  const periodEnd = new Date(subscription.currentPeriodEnd);
  const lapsed = now.getTime() > periodEnd.getTime();
  const status = lapsed && (storedStatus === 'trialing' || storedStatus === 'active') ? 'past_due' : storedStatus;
  const restrictsAt = new Date(periodEnd.getTime() + GRACE_DAYS * DAY_MS);
  const unpaid = UNPAID.has(status);

  let phase;
  if (unpaid && now.getTime() >= restrictsAt.getTime()) phase = 'restricted';
  else if (unpaid && lapsed) phase = 'grace';
  else if (unpaid) phase = 'payment_due';
  else if (periodEnd.getTime() - now.getTime() <= EXPIRY_WARNING_DAYS * DAY_MS) phase = 'expiring';
  else phase = 'ok';

  return {
    phase,
    // The status as it stands, counting a lapsed period as past_due.
    status,
    storedStatus: subscription.status,
    trialing: storedStatus === 'trialing',
    periodEnd,
    restrictsAt,
    restricted: phase === 'restricted',
  };
}

/**
 * The access picture for one workspace. `workspace` / `subscription` may be
 * passed in when the caller already loaded them.
 */
async function accessFor(workspaceId, { now = new Date(), workspace, subscription } = {}) {
  const ws =
    workspace ||
    (await db.Workspace.findByPk(workspaceId, {
      attributes: ['id', 'status', 'suspendedAt'],
    }));
  const sub =
    subscription === undefined
      ? await db.Subscription.findOne({
          where: { workspaceId },
          attributes: ['id', 'status', 'currentPeriodEnd', 'billingCycle', 'planId'],
        })
      : subscription;

  const billing = billingLifecycle(sub, now);
  const enforced = env.billing.restrictions === 'enforce';
  const billingRestricted = billing.restricted && enforced;
  const suspended = Boolean(ws && ws.status === 'suspended');
  // Only when WALLET_ENABLED is on and the store is on a fee plan; otherwise
  // null without a query.
  const wallet = await walletService.accessState(workspaceId, sub);
  const reasons = [];
  if (suspended) reasons.push('suspended');
  if (billingRestricted) reasons.push('billing');
  // A plan with its own debt limit keeps the store open: only new orders are
  // refused (422 WALLET_LIMIT_REACHED in walletService.chargeOrderFee).
  if (wallet && wallet.phase === 'exhausted' && wallet.policy !== 'debt_limit') reasons.push('balance');

  return {
    restricted: reasons.length > 0,
    reasons,
    wallet,
    draft: billing.phase === 'draft',
    billing: { ...billing, enforced },
    suspension: suspended ? { suspended: true, since: ws.suspendedAt || null } : { suspended: false, since: null },
  };
}

/**
 * Whether the storefront answers STORE_UNAVAILABLE (core/middleware/
 * publicWorkspace). With ORDERS_LOCK_ENABLED an unpaid subscription or an
 * empty balance no longer closes it: the store keeps selling and its new
 * orders' customer details are hidden instead (orders/orderLock.js). A
 * suspension by Zimos still closes it.
 */
function closesStorefront(access) {
  if (!access.restricted) return false;
  if (env.ordersLock.enabled === true) return access.reasons.includes('suspended');
  return true;
}

/** The merchant dashboard's view: what to warn about and what is locked. */
function serializeAccess(access) {
  const b = access.billing;
  return {
    restricted: access.restricted,
    reasons: access.reasons,
    // False while the store still sells despite `restricted` (ORDERS_LOCK_ENABLED).
    storefrontClosed: closesStorefront(access),
    // Locked orders are on (orders/orderLock.js): the dashboard shows the
    // balance widget and the locked-orders banner.
    ordersLock: env.ordersLock.enabled === true,
    // Built but not published until subscribed (REQUIRE_SUBSCRIPTION_TO_GO_LIVE).
    draft: Boolean(access.draft),
    billing: {
      phase: b.phase,
      status: b.status,
      trialing: Boolean(b.trialing),
      periodEnd: b.periodEnd,
      restrictsAt: b.restrictsAt,
      // False when billing restrictions only warn (BILLING_RESTRICTIONS=warn).
      enforced: b.enforced,
    },
    suspension: access.suspension,
    // The pay-per-order balance: { phase: ok | low | overdraft | exhausted,
    // balance, fee, ordersLeft, … } — null when the store pays no order fee.
    wallet: access.wallet || null,
  };
}

module.exports = {
  DAY_MS,
  EXPIRY_WARNING_DAYS,
  GRACE_DAYS,
  billingLifecycle,
  isDraftSubscription,
  accessFor,
  closesStorefront,
  serializeAccess,
};
