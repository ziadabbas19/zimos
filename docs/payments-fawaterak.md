# Fawaterak as a store gateway (stage 1: card only)

A merchant connects their own Fawaterak account under Payments → Gateways, and
shoppers pay store orders by card on Fawaterak's card page. The money goes to
the merchant's Fawaterak account. This is separate from Zimos's own Fawaterak
account for subscriptions (`billing-fawaterak.md`); the two share only the
webhook signature check (`billing/fawaterak/signature.js`) and the amount
conversion (`billing/fawaterak/amounts.js`).

Code: `src/modules/payments/gateways/fawaterak.js`, registered in
`gateways/index.js` beside Paymob and Kashier.

## The switch

| Variable | Meaning |
|---|---|
| `PAYMENTS_FAWATERAK_ENABLED` | Off unless exactly `true`. Off: no store sees Fawaterak — not in the dashboard, not at checkout, not through the API (connect answers 404). |
| `PAYMENTS_FAWATERAK_BETA_WORKSPACES` | Store slugs, comma-separated. With the switch on and this set, only those stores see it. Empty: every store. |

`PAYMENTS_ONLINE_ENABLED` and `GATEWAY_CREDENTIALS_KEY` apply as for every
gateway. A payment already started through Fawaterak is still settled
(webhook, return page, sweep, expiry) after the switch is turned off: that
money moved.

## What the merchant gives

From the Fawaterak dashboard (Integrations):

- **Client ID** and **Client secret** (OAuth client credentials): every API
  call. The client works on exactly one host — `staging.fawaterk.com` (a test
  account) or `app.fawaterk.com` (live) — which is how the mode is detected.
- **API key** (the vendor key): only to check the signature of Fawaterak's
  webhooks. It cannot be checked when connecting; a wrong one shows as
  webhooks refused with 401, while payments are still recorded from the return
  page and the sweep.

All three are stored encrypted like Paymob's and Kashier's keys. Connecting
also reads `getTrPaymentmethods`: the account must have Visa / Mastercard
switched on. When that method has `commission_on_customer = 1` (the shopper
pays Fawaterak's fees) the dashboard shows a warning.

## How a payment is believed

1. Checkout: `createTransaction` with the card's `payment_method_id` (the
   shopper never sees Fawry or a wallet), `pay_load` naming our order and
   attempt, `due_date` a little before our attempt expires (Cairo time), and
   our webhook URL ending in `/paid_json` (so the body is JSON).
2. The paid webhook's signature (`transactionHashKey`) covers only the
   transaction id, the intent key and the payment method — not the status,
   the amount or the currency. So a verified webhook is only a signal: the
   server asks `getTransactionData` right away (`webhookConfirmsByInquiry`
   in `paymentEventService.acceptWebhook`) and records what that answer says.
3. The shopper's redirect back carries no signature: the return page asks
   `getTransactionData` too.
4. Paid is `paid = 1`, at the `total` and `currency` Fawaterak reports. A
   different amount or currency is recorded and flagged
   `payment_amount_mismatch`, like any gateway. A `pay_load` naming another
   attempt, or a total that cannot be read, is never recorded as paid.

## Refunds

Stage 1 sends none. A refund of a Fawaterak payment from our dashboard is
refused before anything is written (`422 REFUND_IN_GATEWAY_DASHBOARD`), and
the refund dialog says to refund in the Fawaterak dashboard. Such a refund
does not change the order here yet; a signed refund webhook is acknowledged
and dropped.

## Before turning it on (staging only, never live tests)

1. A Fawaterak staging account with Visa / Mastercard switched on.
2. Set `PAYMENTS_FAWATERAK_ENABLED=true` and
   `PAYMENTS_FAWATERAK_BETA_WORKSPACES=<one test store's slug>`.
3. Connect the staging keys in that store and pay one order from the store
   preview with a Fawaterak test card. Check:
   - the Fawaterak card on Payments → Gateways shows "Last payment update
     received", and the server log has no `Payment webhook with an invalid
     signature` — this confirms
     the API key is the webhook signing key and the digest is lowercase hex;
   - the order is paid at its total (no `payment_amount_mismatch`), which
     confirms `getTransactionData` returns `pay_load` and the total as sent;
   - the webhook was not blocked by Cloudflare (Fawaterak's own advice is a
     WAF skip rule on the webhook path).
4. Leave one card page open past the order's expiry and check whether
   Fawaterak still takes the payment (whether `due_date` closes it is not
   documented). If it does, the order is reopened or flagged
   `paid_after_expiry`.
