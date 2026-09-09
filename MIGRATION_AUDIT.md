# Migration Audit — migrations vs database

**Generated:** 2026-09-09
**Scope:** read-only analysis of `src/db/migrations/*` against **local** `zimos_dev` / `zimos_test`.
**Production was NOT touched.** Nothing in this document runs itself. The one
command you may want to run against production is spelled out, with warnings,
in section 4.

---

## 1. Summary / TL;DR

| Question | Answer |
|---|---|
| How many migration files? | **76** (`001` … `076`) |
| All recorded applied in local `zimos_dev`? | **Yes — 76/76.** `SequelizeMeta` has every file. |
| All recorded applied in local `zimos_test`? | **Yes — 76/76.** |
| Is `076-add-attempts-to-notification-logs.js` recorded as applied in local dev? | **Yes.** And the `notification_logs.attempts` column physically exists in both local DBs (`integer NOT NULL DEFAULT 1`). |
| Does the local schema drift from migrations? | **No.** Local dev/test are fully in sync. The drift you hit is **production-only**. |
| What did you hot-patch on prod? | `ALTER TABLE notification_logs ADD COLUMN attempts integer NOT NULL DEFAULT 1;` — this is **byte-for-byte what migration `076` does** (`Sequelize.INTEGER`, `allowNull:false`, `defaultValue:1`). The column is now correct on prod; only the *bookkeeping* (`SequelizeMeta` row) is missing. |
| Biggest risk when you migrate prod | `db:migrate` will try to **re-run `076`** (because prod's `SequelizeMeta` has no row for it) and fail with `column "attempts" already exists`, aborting the run. Fix = insert the `SequelizeMeta` row first (section 4). |

The migration files themselves are the source of truth and are internally
consistent (verified by a clean `SequelizeMeta` match on two local DBs).

---

## 2. What every migration does (in order)

`*` = migration does a **data backfill** and/or `SET NOT NULL` / `ALTER TYPE`
on an existing table — heavier on a populated production DB, review before running.

| # | File | Adds / changes |
|---|---|---|
| 001 | `001-enable-extensions.js` | `CREATE EXTENSION citext` |
| 002 | `002-create-users.js` | table `users` (email `citext` unique, `password_hash`, `full_name`, `phone`, `status` enum `active/suspended/pending_verification` default `pending_verification`, `email_verified_at`, `last_login_at`, timestamps) + unique idx on `email` |
| 003 | `003-create-workspaces.js` | table `workspaces` (`name`, `slug` unique, `owner_user_id`→users RESTRICT, `status` enum, `default_currency` EGP, `default_locale` ar-EG, `timezone`, `settings` jsonb) |
| 004 | `004-create-roles.js` | table `roles` (`workspace_id`→workspaces CASCADE, `key`, `name`, `is_system`, `permissions` text[]) + unique idx `(workspace_id,key)` |
| 005 | `005-create-memberships.js` | table `memberships` (`workspace_id`, `user_id`→users, `role_id`→roles RESTRICT, `status` enum `active/invited/suspended`, `invited_email`) + unique idx `(workspace_id,user_id)` + idx `(user_id)` |
| 006 | `006-create-sessions.js` | table `sessions` (`user_id`→users CASCADE, `refresh_token_hash` unique, `user_agent`, `ip_address`, `expires_at`, `revoked_at`, `rotated_to_session_id`) |
| 007 | `007-create-audit_logs.js` | table `audit_logs` (`workspace_id` SET NULL, `actor_user_id` SET NULL, `action`, `entity_type`, `entity_id`, `ip_address`, `user_agent`, `before_state`/`after_state`/`metadata` jsonb, `created_at` only) + 3 idx |
| 008 | `008-create-api_keys.js` | table `api_keys` (`workspace_id`, `name`, `key_prefix` unique, `secret_hash`, `scopes` text[], `rate_limit_per_minute` 60, `last_used_at`, `revoked_at`, `created_by_user_id`→users RESTRICT) |
| 009 | `009-create-templates.js` | table `templates` (`name`, `category`, `thumbnail_url`, `is_published`) |
| 010 | `010-create-template_versions.js` | table `template_versions` (`template_id`→templates CASCADE, `version`, `global_styles`/`pages`/`sections` jsonb, `is_active`) + unique idx `(template_id,version)` |
| 011 | `011-create-websites.js` | table `websites` (`workspace_id`, `source_template_version_id`→template_versions SET NULL, `name`, `subdomain` unique, `status` enum `draft/published/suspended`, `global_styles`/`seo` jsonb, `published_revision_id` — FK added in 058) |
| 012 | `012-create-website_pages.js` | table `website_pages` (`workspace_id`, `website_id`→websites CASCADE, `path`, `title`, `page_type` enum, `draft_data`/`published_data`/`seo` jsonb) + unique idx `(website_id,path)` |
| 013 | `013-create-website_revisions.js` | table `website_revisions` (`workspace_id`, `website_id`→websites, `snapshot` jsonb, `published_by_user_id`→users RESTRICT, `note`) |
| 014 | `014-create-domains.js` | table `domains` (`workspace_id`, `website_id`→websites, `hostname` unique, `verification_token`, `status` enum `pending_verification/verified/active/failed`, `is_primary`, `verified_at`) |
| 015 | `015-create-funnels.js` | table `funnels` (`workspace_id`, `name`, `subdomain` unique nullable, `status` enum `draft/published/paused`, `published_revision_id` — FK added in 058/062) |
| 016 | `016-create-funnel_steps.js` | table `funnel_steps` (`workspace_id`, `funnel_id`→funnels CASCADE, `key`, `step_type` enum, `name`, `builder_data`/`seo` jsonb, `offer_id`, `ab_test_experiment_id`) + unique idx `(funnel_id,key)` |
| 017 | `017-create-funnel_edges.js` | table `funnel_edges` (`workspace_id`, `funnel_id`→funnels, `from_step_key`, …) + idx `(funnel_id,from_step_key)` |
| 018 | `018-create-products.js` | table `products` (`workspace_id`, `slug`, `status`, …) + unique idx `(workspace_id,slug)` + idx `(workspace_id,status)` |
| 019 | `019-create-product_variants.js` | table `product_variants` (`workspace_id`, `product_id`→products, `sku`, price, `stock_on_hand`, `reserved_stock`, `version`, …). Partial unique `(workspace_id,sku)` added in 058 |
| 020 | `020-create-offers.js` | table `offers` (`workspace_id`, `product_id`, …) |
| 021 | `021-create-offer_variants.js` | table `offer_variants` (`offer_id`→offers, `variant_id`→product_variants) |
| 022 | `022-create-collections.js` | table `collections` (`workspace_id`, `slug`) + unique idx `(workspace_id,slug)` |
| 023 | `023-create-product_collections.js` | join table `product_collections` (`product_id`,`collection_id`) + unique idx `(product_id,collection_id)` |
| 024 | `024-create-inventory_movements.js` | table `inventory_movements` (`workspace_id`, `variant_id`, `reference_type`, `reference_id`, …) + 2 idx |
| 025 | `025-create-customers.js` | table `customers` (`workspace_id`, `phone_normalized`, `is_blacklisted`, …) + unique idx `(workspace_id,phone_normalized)` |
| 026 | `026-create-customer_addresses.js` | table `customer_addresses` (`workspace_id`, `customer_id`, …) |
| 027 | `027-create-carts.js` | table `carts` (`workspace_id`, `guest_token`, `customer_id`, …) + 2 idx |
| 028 | `028-create-cart_items.js` | table `cart_items` (`cart_id`→carts, …) |
| 029 | `029-create-checkout_sessions.js` | table `checkout_sessions` (`workspace_id`, `cart_id`, `status`, `converted_order_id` — FK added in 058) |
| 030 | `030-create-orders.js` | table `orders` (`workspace_id`, `order_number`, `idempotency_key`, `customer_id`, `confirmation_state`/`financial_state`/`fulfillment_state`, totals, `linked_from_order_id` — self-FK added in 058) + 6 idx incl. unique `(workspace_id,order_number)` and unique `(workspace_id,idempotency_key)` |
| 031 | `031-create-order_items.js` | table `order_items` (`order_id`→orders, …) |
| 032 | `032-create-funnel_sessions.js` | table `funnel_sessions` (`funnel_id`, `visitor_id`, …) |
| 033 | `033-create-idempotency_keys.js` | table `idempotency_keys` (`workspace_id`, `scope`, `key`, …) + unique idx `(workspace_id,scope,key)` |
| 034 | `034-create-confirmation_tasks.js` | table `confirmation_tasks` (`workspace_id`, `order_id`, `status`, …) |
| 035 | `035-create-confirmation_attempts.js` | table `confirmation_attempts` (`task_id`→confirmation_tasks, …) |
| 036 | `036-create-shipping_zones.js` | table `shipping_zones` (`workspace_id`, …) |
| 037 | `037-create-shipping_rates.js` | table `shipping_rates` (`zone_id`→shipping_zones, …) |
| 038 | `038-create-shipments.js` | table `shipments` (`workspace_id`, `order_id`, …) |
| 039 | `039-create-payments.js` | table `payments` (`workspace_id`, `order_id`, …) |
| 040 | `040-create-refunds.js` | table `refunds` (`workspace_id`, `order_id`, `credit_note_id` — FK added in 058) |
| 041 | `041-create-return_requests.js` | table `return_requests` (`workspace_id`, `order_id`, …) |
| 042 | `042-create-discounts.js` | table `discounts` (`workspace_id`, `code`, `status` enum `active/disabled`, …) + unique idx `(workspace_id,code)` |
| 043 | `043-create-discount_redemptions.js` | table `discount_redemptions` (`discount_id`→discounts, `order_id`, …) |
| 044 | `044-create-tax_rates.js` | table `tax_rates` (`workspace_id`, …) |
| 045 | `045-create-invoice_counters.js` | table `invoice_counters` (`workspace_id`, counter) — no index |
| 046 | `046-create-invoices.js` | table `invoices` (`workspace_id`, `invoice_number`, …) + unique idx `(workspace_id,invoice_number)` |
| 047 | `047-create-credit_notes.js` | table `credit_notes` (`workspace_id`, `credit_note_number`, …) + unique idx `(workspace_id,credit_note_number)` |
| 048 | `048-create-analytics_events.js` | table `analytics_events` (`workspace_id`, `event_name`, `dedupe_id`, `created_at`, …) + idx `(workspace_id,event_name,created_at)`. Partial unique `(workspace_id,dedupe_id)` added in 058 |
| 049 | `049-create-experiments.js` | table `experiments` (`workspace_id`, `subject_type`, `subject_id`, …) |
| 050 | `050-create-experiment_assignments.js` | table `experiment_assignments` (`experiment_id`→experiments, `visitor_id`) + unique idx `(experiment_id,visitor_id)` |
| 051 | `051-create-plans.js` | table `plans` |
| 052 | `052-create-subscriptions.js` | table `subscriptions` (`workspace_id`, `plan_id` NOT NULL — relaxed in 064, …) + unique idx `(workspace_id)` |
| 053 | `053-create-billing_invoices.js` | table `billing_invoices` (`workspace_id`, `subscription_id`, …) |
| 054 | `054-create-webhook_endpoints.js` | table `webhook_endpoints` (`workspace_id`, …) |
| 055 | `055-create-webhook_deliveries.js` | table `webhook_deliveries` (`endpoint_id`→webhook_endpoints, `event_id`, …) + unique idx `(endpoint_id,event_id)` |
| 056 | `056-create-notification_logs.js` | table `notification_logs` (`id`, `workspace_id`→workspaces CASCADE nullable, `channel` enum `email/sms/whatsapp`, `provider`, `recipient`, `template`, `status` enum `sent/failed`, `error`, `created_at` only). **No `attempts` column — that comes in 076.** |
| 057 | `057-create-automation_rules.js` | table `automation_rules` (`workspace_id`, `trigger`, …) |
| 058 | `058-deferred-constraints.js` | 5 deferred FKs: `orders.linked_from_order_id`→orders, `websites.published_revision_id`→website_revisions, `funnels.published_revision_id`→website_revisions, `refunds.credit_note_id`→credit_notes, `checkout_sessions.converted_order_id`→orders. + 2 partial unique indexes: `product_variants (workspace_id,sku) WHERE sku IS NOT NULL`, `analytics_events (workspace_id,dedupe_id) WHERE dedupe_id IS NOT NULL` |
| 059 | `059-create-verification_tokens.js` | table `verification_tokens` (`id`, `user_id`→users CASCADE, `type` enum `email_verification/password_reset`, `token_hash(64)` unique, `expires_at`, `used_at`, timestamps) + idx `(user_id,type)` — **backs the email-verify + password-reset flows** |
| 060 | `060-create-website_page_redirects.js` | table `website_page_redirects` (`workspace_id`, `website_id`, `from_path`, …) + unique idx `(website_id,from_path)` |
| 061 * | `061-add-revision-number-to-website_revisions.js` | add `website_revisions.revision_number` int: add nullable → **backfill** by `created_at` order per website → `SET NOT NULL` → unique idx `(website_id,revision_number)` |
| 062 | `062-create-funnel_revisions.js` | table `funnel_revisions` (`funnel_id`→funnels, `revision_number`, `snapshot`, …) + unique idx `(funnel_id,revision_number)`; re-points `funnels.published_revision_id` FK to `funnel_revisions` |
| 063 | `063-add-status-to-funnel_sessions.js` | add `funnel_sessions.status` enum + `funnel_sessions.completed_at` |
| 064 | `064-billing-scaffold.js` | add `subscriptions.external_subscription_id`, `subscriptions.external_provider`; **drop NOT NULL** on `subscriptions.plan_id`; add `users.platform_admin` boolean default `false` |
| 065 | `065-add-branding-to-workspaces.js` | add `workspaces.logo_url` varchar(1000), `workspaces.tagline` varchar(300) |
| 066 | `066-add-theme-settings-to-workspaces.js` | add `workspaces.theme_settings` jsonb |
| 067 * | `067-add-google-id-to-users.js` | add `users.google_id` varchar(64) + unique idx; **drop NOT NULL** on `users.password_hash` (passwordless Google accounts) |
| 068 * | `068-add-archived-to-discounts-status.js` | `ALTER TYPE "enum_discounts_status" ADD VALUE IF NOT EXISTS 'archived'` |
| 069 * | `069-allow-pending-membership-invites.js` | **drop NOT NULL** on `memberships.user_id`; swap `(workspace_id,user_id)` unique idx for a **partial** one (`WHERE user_id IS NOT NULL`); add partial unique idx `(workspace_id,invited_email) WHERE invited_email IS NOT NULL` |
| 070 | `070-add-cancellation-to-orders.js` | add `orders.cancelled_at`, `orders.cancellation_reason` |
| 071 | `071-create-otp-codes.js` | table `otp_codes` (`id`, `phone`, `purpose`, `code_hash`, `expires_at`, `consumed_at`, `attempts`, …) + idx `(phone,purpose)` + idx `(phone,created_at)` |
| 072 | `072-add-phone-verified-to-users.js` | add `users.phone_verified_at` |
| 073 | `073-create-reviews.js` | table `reviews` (`workspace_id`, `product_id`, `customer_id`, `rating`, `status`, …) + 3 idx |
| 074 * | `074-add-tracking-code-to-shipments.js` | add `shipments.tracking_code` varchar(16): nullable → **backfill** `'zg'+9 digits` for every row → unique idx → `SET NOT NULL` |
| 075 * | `075-add-product-code-to-products.js` | add `products.product_code` varchar(9): nullable → **backfill** unique 9-digit code for every row → unique idx → `SET NOT NULL` |
| 076 | `076-add-attempts-to-notification-logs.js` | add `notification_logs.attempts` integer `NOT NULL DEFAULT 1` — **← the column you hot-patched on production** |

---

## 3. Local `SequelizeMeta` state (fact-check)

Ran read-only against both local DBs:

```
zimos_dev  SequelizeMeta : 76 rows  (001 … 076, no gaps)
zimos_test SequelizeMeta : 76 rows  (001 … 076, no gaps)
```

Physical column check (both local DBs):

```
notification_logs.attempts  -> present, integer, NOT NULL, default 1   [076 recorded applied]
products.product_code       -> present                                 [075 recorded applied]
shipments.tracking_code     -> present                                 [074 recorded applied]
users.google_id             -> present                                 [067 recorded applied]
```

**Conclusion:** local dev and test are fully migrated and drift-free.
`076-add-attempts-to-notification-logs.js` **is** recorded as applied in local
dev's `SequelizeMeta`. Whatever is missing on production is *not* missing here,
so diffing prod has to be done against prod itself — see next section.

---

## 4. What to do against PRODUCTION (you run this, awake, watching)

### Step 4a — READ-ONLY: see exactly what prod is missing

A helper script is included — `scripts/audit-prod-migrations.js`. It only ever
issues `SELECT`s, pins the session to `default_transaction_read_only = on`, and
sets a 15s statement timeout. It prints prod's `SequelizeMeta`, the pending
list, a physical column check, and a tailored recommendation.

```bash
cd Backend
DATABASE_URL="postgresql://USER:PASS@HOST:PORT/DBNAME" DB_SSL=true \
  node scripts/audit-prod-migrations.js
```

(Use the Railway Postgres connection string. Railway URLs usually omit
`?sslmode=require`, hence the explicit `DB_SSL=true`.)

If you'd rather do it by hand, the whole read-only check is just:

```sql
-- what prod thinks it has applied
SELECT name FROM "SequelizeMeta" ORDER BY name;

-- does the hot-patched column physically exist?
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'notification_logs' AND column_name = 'attempts';
```

Then compare the first list against the 76 filenames in section 2.

### Step 4b — reconcile the manual `attempts` hot-patch

You added `notification_logs.attempts` by hand but there's **no `SequelizeMeta`
row** for migration `076`. Add it, so `db:migrate` skips `076` instead of
trying to re-add the column and erroring out:

```sql
-- run against production, ONLY if 4a shows:
--   * notification_logs.attempts  = present
--   * '076-add-attempts-to-notification-logs.js'  = NOT in SequelizeMeta
INSERT INTO "SequelizeMeta" (name)
VALUES ('076-add-attempts-to-notification-logs.js');
```

This is safe: it just records that the change `076` makes is already there.
If 4a shows the column is somehow *not* present on prod, skip this INSERT —
a normal migrate will add it.

### Step 4c — apply everything still pending

After 4b, run sequelize-cli against the **same** production database:

```bash
cd Backend
DATABASE_URL="postgresql://USER:PASS@HOST:PORT/DBNAME" DB_SSL=true NODE_ENV=production \
  npx sequelize-cli db:migrate
```

**What this touches:** it runs, in filename order, every migration in
`src/db/migrations` whose name is not in prod's `SequelizeMeta`, inside a
transaction per migration. With `076` recorded (4b), that should be **nothing
left** — unless 4a reveals prod is behind on earlier migrations too, in which
case it runs those.

**Before you run it:**

- **Take a Postgres snapshot / backup first** (Railway: create a backup of the
  Postgres service).
- Run it during low traffic.
- Look at any pending file flagged `*` in section 2 first. Those are the
  non-trivial ones:
  - `061`, `074`, `075` — backfill every existing row then `SET NOT NULL`
    (slow on big tables; `074` = shipments, `075` = products).
  - `067`, `069` — `DROP NOT NULL` + partial unique index swaps.
  - `068` — `ALTER TYPE … ADD VALUE` on the `discounts.status` enum.
- `db:migrate` is **not** auto-run on deploy (there's no `release`/`start` hook
  wired for it — `package.json`'s `migrate` script is manual), so nothing will
  apply these behind your back.

### Step 4d — verify

```bash
DATABASE_URL="postgresql://USER:PASS@HOST:PORT/DBNAME" DB_SSL=true \
  node scripts/audit-prod-migrations.js
```

Expect: `PENDING … (none)` and every physical check `present`.

---

## 5. Notes / observations (not blocking)

- `notification_logs` has **`created_at` only, no `updated_at`** — intentional;
  `src/db/models/NotificationLog.js` sets `updatedAt: false`. Not drift.
- Migration `076`'s column definition (`Sequelize.INTEGER`, `allowNull:false`,
  `defaultValue:1`) is exactly equivalent to your manual
  `ALTER TABLE notification_logs ADD COLUMN attempts integer NOT NULL DEFAULT 1;`
  so production's column does not need to be altered — only the `SequelizeMeta`
  row is missing.
- `sequelize-cli` reads DB config from `src/config/sequelize-cli.js`, which
  builds the connection from `DATABASE_URL` when set (falling back to `DB_*`
  vars), for both the `development` and `production` env keys. Passing
  `DATABASE_URL` inline as shown above is the intended way to target a specific
  database.
