# Locked orders and the fee at confirmation

Behind `ORDERS_LOCK_ENABLED` (only `true` turns it on). Off, nothing below
happens: nothing is hidden, the pay-per-order fee is charged when the order is
placed (as `docs/billing-wallet.md` describes), and every answer is the one it
was, without the new `contactLocked` field. Migration 718 adds
`orders.contact_lock`, the `order_confirm_fee` ledger type and the
`webhook_order_holds` table; it writes no data.

Code: `src/modules/orders/orderLock.js` (the rule, the hiding, the refusals)
and `src/modules/billing/confirmFeeService.js` (the fee).

## The rule

An order's customer details — the name, the phones, the e-mail, the address
below the governorate, the notes, the checkout answers, the answers on the
order's lines (a product's custom fields: the text typed, the photo uploaded),
a gift message, the IP / browser / device, a transfer's payer number and
screenshot — are shown to the merchant when

- (a) the store is entitled now: its subscription is in any phase but
  `restricted` (`workspaceAccessService.billingLifecycle`: more than a day past
  the period end, unpaid), or it is on a fee plan while `WALLET_ENABLED` is off;
- (b) the order was settled when it reached its confirmed stage
  (`contact_lock = 'unlocked'`), or reached it before the column existed
  (`contact_lock` null);
- (c) the order never reached its confirmed stage — pending, or cancelled or
  rejected before it was confirmed — the store pays per order, and it can pay
  the fee now (a free order left, or a balance of at least one fee);
- (d) its fee was charged when it was placed (before the switch,
  `order_fee` / `order_fee_recharge` on `wallet_ledger_entries`) and not given
  back since (`order_fee_reversal`): read from the ledger when asked, nothing
  written for it.

Otherwise it is **locked**. A funnel add-on placed as its own order (`source`
`upsell` with `linked_from_order_id`) follows the order it was added to.

The confirmed stage is a COD confirmation, or an online payment landing (a
prepaid order is never "confirmed"; it is ready to ship once paid).

Nothing stored changes: the order is written in full and its presentation
hides each field as `••••` (an empty field stays empty). Products, prices,
totals, dates, states and the governorate always show. It is all decided when
read, so renewing or topping up opens everything at once.

`BILLING_RESTRICTIONS` does not decide the lock: with the switch on, a lapsed
subscription locks new orders whether restrictions enforce or warn. With the
switch on, an unpaid subscription or an empty balance no longer closes the
storefront (`workspaceAccessService.closesStorefront`): the store, the
checkout and the payment keep working, and the shopper sees the usual thank-you
page. A suspension by Zimos still closes it.

## The fee

Taken once, when the order reaches its confirmed stage, never when it is
placed (`walletService.chargeOrderFee` does nothing while the switch is on, so
a shopper is never refused for the balance).

- Free orders first (`wallet_free_orders` + the console's grants): an entry
  with cash 0 and `free_orders_delta` -1.
- Then the plan's `per_order_fee_amount`, only when the balance holds all of
  it: the balance never goes below zero for it. A balance already below zero
  (the old overdraft) confirms nothing until topped up.
- One per order: the order row is locked by the confirming path, then the
  wallet row (`FOR UPDATE`, the last lock); the key is
  `order_confirm_fee:<order>`; `wallet_ledger_entries_confirm_fee_once` is a
  unique index on `(order_id, entry_type)` for the type.
- An order that paid a fee when it was placed (before the switch) pays nothing
  more when confirmed, and shows while pending (rule (d)).
- A funnel add-on placed as its own order pays no fee once the order it was
  added to is settled (`contact_lock = 'unlocked'`, or confirmed before the
  column existed). While that order is still pending — visible for now by
  rule (c) only — the add-on pays its own fee like any order: confirming the
  add-on alone never opens the shared customer for good.
- Never given back: an order cancelled, rejected or returned after its
  confirmation keeps its fee (`walletService.reverseOrderFee` skips it). A fee
  taken at placing for an order never confirmed is still given back, as
  before. `rechargeOrderFee` does nothing while the switch is on.

Where an order is confirmed, all through the two setters of
`orders/orderStateService.js`:

| Path | Setter | When the fee cannot be paid |
| --- | --- | --- |
| Queue outcome (`POST /confirmation-tasks/:id/outcome`) | `setConfirmationState` | 402 `ORDER_LOCKED`, the task stays open |
| Confirm on the order page (`POST /orders/:id/confirmation`) | same | 402 `ORDER_LOCKED` |
| `PATCH /orders/:id/status` to `ready_to_ship` | same (via `confirmFromOrder`) | 402 `ORDER_LOCKED` |
| Bulk `set_status` (`POST /orders/bulk`) | same, order by order | that order fails with `ORDER_LOCKED`, the rest go on |
| Correction rejected → confirmed | same | 402 `ORDER_LOCKED` |
| The customer's WhatsApp button (`whatsapp/quickReplyConfirmation`) | same | not confirmed; the team is told in the bell |
| Automation step `set_status: confirmed` | same | the step fails, the order stays pending |
| Public API confirmation | same | 402 `ORDER_LOCKED` |
| An online payment landing (gateway, captured payment, approved transfer, gift card, store credit, loyalty) | `setFinancialState` → paid, non-COD | the payment stands; the order is marked `due` and stays locked |

A `due` order is settled (its fee taken, `contact_lock` → `unlocked`) right
after the payment commits, after any credit to the balance (top-up, gift,
correction, fee given back, free orders granted), when the merchant moves to
pay per order (`choosePayPerOrder`, a plan switch applied at once:
`walletService.startPayPerOrder`), and from the dashboard
(`POST /orders/locked/settle`, e.g. after a fallback to pay per order). No
scheduled job takes it: none moves the balance's money
(`tests/integration/walletNoExpiry.test.js`), so the automatic fallback to pay
per order and a scheduled switch leave it for the next top-up or the
dashboard. A `due` order cancelled since is left alone.

A renewal — a subscription charge paid (`subscriptionChargeService.settlePaid`,
whatever paid it) or the console's activate / extend / plan change
(`manualSubscriptionService`) — marks the store's `due` orders `unlocked`
once it commits, without a fee, when the store is entitled again; otherwise
they would lock again with the next lapse. It moves no money: each order is
decided again under its own lock without taking a fee, so a store that moved
to pay per order in between keeps its `due` orders for its next top-up.

## Every path, and what it does with a locked order

Merchant answers (hidden, `contactLocked: true` and `lockReason`):

- orders list `GET /orders`, its search (never matches a locked order by name,
  e-mail or phone; the order number still finds it), the tab counts
  `GET /orders/pipeline`, the risk counts, the neighbours
  `GET /orders/:id/neighbors`;
- order detail `GET /orders/:id` and every order a handler answers with:
  create, confirm, status change, fulfil, items edit, cancel (with or without
  a refund);
- the confirmation queue (`GET /confirmation-tasks` and claim, release,
  assign, outcome, correction);
- the CSV / Excel export `GET /orders/export` and the export-file job (they
  read the list): `••••` in the file;
- the public API (`/api/v1/public`): `GET /orders`, `/orders/:id`,
  `/by-number`, the confirmation / cancel / COD-collected answers, with
  `contactLocked: true`;
- the webhook delivery log (`GET /webhooks/deliveries`,
  `GET /webhooks/:id/deliveries`, and the rows Send test / Redeliver / Resend
  answer): a delivery about a locked order, a hidden customer, or a lost
  checkout while those are hidden shows its payload's customer details as
  `••••` and `contactLocked: true`, for every viewer
  (`webhooks/deliveryLock.js`);
- customers `GET /customers`, `GET /customers/:id` (a customer is hidden when
  every order they placed is locked; a lead with no order is not);
  `PATCH /customers/:id`, the address edits and the blacklist switch
  (`PATCH /customers/:id/blacklist`) are refused (402);
- contacts `GET /contacts`, `GET /contacts/:id`, the export, and the contact
  search; adding a contact whose phone a hidden customer has answers 409
  without the `customerId`;
- the dashboard search (Ctrl K) `GET /search`: orders and customers;
- the manual order form's lookup `GET /orders/manual/customer`: a hidden
  customer comes without `id`, `totalOrders`, `totalRejectedOrders` or
  `lastOrder` (null), so a typed phone is not tied to their locked orders
  (every order in `GET /orders` carries its `customerId`);
- the store's blacklist `GET /fraud/blocklist`: an entry that stands for a
  hidden customer — their phone, or an e-mail or a name + address one of
  their orders was placed with (`blockedEntries.hiddenEntryTest`) — shows its
  value and label as `••••` and no `customerId`, and the `q` search never
  finds it by what it holds; `POST /fraud/blocklist` does not name a hidden
  customer;
- the transfer of an order paid by InstaPay / a wallet
  (`GET /manual-payments/orders/:id` and the approve / reject answers): the
  payer's number hidden, no screenshot link;
- the store's activity log `GET /audit-logs`: a row about a locked order, a
  hidden customer or a lost checkout while lost checkouts are hidden shows its
  before / after as `••••`; a row about a gift card or a shipment of a locked
  order, or a blacklist entry that stands for a hidden customer, shows them
  with the customer's keys as `••••` (the recipient and message; the
  courier's answer and tracking state; the entry's value and label) and the
  rest as it was; with the switch on, a row no staff member wrote (a
  shopper's checkout) comes without its IP. Deleting a lost order no longer
  records its phone, whatever the switch says;
- store credit `GET /store-credit`: a hidden holder's name, phone and e-mail;
  `POST /store-credit/customers/:id/adjust` for a hidden customer is refused
  (402);
- the customers report `GET /analytics/reports/customers` (top customers) and
  its CSV: the name;
- a course's students `GET /courses/:id/students`: the name and phone of a
  student who comes hidden;
- gift cards bought on a locked order (`GET /gift-cards`, one card): the
  recipient's name, e-mail and message; the e-mail search does not find them;
  changing the recipient or sending the card again is refused (402);
- customer referrals `GET /customer-referrals/list`: a hidden referrer's or
  friend's name;
- the order timeline `GET /orders/:id/timeline`: the subject of an e-mail and
  the text of a WhatsApp message sent before it locked;
- the shipment batch preview `POST /shipment-batches/preview`: a locked order
  is listed under `blocked` with `ORDER_LOCKED`, its address unread;
- lost orders `GET /checkout-sessions` (and one, and the export): hidden while
  a new order would be locked (rule (c) alone), recovery link dropped;
- invoices `GET /invoices` (the customer's name) and the invoice PDFs
  (`/orders/:id/invoice.pdf`, `POST /orders/documents/invoices`): billed to
  `••••`;
- the courier manifest `POST /orders/documents/manifest`;
- fraud: `GET /fraud/flagged-orders` (name, phone, IP);
- WhatsApp inbox customer panel: the name and e-mail (the number is the
  conversation's own);
- RFM `GET /rfm/customers`: the name;
- the team's new-order notification (bell, e-mail, WhatsApp alert): the
  customer is not named.

Left out until it opens, then given in full (decided 2026-10-26: the till and
the kitchen wait for the order to open):

- the accepted-orders feed `GET /public/orders/accepted`: a locked order — paid
  online, its fee due — is not listed (`orderLock.visibleSql` in its query);
  once it opens it is listed with everything, and the feed's ETag changes;
- `order.accepted`: sent when the order opens and is accepted (below);
- the kitchen ticket on the order page: its button is off for a locked order.

Refused with 402 `ORDER_LOCKED` (`details.reason` `subscription` | `balance`),
nothing sent:

- booking a courier (`carrierShipmentService.createCarrierShipment`: the order
  page, the bulk `ship`, the shipment batches, the automatic booking on
  `order.confirmed` / `order.paid`, the public API) and a manual shipment
  (`POST /orders/:id/shipments`, a stage move to shipped/delivered, fulfil);
- the waybill (`GET /orders/:id/waybill`, `POST /orders/documents/waybills`);
- Confirm via WhatsApp (`POST /orders/:id/whatsapp-confirm`);
- editing the order's customer, address or notes (`PATCH /orders/:id`), and
  saving its shipment draft (`PUT /orders/:id/shipment-draft`);
- block-and-cancel from the fraud screen (it would list the phone and IP in
  the blocklist); cancelling alone still works;
- lost orders: reveal the phone, the WhatsApp message, convert to an order;
- the feed's receipt for one order (`POST /public/orders/:id/ack`) and the
  kitchen status (`PUT /public/orders/:id/pos-status`); the receipt for many
  (`POST /public/orders/ack`) writes none for a locked order and lists it
  under `locked`;
- sending a stored webhook delivery again
  (`POST /webhooks/deliveries/:id/resend`, and Redeliver
  `POST /webhooks/:id/deliveries/:deliveryId/redeliver`) when the order,
  customer or lost checkout it is about is locked now.

Refused with 422 `VALIDATION_ERROR`, whatever the lock says: a dashboard write
whose name, phone, e-mail, address, notes or shipment draft is `••••` (spaces
around it aside) (`core/utils/refusesHidden`: creating an order,
`PATCH /orders/:id`, a shipment and its draft, the customer and address
edits, a new contact, a lost order converted). A form filled from a hidden
view would otherwise save the placeholder over the real details; a hidden
view shows every hidden field as exactly `••••`, so a text that only
contains it ("Visa •••• 4242") is the merchant's own and saves.

Not tried at all:

- automations: a step that carries the customer's details (`whatsapp_template`,
  `sms`, `email`, `webhook`, `notify_team`) is logged `skipped` for a locked
  order or lost checkout; other steps (`add_tag`, `wait`) run. Asked again
  when a waiting sequence resumes;
- outgoing webhooks: no delivery is queued for a locked order (domain events,
  the order change scanner, "resend to webhook", which names it under
  `locked`); `customer.*` for a hidden customer and `checkout.*` while new
  orders would be locked are not sent. A delivery stored while its subject
  was visible is not sent either once it is locked: a retry that comes due
  stops (`failed`, unscheduled, `lastError` saying so) in
  `webhookDispatcher.attemptDelivery`, before anything is signed.
- the store's e-mails to the customer (`notifications/orderEmailService`):
  none for a locked order — order confirmation, shipped, cancelled, refunded,
  and the digital delivery of an order not paid online — nor the
  abandoned-cart e-mail while lost checkouts are hidden. They go out with the
  store's Reply-To, so an answer would hand the merchant the address. Not sent
  later when the order opens. The digital delivery of an order paid online
  (not cash on delivery, `paid` / `partially_paid`) goes even while it is
  locked: the customer paid for the product.
- when a locked order opens (a renewal, a top-up, the fees paid from the
  dashboard, a fallback to pay per order…), the change scanner sends it on its
  next pass as a change made now: the scanner kept it in `webhook_order_holds`
  and left its snapshot as last sent, so an order never sent gets its
  `order.created` (as if just placed) and one sent before gets one
  `order.status_changed` when its state moved meanwhile, nothing when it did
  not. `order.created`'s event id is per order: never queued twice for an
  endpoint. The other order topics raised while it was locked (confirmed,
  cancelled, paid…) are not replayed; the status change carries where it
  stands now. One exception: an order accepted while it was locked (paid
  online, its fee due) gets its `order.accepted` when it opens, once — its
  event id is per order (`webhookFanout.acceptedOnOpen`). An order that locks between the scanner's lock check and its
  read of the order (its store's last fee spent meanwhile) is held the same
  way, its snapshot not moved on.

Unchanged on purpose (they do not show the details to the merchant):

- the shopper's own order (checkout answer, tracking, account, recovery link);
- the payment gateways (the shopper is paying);
- a gift card's own e-mail when it is issued for a paid order (the shopper
  paid for it);
- the ad platforms' conversion APIs (hashed details);
- the AI order check (Zimos's own risk check);
- the storefront's social proof (first name and city, to shoppers);
- COD settlements (no locked order can be shipped);
- the platform console (its audit log, risk signals, blocklist): Zimos sees
  everything. The store's own activity log is the merchant's, above.

## The dashboard

`GET /workspaces/:id/access` carries `ordersLock` and `storefrontClosed`;
`GET /orders/locked-summary` the count and worth of the locked open orders
(and how many are `due`); `POST /orders/locked/settle` takes the fees due.

## Before turning it on

Do not set `ORDERS_LOCK_ENABLED=true` in production before merchants have a
way to pay Zimos that works for them (online billing, `ONLINE_BILLING_ENABLED`,
or the manual transfer and its review in the console), and it has been
checked. The lock does not read `BILLING_RESTRICTIONS` (decided 2026-10-25):
production runs `warn` by default, and the moment the switch is on every store
more than a day past its trial or period with no recorded payment has its new
and pending orders locked, cannot confirm (402), and stops its webhooks and
customer messages for them. Without a way to pay, such a store cannot open
them again.

## Turning it off again

Off after a time on, nothing is charged for what happened while it was on:

- orders placed while it was on paid no fee when placed (it moved to
  confirmation), and one confirmed after it is off goes through
  `settleOnConfirmation`'s "switch off" answer (`unlocked`, no fee);
- `due` orders stay `due` in the database with no fee taken; they show,
  since nothing is locked while it is off;
- `contact_lock`, the `order_confirm_fee` entries and `webhook_order_holds`
  stay; the holds are released on the next webhook pass (nothing is locked).

Turned on again later, those orders read by the rule as they stand: a `due`
one locks again until its fee is paid.
