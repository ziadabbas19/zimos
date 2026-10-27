# API additions

What this branch adds on top of upstream `main` (as of `0dd31ce`, 2026-10-02),
for review before merging. Everything here is new files except the short list
under "Changes to existing files".

Conventions followed from the existing code: `Router({ mergeParams: true })`,
`authenticate` → `resolveTenant` → `requirePermission(...)`, Joi schemas passed
to `validate({ params, query, body })`, `asyncHandler` controllers, `AppError`
for domain errors, `recordAudit` on every mutation, money in minor units.

## Migrations

Numbered 130–133 so they run after upstream's `129-create-billing-payment-attempts`.

| # | Adds |
|---|---|
| 130 | `low_stock_threshold` on `product_variants` |
| 131 | `workspace_integrations`, `whatsapp_conversations`, `whatsapp_messages` |
| 132 | `automation_runs` |
| 133 | `cod_settlements`, `cod_settlement_lines` |
| 134 | `webhook_order_states`, `webhook_scan_cursors`, and the `updated_at` / due-delivery indexes outbound webhooks scan |

## New endpoints

All workspace routes are under `/api/v1/workspaces/:workspaceId`.

### COD settlements — `/settlements`
Records what a courier actually remitted for delivered COD orders, and turns
that into real payments.

| Method | Path | Notes |
|---|---|---|
| GET | `/settlements/summary` | due from couriers, received, fees, draft count |
| GET | `/settlements/unsettled` | delivered COD orders not on any settlement, grouped by carrier |
| GET | `/settlements` | `?status&limit&before` |
| GET | `/settlements/:settlementId` | with its order lines |
| POST | `/settlements` | `{ carrierCode, reference?, periodStart?, periodEnd?, notes?, lines:[{orderId, collectedAmount?, feeAmount}] }` |
| PATCH | `/settlements/:settlementId` | draft only |
| DELETE | `/settlements/:settlementId` | draft only |
| POST | `/settlements/:settlementId/confirm` | writes a captured `cod` payment per line, updates `amountPaid` and the financial state, then locks the settlement |

Reads need `financial_reports.view`, writes need `refunds.manage`. An order can
appear on only one settlement (unique index on `workspace_id, order_id`).
Errors: `ORDER_NOT_SETTLEABLE`, `COLLECTED_EXCEEDS_DUE`, `DUPLICATE_ORDER` (422),
`SETTLEMENT_CONFIRMED` (409), `SETTLEMENT_EMPTY` (422).

### Order automations — `/automations`
| Method | Path | Notes |
|---|---|---|
| GET/POST | `/automations` | rule list and create |
| PATCH/DELETE | `/automations/:ruleId` | |
| GET | `/automations/runs` | what fired, what was skipped, and why |

Triggers: `order.created`, `order.confirmed`, `order.rejected`,
`order.cancelled`, `order.shipped`, `order.out_for_delivery`,
`order.delivered`. Action: `whatsapp_template`. Tokens: `{{customer_name}}`,
`{{order_number}}`, `{{order_total}}`, `{{store_name}}`, `{{tracking_url}}`,
`{{city}}`. The engine is fired from `transaction.afterCommit` and never throws
into the request — a failed run is recorded, not raised.

### WhatsApp Cloud API — `/whatsapp`
| Method | Path | Notes |
|---|---|---|
| GET/PUT/DELETE | `/whatsapp/integration` | credentials are AES-256-GCM encrypted at rest (`INTEGRATIONS_ENCRYPTION_KEY`) and sealed before the token is checked with Meta; the response only ever returns a masked token. PUT needs the App Secret unless one is saved (422 `WHATSAPP_APP_SECRET_REQUIRED`). GET answers `planLocked`: with `WHATSAPP_REQUIRE_PLAN_FEATURE` and `PLAN_FEATURE_ENFORCEMENT` on, a first connection needs `whatsapp_confirmation` (403 `PLAN_FEATURE_REQUIRED`); a store already connected keeps its number |
| GET | `/whatsapp/conversations` | `?status&search&limit&before` |
| PATCH | `/whatsapp/conversations/:conversationId` | close / reopen |
| GET | `/whatsapp/conversations/:conversationId/messages` | |
| POST | `/whatsapp/messages` | free text inside the 24h window, otherwise an approved template |

Public webhook, outside the workspace mount:
`GET|POST /api/v1/webhooks/whatsapp/:workspaceId` — verified with
`X-Hub-Signature-256` against the app secret, using `req.rawBody`. Only
messages and statuses whose `metadata.phone_number_id` is the store's connected
number are kept; another number's (a second store on the same Meta app) are
logged, counted as `ignored` and answered 200. A message is stored once per
Meta id (unique index, migration 720).

A customer's "Confirm order" or "Cancel" counts only as an answer to the
`order_confirmation` message; a "yes" or "no" to any other message about the
order changes nothing. "Cancel" cancels only a cash-on-delivery order still
waiting for its confirmation; a cancel on an order past that point changes
nothing and notifies the team (`whatsapp/quickReplyConfirmation.js`).

### Server-side ad pixels — `/server-pixels`
| Method | Path | Notes |
|---|---|---|
| GET/PUT/DELETE | `/server-pixels/integration` | the Conversions API tokens for Meta, TikTok and Snapchat and the GA4 API secret, encrypted like the WhatsApp credentials and only ever returned masked |

A `Purchase` is sent server-side when an order is created (never for an order
still waiting for its online payment), with the order id as the event id so the
browser pixel's event dedupes against it. The public pixel IDs live in
`settings.tracking_pixels` (PATCH `/workspaces/:id`), and `GET /store/:workspaceId`
returns them in a read-only `tracking` block.

### API keys, public API and outbound webhooks
Full reference, with a signature-verification snippet, in `docs/public-api.md`.

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/api-keys` | list and create; the key (`zk_…`) is shown once, only its hash is stored. Scopes `orders:read`, `orders:write` |
| DELETE | `/api-keys/:keyId` | revoke |
| GET/POST | `/webhooks` | endpoints and the event catalogue; the signing secret is shown on create and on rotate |
| PATCH/DELETE | `/webhooks/:endpointId` | |
| POST | `/webhooks/:endpointId/rotate-secret`, `/test` | |
| GET | `/webhooks/:endpointId/deliveries` | the delivery log; `POST …/deliveries/:deliveryId/redeliver` resends one |

Public API, authenticated by the key (`Authorization: Bearer zk_…`), outside the workspace mount — `/api/v1/public`: `GET /me`, `GET /orders`, `GET /orders/by-number/:orderNumber`, `GET /orders/:orderId`, `GET /orders/:orderId/shipments`, `POST /orders/:orderId/confirmation`, `POST /orders/:orderId/cancel`, `POST /orders/:orderId/shipments`, `PATCH /orders/:orderId/shipments/:shipmentId`, `POST /orders/:orderId/cod-collected`.

Webhook events: `order.created`, `order.status_changed` (and `webhook.test`). Each request carries `X-Zimos-Signature: t=<unix>,v1=<HMAC-SHA256(secret, t + "." + body)>`. The module observes orders and shipments by `updated_at` instead of hooking each writer, so no order code was changed; `src/server.js` starts the loop (`WEBHOOKS_IN_PROCESS=false` leaves it to `scripts/dispatch-webhooks.js`).

### Orders export — `/orders/export`
| Method | Path | Notes |
|---|---|---|
| GET | `/orders/export/columns` | the columns a file can carry (English and Arabic labels) and the default set per row mode |
| GET | `/orders/export` | the orders list as a CSV file: the list's own `q`, `from`, `to`, `stage`, `sort` and state filters, plus `columns=a,b,c`, `rowPer=order|item`, `lang=en|ar` |

Needs `orders.view`. It pages through `orderService.listOrders`, so the file
and the screen always agree on which orders match; rows are streamed a page at
a time, up to 20,000 orders per file. UTF-8 with a BOM (Excel reads Arabic),
dates on the store's own timezone, amounts as decimals, and cells a spreadsheet
would run as a formula are neutralised. Each export is written to the audit log.

### Merchant records
| Method | Path | Notes |
|---|---|---|
| GET | `/audit-logs` | `?action&entityType&limit&before`, each entry with its actor |
| GET | `/invoices` | `?status&limit&before` |

### Fraud protection — `/fraud` (fraud-hardening)

| Method | Path | Notes |
|---|---|---|
| GET | `/fraud/capabilities` | any team member. `{ botProtection: { platformDefault }, ipIntel: { provider }, captcha: { provider }, visitorGate: { enabled }, networkDeliveryRate: { available }, checkoutOtp: { guard, whatsapp, sms } }`: which rules can act on this platform right now (`fraud/capabilities.js`) |

Behaviour behind flags, each off by default (off = as before):

| Flag | What changes |
|---|---|
| `CHECKOUT_OTP_DELIVERY_GUARD_ENABLED` | `PATCH /workspaces/:id` switching phone codes on, moving them to another channel, or adding a rule whose action is `require_otp` answers 422 `OTP_CHANNEL_UNAVAILABLE` (details `[{ field, message, channel }]`) while that channel cannot deliver. At checkout and at the switch to COD, a code that reached no channel lets the order through with the risk flag and reason `otp_unavailable`; no lost order is filed and the store gets an `integration.failed` notification once a day |
| `COD_SWITCH_RECHECK_ENABLED` | `POST /store/:ws/orders/:id/payment/switch-to-cod` meets each fired rule's own action (`block`, `to_lost` refuse) and asks for a code (428 `OTP_REQUIRED`) when a fired rule's action is `require_otp` or the store sends codes for COD orders (`cod_only`); the code comes back in the same switch as `{ otpCode }` (422 `INVALID_CODE` / `EXPIRED`, 429 `TOO_MANY_ATTEMPTS`) |
| `VISITOR_GATE_ENABLED` | every public store route answers 423 `STORE_UNAVAILABLE` to an IP blocked with scope `visit`, and to a blocked country once an IP lookup answers |
| `IPV6_PREFIX_RULES_ENABLED` | the IP blocklist (orders, codes, visits), `min_minutes_between_cod_orders_per_ip` and the risk score's `ip_burst` compare an IPv6 address by its /64 |
| `SMS_ALLOWED_COUNTRIES` | an SMS to a number outside the list is not sent (logged failed); `POST /auth/verify-phone/request` answers 422 `SMS_COUNTRY_NOT_ALLOWED` before making a code |
| `SMS_PLATFORM_DAILY_CAP`, `SMS_STORE_DAILY_CAP` | past a cap an SMS is not sent (logged failed) and the console gets an `sms_cap` notification once a day per scope (migration 723, `sms_daily_usage`) |
| `VERIFY_PHONE_PER_IP_PER_DAY` | `POST /auth/verify-phone/request` answers 429 `OTP_RATE_LIMITED` past that many codes from one client in 24 hours |

Without a flag: the checkout and the cart refuse more than 1000 units of one
line (422 `VALIDATION_ERROR`), and an automation's `conditions.riskLevel`
takes `moderate` (`medium` is saved as `moderate`; a rule saved with it
matches moderate orders).

### Loyalty points — `/loyalty` (STORE_FEATURES `loyalty`)
| Method | Path | Notes |
|---|---|---|
| GET | `/loyalty` | adds `planLocked` (switching on would be refused) and `frozen` / `frozenReason` (`plan` \| `subscription` \| null) |
| PUT | `/loyalty` | takes `maxRedeemPointsPerOrder` (1–10,000,000 or null = no cap but the percent). With `LOYALTY_REQUIRE_PLAN_FEATURE` and `PLAN_FEATURE_ENFORCEMENT` on, `enabled: true` needs the plan's `loyalty` (403 `PLAN_FEATURE_REQUIRED`); saving it off passes on any plan |
| GET | `/loyalty/customers/:customerId`, `/store/:ws/account/loyalty` | add `frozen`; a frozen balance has `expiresAt: null`, and the shopper's `program` is null |
| GET | `/store/:ws/loyalty` | `program` adds `maxRedeemPointsPerOrder`; null while frozen |
| POST | `/store/:ws/checkout` | `loyaltyPoints` may also be refused 422 `LOYALTY_FROZEN`, and with `LOYALTY_GUARD_ENABLED` 422 `LOYALTY_UNAVAILABLE` (a blocked customer) or `LOYALTY_DEVICE_LIMIT` (the device spent another account's points in the last 24 hours), each on field `loyaltyPoints` |

Frozen (`loyalty/loyaltyAccess.js`): kept and shown, never earned, spent or
expired; inactivity restarts from the last frozen day
(`settings.loyalty.frozenSeenAt`, written by the daily job). An order locked
when delivered (`ORDERS_LOCK_ENABLED`) earns nothing.

### Console: a person's details and the store list — `/admin` (no flag)
Additive fields only, same permission as before (`workspaces.view`: creators and
admins; agents and merchants 403). No secret is ever returned (explicit
attribute lists).

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/users/:userId` | adds `phoneVerified` (from `phone_verified_at`) and `location` — `{ country, governorate, source: 'signup_visit', seenAt }` or null: the country and governorate on the marketing-site visits of the session the account signed up from (`site_visits`, Cloudflare's headers via `ANALYTICS_GEO_HEADERS`, the IP's region, approximate; the governorate only on visits recorded with `SITE_TRAFFIC_DETAILS_ENABLED`). No city is stored anywhere; nothing new is tracked |
| GET | `/admin/users/:userId`, `/admin/users` | each store in `workspaces` adds `createdAt` and `storeUrl` |
| GET | `/admin/workspaces` | each row adds `storeUrl`; `owner` (id, name, email) was already there |

`storeUrl` is the store's canonical address (`domains/primaryHost.js`): its
primary domain when verified, certificate issued and not suspended, else
`https://<slug>.<PLATFORM_ROOT_DOMAIN>`. Looked up for all the stores of a
response in one query (`storeOriginsOf`), so the number of queries does not
grow with the number of stores. `/admin/workspaces` is still one unpaginated
list, as before.

## Changes to existing files

Kept as small as possible — nothing was restyled or refactored.

| File | Change |
|---|---|
| `src/app.js` | requires and mounts for the routers above |
| `src/modules/orders/orderService.js` | `order.created` (automations, server pixels) and `order.cancelled` (automations) after commit |
| `src/modules/orders/shipmentLifecycle.js` | `order.shipped` / `order.out_for_delivery` / `order.delivered` automations when a shipment's status changes |
| `src/modules/cod/confirmationService.js` | `order.confirmed` / `order.rejected` automations after commit |
| `src/modules/storefront/storefrontService.js` | `getStorefront` also returns `tracking` |
| `src/modules/workspaces/workspaceService.js`, `workspaceValidation.js` | `tracking_pixels` in workspace settings |
| `src/modules/media/mediaService.js`, `mediaController.js` | GLB 3D models accepted (15MB ceiling, stored as uploaded) for the `product_3d` page element |
| `src/modules/catalog/catalogValidation.js`, `db/models/ProductVariant.js` | `lowStockThreshold` on variants |

## Dropped in favour of upstream's own implementation

Earlier versions of this branch carried these; upstream now has its own, so
ours were removed rather than merged: Bosta (→ `shipping/carriers`), Paymob
(→ `payments/gateways`), fraud rules (→ `modules/fraud`), abandoned checkouts
(→ `modules/checkoutSessions`), the shipping quote, orders list paging and
counts, web / funnel analytics, the media library list, merchant billing, the
platform-admin overview routes, and the billing webhook signature. The
confirmation call log and per-agent stats were removed with the call centre.

## Environment

```
INTEGRATIONS_ENCRYPTION_KEY=   # encrypts stored WhatsApp and server-pixel credentials; required in production
PUBLIC_API_URL=                # used to build the WhatsApp webhook URL shown in settings
META_GRAPH_API_VERSION=        # optional, defaults to v21.0
# fraud-hardening, all off unless set (see .env.example)
CHECKOUT_OTP_DELIVERY_GUARD_ENABLED=
COD_SWITCH_RECHECK_ENABLED=
VISITOR_GATE_ENABLED=
IPV6_PREFIX_RULES_ENABLED=
SMS_ALLOWED_COUNTRIES=
SMS_PLATFORM_DAILY_CAP=
SMS_STORE_DAILY_CAP=
VERIFY_PHONE_PER_IP_PER_DAY=
```

Without these keys the features report themselves as not connected. Nothing is
stubbed or faked.

## Tests

New suites: `settlements`, `automations`, `whatsapp`, `pixelEvents`,
`trackingPixels`, `merchantRecords`, `lowStockThreshold`, `immersiveBlocks`,
`nicheTemplates`.
