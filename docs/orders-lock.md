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
below the governorate, the notes, the checkout answers, a gift message, the
IP / browser / device, a transfer's payer number and screenshot — are shown to
the merchant when

- (a) the store is entitled now: its subscription is in any phase but
  `restricted` (`workspaceAccessService.billingLifecycle`: more than a day past
  the period end, unpaid), or it is on a fee plan while `WALLET_ENABLED` is off;
- (b) the order was settled when it reached its confirmed stage
  (`contact_lock = 'unlocked'`), or reached it before the column existed
  (`contact_lock` null);
- (c) the order never reached its confirmed stage — pending, or cancelled or
  rejected before it was confirmed — the store pays per order, and it can pay
  the fee now (a free order left, or a balance of at least one fee).

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
  more when confirmed.
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
correction, fee given back, free orders granted), and from the dashboard
(`POST /orders/locked/settle`, e.g. after a fallback to pay per order). No
scheduled job takes it: none moves the balance's money
(`tests/integration/walletNoExpiry.test.js`). A `due` order cancelled since is
left alone.

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
- customers `GET /customers`, `GET /customers/:id` (a customer is hidden when
  every order they placed is locked; a lead with no order is not);
  `PATCH /customers/:id` and the address edits are refused (402);
- contacts `GET /contacts`, `GET /contacts/:id`, the export, and the contact
  search;
- the dashboard search (Ctrl K) `GET /search`: orders and customers;
- the manual order form's lookup `GET /orders/manual/customer`;
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

Refused with 402 `ORDER_LOCKED` (`details.reason` `subscription` | `balance`),
nothing sent:

- booking a courier (`carrierShipmentService.createCarrierShipment`: the order
  page, the bulk `ship`, the shipment batches, the automatic booking on
  `order.confirmed` / `order.paid`, the public API) and a manual shipment
  (`POST /orders/:id/shipments`, a stage move to shipped/delivered, fulfil);
- the waybill (`GET /orders/:id/waybill`, `POST /orders/documents/waybills`);
- Confirm via WhatsApp (`POST /orders/:id/whatsapp-confirm`);
- editing the order's customer, address or notes (`PATCH /orders/:id`);
- block-and-cancel from the fraud screen (it would list the phone and IP in
  the blocklist); cancelling alone still works;
- lost orders: reveal the phone, the WhatsApp message, convert to an order.

Not tried at all:

- automations: a step that carries the customer's details (`whatsapp_template`,
  `sms`, `email`, `webhook`, `notify_team`) is logged `skipped` for a locked
  order or lost checkout; other steps (`add_tag`, `wait`) run. Asked again
  when a waiting sequence resumes;
- outgoing webhooks: no delivery is queued for a locked order (domain events,
  the order change scanner, "resend to webhook", which names it under
  `locked`); `customer.*` for a hidden customer and `checkout.*` while new
  orders would be locked are not sent.
- when a locked order opens (a renewal, a top-up, the fees paid from the
  dashboard, a fallback to pay per order…), the change scanner sends it on its
  next pass as a change made now: the scanner kept it in `webhook_order_holds`
  and left its snapshot as last sent, so an order never sent gets its
  `order.created` (as if just placed) and one sent before gets one
  `order.status_changed` when its state moved meanwhile, nothing when it did
  not. `order.created`'s event id is per order: never queued twice for an
  endpoint. The other order topics raised while it was locked (confirmed,
  cancelled, paid…) are not replayed; the status change carries where it
  stands now.

Unchanged on purpose (they do not show the details to the merchant):

- the shopper's own order (checkout answer, tracking, account, recovery link);
- the payment gateways (the shopper is paying);
- the transactional order e-mails to the shopper (not WhatsApp or SMS);
- the ad platforms' conversion APIs (hashed details);
- the AI order check (Zimos's own risk check);
- the storefront's social proof (first name and city, to shoppers);
- COD settlements (no locked order can be shipped);
- the platform console (audit log, risk signals, blocklist): Zimos sees
  everything.

## The dashboard

`GET /workspaces/:id/access` carries `ordersLock` and `storefrontClosed`;
`GET /orders/locked-summary` the count and worth of the locked open orders
(and how many are `due`); `POST /orders/locked/settle` takes the fees due.
