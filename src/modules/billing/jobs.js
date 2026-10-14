'use strict';

const HOUR = 60 * 60 * 1000;

module.exports = {
  schedules: [
    {
      // A free or discounted manual period that ran out moves to past_due
      // instead of renewing (manualSubscriptionService.expireManualPricing).
      name: 'billing.manual_pricing_sweep',
      everyMs: HOUR,
      // eslint-disable-next-line global-require
      handle: () => require('./manualSubscriptionService').expireManualPricing(),
    },
    {
      // A move's charge left unpaid WALLET_MOVE_EXPIRY_HOURS is voided
      // (merchantPlansService.expirePendingMoves; WALLET_ENABLED only).
      name: 'billing.expire_plan_moves',
      everyMs: HOUR,
      // eslint-disable-next-line global-require
      handle: () => require('./merchantPlansService').expirePendingMoves(),
    },
    {
      // A paid subscription that ended unrenewed, with a balance that covers
      // one order's fee, moves to pay per order instead of lapsing
      // (walletFallbackService.sweep; WALLET_ENABLED only).
      name: 'billing.wallet_fallback',
      everyMs: HOUR,
      // eslint-disable-next-line global-require
      handle: () => require('./walletFallbackService').sweep(),
    },
    {
      // A merchant's plan switch: its charge left unpaid
      // PLAN_SWITCH_CHARGE_EXPIRY_HOURS is voided, and a downgrade whose paid
      // period has ended takes effect (planSwitchService.runDue). Follows the
      // rows: nothing to do while no switch was ever made.
      name: 'billing.plan_switches',
      everyMs: HOUR,
      // eslint-disable-next-line global-require
      handle: () => require('./planSwitchService').runDue(),
    },
  ],
};
