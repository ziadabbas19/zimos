# The prepaid balance and the pay-per-order plan

Behind `WALLET_ENABLED` (only `true` turns it on). With it off nothing below
happens: no fee is charged, no plan with a fee is offered, and no top-up is
taken.

There's one exception. A fee charged while it was on is still given back when
its order is cancelled after it goes off.

Code: `src/modules/billing/walletService.js`. Migration 131.

With `ORDERS_LOCK_ENABLED` on, the fee is taken once when an order is
confirmed instead of when it is placed, never below zero and never given back;
an empty balance hides new orders' customer details instead of closing the
store. See `docs/orders-lock.md`.

## The plan

- **A pay-per-order plan:** a plan with `per_order_fee_amount > 0` (minor
  units: 50 = EGP 0.50), nothing monthly, in EGP.
- **Setting the fee:** the console's plan editor refuses a fee on any other
  plan (`PER_ORDER_FEE_NOT_ALLOWED`).
- **Where it's offered:** never as a default plan, in the public plan list, a
  sign-up choice or a regular card. It has its own card in the Subscription
  section, and `GET /plans/public` sends it beside the list as `payPerOrder`
  (the plan the Subscription section offers, or `null` while there is none
  or `WALLET_ENABLED` is off) for the marketing site's pricing page: its fee,
  its free orders and `feeChargedAt` (`confirmation` with `ORDERS_LOCK_ENABLED`
  on, else `placement`).
- **Choosing it:** a draft or a trial chooses it at once
  (`POST /workspaces/:id/billing/pay-per-order`), with a period of 100 years
  and nothing to pay. A paid subscription changes through support.

## Moving to a monthly or annual plan (migration 222)

A store on the pay-per-order plan moves by itself, with no support:
`POST /workspaces/:id/billing/plan-move { planId, billingCycle }`
(`merchantPlansService.requestPlanMove`).

- **One ordinary charge** for the plan on offer and cycle, priced like any
  charge (referral code, special terms). It carries `target_plan_id` and
  `target_billing_cycle`, and is paid the usual ways: online, a transfer's
  proof, or the console's record-payment. There is no paying it from the
  balance.
- **The switch happens in `settlePaid`, only when it's paid:** the new plan
  and cycle, active, one period from the payment (the 100-year period is
  replaced), no trial. Until then nothing about the subscription changes,
  and order fees go on.
- **No trial:** choosing pay per order, and asking for a move, write a
  `plan_trials` row (`source = 'pay_per_order'`) for the owner.
- **A debt is refused first:** a balance below zero gets 422
  `WALLET_DEBT_OUTSTANDING`, with `details.debt`. The balance itself is
  never touched by a move.
- **Asked twice:** the same plan and cycle while its charge waits get that
  charge back (200). Another plan or cycle **replaces** the waiting move: its
  charge is voided (`replaced`) and the new one written, in one transaction.
  Only a pending charge that isn't a move (a renewal) still gets 409
  `OPEN_CHARGE_EXISTS`.
- **Never trapped (migration 224):** an unpaid move changes nothing about the
  store. Its charge becomes `void`, with `void_reason`, which means it isn't
  due, isn't owed, isn't dunned and doesn't touch the subscription. It gets
  there three ways:
  - the merchant cancels it (`POST /billing/plan-move/cancel`): `cancelled`;
  - another move replaces it: `replaced`;
  - the hourly billing job `billing.expire_plan_moves` finds it unpaid after
    `WALLET_MOVE_EXPIRY_HOURS` (48): `expired`. Only with `WALLET_ENABLED`.

  Each is audited (`subscription.plan_move_void`).
- **Money that arrives for a void move** (a proof approved later, a checkout
  paid late, the console's record-payment): `settlePaid` hands it to
  `settleLateMovePayment`, so it's never lost.
  - It's **applied** when the store is still on pay per order, the plan is
    still on offer and no other charge is pending.
  - Otherwise it's **credited** to the balance once per payment
    (`move_payment_credit`). That's not a top-up, so it isn't refundable by
    request. The charge stays void and records what arrived.
  - Audited: `subscription.plan_move_late_applied` /
    `_payment_credited`.
- **After the switch:** the plan has no fee, so no order fee is taken. The
  free orders used stay counted.
- **A manual payment reversed:** the plan, cycle, status and period from
  before the payment come back.
- **Audit:** `subscription.plan_move_request` and
  `subscription.plan_move_complete`.
- **Every other store keeps today's rules:** `PLAN_CHANGE_NEEDS_SUPPORT` for
  a paid subscription, `POST /billing/plan` for a draft or a trial.
- `GET /billing/plans` has `move` (balance, debt, the pending move), or null.

## The fee

- **When it's charged:** in `orderService.createOrder`, after `Order.create`,
  as the transaction's last lock. Charged while the subscription is `active` on
  the plan.
- **When it's refused:** when the balance would fall below
  `-OVERDRAFT_LIMIT` (EGP 10). The refusal rolls the order back:
  - staff get 402 `WALLET_BALANCE_TOO_LOW`;
  - a shopper gets 423 `STORE_UNAVAILABLE`.
- **Funnel add-ons:** an add-on placed as its own order pays none (Q14).
- **Given back:** the merchant cancels, a confirmation call rejects, an
  online order expires unpaid, or a payment arrives for a blocklisted
  customer.
- **Charged again** (`order_fee_recharge`, past the overdraft): a rejection
  is corrected to confirmed, or a late payment reopens the order.
- **Never moved** once a parcel has shipped.
- **Idempotency:**
  - every entry has a unique key: `order_fee:<order>:<n>`,
    `order_fee_reversal:<order>:<n>`, `order_fee_recharge:<order>:<n>`,
    `topup:<proof>`;
  - the order's state is read from its own entries under the wallet lock;
  - so a repeated event moves nothing, and charge → give back → charge again
    works.

## The restriction

`workspaceAccessService.accessFor` gets a third reason, `balance`: the next
order's fee can't be paid within the overdraft.

- **Shoppers** see the store as unavailable (423).
- **Dashboard banner:** warns below 20 orders before the overdraft, again at
  zero, and says when the store stopped selling.
- **Product and funnel creation** stay open.
- **`BILLING_RESTRICTIONS`** doesn't apply to it (Q17).

## Top-ups

A transfer's proof, the same flow as paying an invoice
([billing-payment-methods.md](billing-payment-methods.md)), with
`purpose = 'topup'`:

- **The request:** `POST /workspaces/:id/billing/wallet/topups` with an
  amount between `MIN_TOPUP_AMOUNT` (EGP 100) and `MAX_TOPUP_AMOUNT`
  (EGP 20,000).
- **Waiting:** at most `MAX_OPEN_TOPUPS` (3).
- **The credit:** the console credits **what arrived**, shown beside what was
  asked. Once per proof.

There is no promotional balance. Refunds: see below.

### By card (migration 221)

The same gateway layer as paying a charge online
([billing-payment-methods.md](billing-payment-methods.md)), with an attempt of
`purpose = 'topup'` and no charge:

- **Starting it:** `POST /workspaces/:id/billing/wallet/topups/online
  { amount, method?, lang }`. Only with `WALLET_ENABLED` on, for a store on
  the pay-per-order plan (409 `WALLET_NOT_ON_PLAN` otherwise), within the
  same limits as a transfer, through a gateway the merchant is offered.
  Fawaterak stays behind `ONLINE_BILLING_ENABLED` and its keys.
- **The credit:** when the gateway's own API says it is paid (a webhook, the
  merchant's status read `GET /billing/payments/:id`, or the sweep), the
  amount the attempt was for, once: `topup:attempt:<id>`. A payment of
  another amount or currency is marked `mismatch` and credits nothing.
- **Every paid attempt credits:** none supersedes another, since each is its
  own money.
- The billing summary's latest online payment counts charges only.

## Falling back to pay per order (billing/walletFallbackService)

The balance belongs to the merchant, never to a plan.

**When it happens:** a paid subscription's period ends unrenewed. That
covers the grace day running out, and a cancellation that takes effect at
period end. If the balance can pay at least one order's fee, the store
moves to the offered pay-per-order plan (`offeredFeePlan`) instead of going
past due and then restricted.

**What runs it:** the hourly billing job `billing.wallet_fallback`. The
lifecycle itself is computed when read and has no job of its own, so this
is the first run after the period ends.

**Exactly as today when:**

- `WALLET_ENABLED` is off;
- no pay-per-order plan is on offer;
- the balance is below one fee, or in debt;
- a charge is still pending (the merchant may be paying the renewal);
- the store is a draft or a trial;
- the subscription is cancelled or suspended;
- the subscription is priced by hand.

**How it runs:**

- Each store in its own transaction: the subscription is locked and
  everything is checked again, then the wallet under its lock. A second run
  changes nothing.
- The free orders already used stay used.
- The account is marked as having had its trial.
- Audited (`subscription.wallet_fallback`).
- Told in the merchant's bell (`wallet.fallback`) and the console's
  notifications (`wallet_fallback`).

The merchant can move back to a subscription at any time (`POST
/billing/plan-move`).

## Refunds (migration 223)

A merchant asks for unused balance back, and the console pays it out by hand.
Behind `WALLET_ENABLED`, for a store on the pay-per-order plan or one with a
balance. Code: `src/modules/billing/walletRefundService.js`.

### What can come back

- **Per paid top-up:** each `topup` entry (a transfer the console approved,
  or a card payment) gives back at most `WALLET_REFUND_CEILING_BP` of itself:
  7500 = 75%, rounded down. A top-up of 1000 gives 750, one of 500 gives 375.
- **What's left of a top-up:** its ceiling, less what open or paid requests
  took from it.
- **Never counted:** gifts, corrections (`adjustment`) and free orders. They
  aren't top-ups.
- **The most a request can ask for:** the smaller of what's left over all
  top-ups and the balance.
- **The least:** `WALLET_REFUND_MIN_AMOUNT` (5000 = EGP 50).
- **Refused:**
  - a debt (422 `WALLET_DEBT_OUTSTANDING`);
  - a second open request (422 `REFUND_REQUEST_OPEN`);
  - too little or too much (422 `REFUND_AMOUNT_TOO_LOW` / `_TOO_HIGH`, with
    `details.min` / `max`).

### The steps

1. **Asked:** the amount is spread over the top-ups in
   `wallet_refund_allocations`, newest first (`WALLET_REFUND_ALLOCATION=oldest_first`
   for the other way). `refund_hold` takes it off the balance, so it can't
   be spent.
2. **Cancelled** (by the merchant, while requested) **or rejected** (by the
   console, while open, with a note): `refund_release` puts it back. The
   allocations stop counting, so every top-up has exactly what it had.
3. **Approved:** nothing moves.
4. **Paid:** the console made the transfer and gives its reference.
   `refund_paid` is a marker with no money, because the hold already took
   it. This happens once; a second call changes nothing.

Each step:

- locks the request first, then the wallet;
- has its key (`refund_hold:<id>`, `refund_release:<id>`, `refund_paid:<id>`);
- is audited (`wallet.refund_*`);
- tells the merchant in the bell (`wallet.refund`).

A repeated request with the same `requestId` is the same request. One open
per store, by a unique partial index too.

### Endpoints

| | |
|---|---|
| `GET /workspaces/:id/billing/wallet/refunds` | the quote (max, min, balance, debt) and the latest requests |
| `POST /workspaces/:id/billing/wallet/refunds { amount, payoutMethod, payoutAccount, requestId }` | ask |
| `POST /workspaces/:id/billing/wallet/refunds/:refundId/cancel` | cancel while requested |
| `GET /admin/wallet-refunds?status=` | the console's list (`payments.record`) |
| `POST /admin/wallet-refunds/:id/approve { note }`, `/reject { note }`, `/mark-paid { payoutReference, note }` | `payments.record` |

## It never expires

Nothing expires or decays a balance:

- no scheduled job touches the wallet;
- there's no time limit on a balance;
- no ledger entry is written for time passing.

The only scheduled change is a fee given back when an unpaid online order
expires, and that's a fee, not the balance.
`tests/integration/walletNoExpiry.test.js` checks it. It reads every
`jobs.js`, and runs the billing sweeps two years on: the balance, its cache
and its ledger stay the same.

## The ledger

- **`wallet_ledger_entries` is append-only.** A trigger refuses UPDATE and
  DELETE, and `workspace_wallets.cash_balance` is a cache of it.
- **`node scripts/check-wallet-ledger.js`** (read-only) compares the two per
  store. Exit codes: 0 all match, 2 a difference, 1 couldn't run.
- **A reset of the data:** `TRUNCATE wallet_ledger_entries, workspace_wallets`
  works, because TRUNCATE fires no row trigger. Deleting a store takes its rows
  along (the trigger lets a row go once its workspace is gone).
- **What the trigger refuses:** a `DELETE FROM wallet_ledger_entries` aimed at
  rows of a store that still exists.

## Free orders and the debt limit (migration 220)

Two settings on a pay-per-order plan, in the console's plan editor. Their
defaults keep everything above as it was.

- **Free orders** (`plans.wallet_free_orders`, default 0): orders a store
  places before any fee. Each one is an `order_fee` entry with `cash_delta`
  0 and `free_orders_delta` -1, under the same key, so it's given back and
  taken again like a fee. The console grants more to one store.
- **Debt limit** (`plans.wallet_debt_limit_amount`, minor units, default
  NULL):
  - NULL: the fixed `OVERDRAFT_LIMIT` and the refusal above (402 / 423, the
    store restricted).
  - Set: the balance may go that far below zero. Past it, a new order gets
    **422 `WALLET_LIMIT_REACHED`** (staff and shoppers alike, with no
    balance in the shopper's answer) and the store stays open.
  - The bell tells the team (`billing.manage`) when the balance runs low
    (`wallet.low`) and when the limit is reached (`wallet.limit_reached`),
    at most once a day each.
- **A top-up clears a debt first**, because the balance is one signed number.

`workspace_wallets.free_orders_used` and `free_orders_granted` are caches of
the ledger like `cash_balance`. The check script compares them too.

## The console's entries

Each needs a reason and the dialog's own `requestId`, so a retry writes
nothing twice. Each is audited on the store.

| | Permission | Entry |
|---|---|---|
| `POST /admin/workspaces/:id/wallet/free-orders { count, reason, requestId }` | `subscriptions.manage` | `free_orders_grant:<requestId>` |
| `POST /admin/workspaces/:id/wallet/adjustments { amount, reason, requestId, kind, notifyMerchant }` | `payments.record` | `kind: correction` (default): `adjustment:<requestId>`, either way. `kind: gift` (migration 223): `gift:<requestId>`, adds only. Neither is a top-up, so neither is ever refundable. `notifyMerchant` tells the store in the bell (`wallet.credit`) |

`GET /admin/workspaces/:id/wallet` also has `refunds`:

- each paid top-up with its ceiling, what was refunded, what is held and
  what is left;
- the lifetime top-ups, what is still refundable, what was refunded and
  what is pending.

## Endpoints

| | |
|---|---|
| `GET /workspaces/:id/billing/wallet` | balance, fee, orders left, this month in Cairo, limits |
| `GET /workspaces/:id/billing/wallet/ledger?page&pageSize` | the entries, newest first |
| `POST /workspaces/:id/billing/wallet/topups` | multipart: `requestedAmount`, `methodCode`, `senderPhone`, `file` |
| `POST /workspaces/:id/billing/wallet/topups/online` | a card top-up's checkout: `amount`, `method`, `lang` |
| `POST /workspaces/:id/billing/pay-per-order` | choose the plan (a confirmed account) |
| `GET /admin/workspaces/:id/wallet` | the console's panel (`subscriptions.view`) |
