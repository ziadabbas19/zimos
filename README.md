# Zimos Backend

Zimos is a multi-tenant SaaS website and funnel builder backend: merchants
register, create a workspace, build a catalog, and take orders (store
checkout, COD or online payment) through a single shared commerce engine.

## Tech stack

Node.js, Express 5, PostgreSQL, Sequelize 6, Joi, JWT, bcryptjs, Helmet, CORS,
express-rate-limit, express-async-handler, Jest + Supertest for tests.

## Architecture

**Modular monolith**, not microservices — one deployable process, but strict
module boundaries under `src/modules/<domain>/`, each with its own
`*Service.js` (business logic + transactions), `*Controller.js` (HTTP glue),
`*Routes.js` (Express router), and `*Validation.js` (Joi schemas). Domains
never reach into each other's internals — they call each other's service
functions (e.g. `orderService` calls `inventoryService.reserve(...)`).

```
src/
  app.js, server.js        Express app assembly / process entrypoint
  config/                  env loading, sequelize-cli config
  core/
    errors/                AppError + subclasses, stable error codes
    middleware/             authenticate, tenantContext (tenant isolation),
                            rbac, idempotency, validate, rateLimiters, errorHandler
    security/               password hashing, JWT/refresh-token utils, permission catalog
    utils/                  money (integer minor units), phone normalization,
                            scopedRepository (forces workspace_id filtering), logger
  db/
    connection.js           Sequelize instance
    models/                 one file per model, auto-loaded + associated
    migrations/             hand-generated-from-models, dependency ordered
    seeders/                demo data
  modules/
    auth/                   register, login, Google OAuth, refresh rotation, sessions, password reset
    workspaces/              workspace + membership + role CRUD, system-role seeding
    catalog/                 products, variants, offers, collections (full CRUD, archive-on-delete)
    inventory/               transactional, row-locked stock reserve/release/commit
    customers/                phone-first customer identity, blacklist, addresses, contact-detail edit
    orders/                   the shared commerce engine: pricing, order creation, state,
                              cancel, address-only edit, manual shipments + zg tracking codes, waybill PDF
    returns/                  open on a delivered order, moderate, restock as a separate step
    reviews/                  purchase-gated product reviews + staff moderation + public aggregate
    cod/                      confirmation task queue with pessimistic locking
    payments/                 provider-abstracted capture/refund (mock + COD adapters)
    discounts/                code validation + atomic redemption + admin CRUD
    shipping/                 zone/rate pricing + zone/rate CRUD
    tax/                      tax calculation + tax-rate CRUD
    invoices/                 atomic counter-based invoice numbering, credit notes
    otp/                      generic SMS one-time codes (hash-only, rate-limited)
    media/                    image upload (local disk or Cloudflare R2), content-validated type
    waybill/                  order shipping-label PDF (pdfkit + Code128 barcode)
    audit/                    append-only audit log writer
    notifications/            provider-abstracted email/sms/whatsapp — console default,
                              real Brevo (email) + Twilio (SMS) adapters wired
    pages/                    website page engine: JSON tree, draft/publish/revisions
    funnels/                  funnel engine: step graph, conditional routing runtime
    quickstart/               flat forms → EJS multi-product storefront + branding
    billing/                  internal subscription state + stubbed gateway webhook
    domains/                  custom domain record + DNS-TXT verification (no TLS)
views/                        EJS templates for the storefront viewer + admin dashboard
tests/
  helpers/                   supertest app wrapper, DB truncation, test factories
  integration/                auth, tenant isolation, inventory concurrency,
                              idempotency, RBAC, discount-usage concurrency
```

### Multi-tenancy

Every workspace-owned table carries a `workspace_id` column. The
`resolveTenant` middleware (`src/core/middleware/tenantContext.js`) is the
single choke point: it looks up an **active Membership row** for
`(authenticated user, :workspaceId route param)` and attaches
`req.tenant.workspaceId` — the only workspace ID any downstream service
trusts. A user who isn't a member of a workspace gets an identical 404
whether that workspace exists or not, which prevents ID enumeration.
Service functions use `scoped(Model, workspaceId)`
(`src/core/utils/scopedRepository.js`) so every query is forcibly filtered.
See `tests/integration/tenantIsolation.test.js` for the proof.

### Inventory concurrency

All stock mutations go through `modules/inventory/inventoryService.js`, which
takes a `SELECT ... FOR UPDATE` row lock on the variant inside a transaction
before checking/writing — never unsafe read-check-write. See
`tests/integration/inventoryConcurrency.test.js` for concurrent-reservation
and overselling-prevention proof.

### Idempotent order creation

`POST /orders` requires an `Idempotency-Key` header
(`src/core/middleware/idempotency.js`). The key is inserted into
`idempotency_keys` under a unique constraint *before* the handler runs; a
losing concurrent request waits for and replays the winner's response
instead of re-executing. See `tests/integration/idempotency.test.js`.

### Money

All monetary amounts are **integers in minor currency units** (piastres/cents),
stored as `BIGINT`. `src/core/utils/money.js` is the only place arithmetic on
them happens; floating point is never used for money anywhere in the codebase.
Note: PostgreSQL/node-postgres returns `BIGINT` columns as JS strings (values
can exceed the safe-integer range) — `money.js` coerces this on the way in.

## Running locally

```bash
npm install
cp .env.example .env        # edit JWT secrets etc. for anything beyond local dev
createdb zimos_dev
createdb zimos_test  # only needed to run the test suite
npm run migrate
npx sequelize-cli db:seed:all   # optional demo data (demo@zimos.test / DemoPassw0rd!123)
npm run dev                 # local development — nodemon restarts on any change under src/
```

For local development use `npm run dev`: it runs the server under **nodemon**
(config in `nodemon.json`), which watches `src/` (`.js`, `.json`, `.ejs`) and
restarts on every change. `npm start` remains the plain, no-watch
production-style start command (`node src/server.js`).

Health checks: `GET /health` (liveness), `GET /health/ready` (DB connectivity).

### Storefront on a subdomain (local testing)

Each workspace's storefront is reachable at `/shop/:workspaceId`. It is also
reachable at `<workspace-slug>.${PLATFORM_ROOT_DOMAIN}` — a `Host` header that
matches is internally routed to that store (no redirect; the URL bar stays
put). See `src/core/middleware/hostResolver.js`.

To try it locally, map a fake subdomain to `127.0.0.1` in your hosts file
(`C:\Windows\System32\drivers\etc\hosts` on Windows, `/etc/hosts` on
Mac/Linux), using whatever `PLATFORM_ROOT_DOMAIN` is in your `.env` (default
`zimos.test`):

```
127.0.0.1  demo-store.zimos.test
```

Then open `http://demo-store.zimos.test:4000/` — you get that
workspace's store home. Any host that does not match (plain `localhost`, an
IP, an unknown name) falls through to the normal path-based routes untouched.

**Going live** with a real platform domain (e.g. `mystores.com`): set
`PLATFORM_ROOT_DOMAIN=mystores.com` in `.env` and add a wildcard DNS record
(`*.mystores.com` → your server) at your registrar. **No code changes.**

### Connecting your own domain

A merchant who already owns a domain (e.g. `ahmedstore.com`) can point it at
their store. **We do not manage SSL certificates** — Cloudflare (free) sits in
front of the domain and handles the padlock. Merchant steps:

1. **Add the domain in your dashboard** — `POST /api/v1/workspaces/:workspaceId/domains`
   with `{ "hostname": "ahmedstore.com" }`. You get back a TXT record to add.
2. **Create a free Cloudflare account** and add your domain there.
3. **Add the TXT record** we gave you (`zimos-verify=<token>` at the
   domain root) in Cloudflare's DNS, plus an A/CNAME record pointing the domain
   at this server.
4. **Point your domain's nameservers to Cloudflare** (Cloudflare shows you the
   two nameservers; set them at your registrar).
5. **Verify** — `POST /api/v1/workspaces/:workspaceId/domains/:domainId/verify`.
   Once the TXT record is visible, the domain flips to `verified` and your
   store is served on it. Cloudflare handles TLS automatically — we never touch
   certificates.

Until a domain is verified, requests to it show a plain "domain not verified
yet" page rather than a broken store.

### Docker

```bash
docker compose up --build
```
Runs Postgres + the API, running migrations automatically on boot. Seed data
is not applied automatically — run
`docker compose exec api npx sequelize-cli db:seed:all` if you want it.

### Tests

```bash
createdb zimos_test
NODE_ENV=test npx sequelize-cli db:migrate
npm test
```

204 integration tests across 27 suites, run against a real PostgreSQL instance
(no mocking of the database): authentication, Google OAuth login (5 tests:
new-user create, repeat login, link-by-email, consent denial), tenant
isolation (11 tests
proving cross-workspace access is impossible even with valid resource IDs),
inventory concurrency (proving no overselling under simultaneous requests),
idempotent order creation (double-click/retry-storm proof), RBAC, discount
usage-limit concurrency, storefront, the website page engine (13 tests
covering the draft/publish/revision lifecycle, raw-HTML rejection, the
public render endpoint, and slug redirects), the funnel engine (23 tests
covering funnel/step/edge CRUD, pre-publish graph validation,
draft/publish/revision/rollback, and the public graph-walking runtime with
conditional routing and upsell→linked-order creation), the quickstart
server-rendered storefront (8 tests: fill a form → published page →
end-to-end order), subscription scaffolding (7 tests: trial defaults,
webhook status mapping, subscription-gated mutations vs still-serving public
pages, platform-admin overview), store branding + multi-product
storefront + subdomain routing (5 tests), custom domains
(6 tests: add → pending, TXT verification, verified/unverified Host routing),
and the storefront JSON API (5 tests: `themeSettings` round-trip through the
update + public read endpoints, multi-product listing).

Also covered: CRUD completeness across catalog / discounts / shipping / tax /
team / customers with soft-vs-hard delete rules, direct order cancellation
plus address-only editing and manual shipments, returns with a separate
restock step, the Brevo email and Twilio SMS adapters (both mocked in the
suite), the SMS OTP module and phone-verify / SMS password-reset flows, the
order waybill PDF, local image upload with content-sniffed type validation,
purchase-gated product reviews, `zg`-prefixed shipment tracking codes tested
under concurrent creation, "Buy Now" cartless checkout, and an integrity
pass that checks audit-log coverage and that catalog edits never alter an
existing order's snapshot.

## What's deeply implemented vs. scaffolded

**Deep, fully tested**: auth (email/password, Google OAuth, phone
verification + password reset by SMS), multi-tenancy/RBAC, audit logging,
catalog (full CRUD for product/variant/offer/collection, with archive-on-
delete wherever order history could reference the row), transactional
inventory, customers (incl. contact-detail edit), order creation
(pricing/inventory reservation/snapshots/idempotency) plus direct
cancellation, address-only editing, manual shipments and `zg`-prefixed
tracking codes, independent order state machines, COD confirmation with task
locking, returns (open on a delivered order, moderate, then restock as a
separate explicit step), payments/refunds (provider-abstracted), discounts
(full CRUD), tax and shipping zones/rates (full CRUD), invoice numbering,
transactional email via the real **Brevo** adapter and SMS via the real
**Twilio** adapter (both behind the `EMAIL_PROVIDER` / `SMS_PROVIDER`
abstraction, `console` by default), a generic reusable **SMS OTP** module,
**local image upload** (disk-backed, content-sniffed type check), the order
**waybill PDF** (pdfkit + Code128 barcode), **product reviews** (gated on a
delivered purchase, staff-moderated, aggregated onto the public product
endpoint), "**Buy Now**" cartless checkout, the **website page engine**, and
the **funnel engine**.

The page engine (`src/modules/pages/`, `tests/integration/pageEngine.test.js`
— 13 tests) covers: websites and their pages as workspace-scoped staff
tooling; every page stored as a structured JSON tree (section → row →
column → element), with raw-HTML strings and unknown element types rejected
at validation; an absolute draft/publish split — staff edits only ever
write the draft columns, and the storefront renders *only* the frozen
snapshot of the website's current published revision, so no edit, rename or
delete can change a live page until the next publish; numbered
`WebsiteRevision` history with a full live-snapshot per publish, a revisions
list, and rollback (rollback just repoints the published revision — it is
not a publish and leaves drafts and history untouched); a public
render-data endpoint `GET /api/v1/store/:workspaceId/pages/:slug?` with no
staff auth, OG defaults, and a 404 for any page not in the live revision;
and slug-change 301 redirects, recorded when a published page is renamed and
activated on the next publish (draft-only renames record none).

The funnel engine (`src/modules/funnels/`,
`tests/integration/funnelEngine.test.js` — 23 tests) applies the same
discipline to funnels as a directed graph of steps: funnel / step / edge
CRUD as workspace-scoped staff tooling; each step's content is a page tree
(same structured shape and raw-HTML rejection as the page engine);
pre-publish graph validation (exactly one entry step, every step reachable,
no dangling edges, offer required for `upsell`/`downsell` steps, no empty
step trees — all problems collected and returned at once); numbered
immutable `FunnelRevision` snapshots with rollback and pause/resume; and a
public, anonymous runtime (`POST /api/v1/store/:workspaceId/funnels/:ref/sessions`,
`.../sessions/:id/step`, `.../sessions/:id/advance`) that walks a visitor
through the frozen published snapshot, picking each next step by evaluating
per-edge conditions (`always` / `completed_checkout` / `accepted_offer` /
`declined_offer`) against the step outcome, ordered by edge priority. An
accepted `upsell`/`downsell` creates a follow-on order through the shared
`orderService` (server-side pricing, transactional inventory, idempotency),
linked to the original via `orders.linked_from_order_id`; a
`completed_checkout` outcome back-fills `orders.funnel_id`.

**The real merchant-facing storefront is a separate React frontend** that
fetches from the public JSON API (`GET /api/v1/store/:workspaceId` for
branding + the opaque `themeSettings` blob, `GET /api/v1/store/:workspaceId/products`
for the catalog) and renders its own template layouts. The built-in EJS
quickstart/shop flow (`src/modules/quickstart/`, `src/views/`) is kept as a
lightweight demo/fallback only — it is not the product surface going forward.

**Simplified / scaffolded (speed-first — see `PHASE_PLAN.md`)**: the
quickstart EJS viewer is a deliberately minimal single-design layer (flat
forms → published page), not a page builder; platform subscriptions/billing
exist as internal state only — every workspace gets a `trialing` Subscription
on creation, a webhook endpoint maps generic events to status, and mutations
are subscription-gated, but **no payment gateway is connected** (see
"Payment gateway integration — NOT YET CONNECTED" below). `platformAdmin` is
a single boolean flag on `User`, not a role system.

**Modeled and migrated, with working CRUD services, but not yet as deep or
covered by the test suite**: website theme templates + template versioning,
A/B testing (experiment models exist; funnel-step and
page split-test *execution* is not wired up), analytics/tracking event
ingestion + reporting endpoints, webhooks (model + HMAC signing utility
exist; delivery worker with retry/backoff is not implemented),
automations (event→condition→action model exists; no action runners yet),
abandoned-checkout recovery, background job processing (no queue is wired up
— everything currently runs inline in the request, including outbound
email/SMS).

## Environment variables

See `.env.example` for the full list with comments. Nothing in it is a real
credential.

**Database:** local dev/test use the separate `DB_HOST` / `DB_PORT` /
`DB_NAME` / `DB_USER` / `DB_PASSWORD` vars. A managed host (Railway, Heroku,
…) instead provides a single `DATABASE_URL` connection string
(`postgresql://user:pass@host:port/dbname`); when it's set, both the app
(`src/config/env.js`) and the migration CLI (`src/config/sequelize-cli.js`)
parse it and ignore the separate vars — `?sslmode=require` in the URL (or
`DB_SSL=true`) turns on TLS. `NODE_ENV=test` always uses `DB_NAME_TEST`
regardless of `DATABASE_URL`, so a deploy's URL can never point the suite at
a live database.

`EMAIL_PROVIDER`/`SMS_PROVIDER`/`WHATSAPP_PROVIDER` default to
`console`, which logs+persists to `notification_logs` instead of sending.
Real adapters are wired: set `EMAIL_PROVIDER=brevo` with `BREVO_API_KEY` +
`EMAIL_FROM_ADDRESS` (transactional email via `api.brevo.com`, no SDK), or
`SMS_PROVIDER=twilio` with `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` /
`TWILIO_FROM_NUMBER`. Both adapters (`src/modules/notifications/brevoEmail
Provider.js`, `twilioSmsProvider.js`) are mockable seams and are never
called by the test suite. Each provider call retries a transient failure
(network error / 429 / 5xx) up to 3 times with backoff (immediate, ~1s,
~3s — `src/core/utils/retry.js`); a permanent 4xx is not retried. Sends stay
inline in the request (no queue yet); if every attempt fails the send is
recorded in `notification_logs` as `failed` with its `attempts` count and
the triggering request still succeeds. Same provider pattern for
`PAYMENTS_DEFAULT_PROVIDER` (`src/modules/payments/providers/`).

### Image storage

`STORAGE_PROVIDER` selects where `POST /api/v1/workspaces/:workspaceId/media`
puts uploaded images: `local` (default) writes to `public/uploads/` and
serves them at `/uploads/...`; `r2` puts them in a Cloudflare R2 bucket
(`src/modules/media/storage/`). **Use `r2` in production** — a container
filesystem is wiped on every redeploy, so `local` there loses every
merchant's images. The response shape (`{ url, path, mimeType, size }`) and
the 5MB / content-sniffed-type validation are identical either way; only the
returned `url` host differs.

#### Cloudflare R2 setup (do this once in the Cloudflare dashboard)

1. **Create the bucket.** Cloudflare dashboard → **R2** → **Create bucket**.
   Give it a name (e.g. `zimos-media`), pick a location hint near your
   users, create it. That name is `R2_BUCKET_NAME`.
2. **Enable public access.** Open the bucket → **Settings** → under **Public
   access** either enable the **r2.dev subdomain** (fine to start) or connect
   a **custom domain** (e.g. `cdn.yourdomain.com`, needs the domain on
   Cloudflare). Copy the resulting public base URL — that is `R2_PUBLIC_URL`
   (no trailing slash, e.g. `https://pub-abc123.r2.dev`).
3. **Get your account ID.** On the R2 overview page (right-hand sidebar, or
   any bucket's settings) copy **Account ID** → `R2_ACCOUNT_ID`.
4. **Create an API token.** R2 overview → **Manage R2 API Tokens** → **Create
   API token**. Permissions: **Object Read & Write**; scope it to just the
   one bucket. Create it, then copy the **Access Key ID** → `R2_ACCESS_KEY_ID`
   and **Secret Access Key** → `R2_SECRET_ACCESS_KEY` (the secret is shown
   only once).
5. **Set the env vars** on the host: `STORAGE_PROVIDER=r2` plus the five
   `R2_*` values above. Restart. Existing images already on local disk are
   not migrated automatically — re-upload them or copy `public/uploads/` into
   the bucket with the same keys (`<workspaceId>/<filename>`).

### SMS one-time codes

`src/modules/otp/` is a generic OTP layer — `generateAndSendOtp(phone,
purpose)` / `verifyOtp(phone, purpose, code)`. Codes are 6 digits, stored
only as a sha256 hash, valid 5 minutes, capped at 5 wrong guesses per code
and 3 sends per phone per 10 minutes. Two flows use it: phone verification
right after registration (`POST /api/v1/auth/verify-phone/request` +
`/confirm`, accepted for a still-`pending_verification` account) and
password reset by SMS (`POST /api/v1/auth/password-reset/sms/request` +
`/confirm`, enumeration-safe, only for a verified phone).

### Google OAuth login

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI`
(`http://localhost:4000/api/v1/auth/google/callback` locally — must match an
Authorized redirect URI in the Google Cloud console) plus `FRONTEND_URL`
(default `http://localhost:5173`). Then:

- `GET /api/v1/auth/google` → 302 to Google's consent screen.
- `GET /api/v1/auth/google/callback` → Google redirects here; the server
  exchanges the code for the profile and logs the user in — matching an
  existing account by `googleId`, else by email (linking Google to it), else
  creating a new `active`, email-verified, passwordless user — then 302s to
  `${FRONTEND_URL}/auth/callback?accessToken=…&refreshToken=…` (or `?error=…`).

The tokens are the same access + refresh pair the email/password login issues.
`google-auth-library` handles the OAuth token exchange.

## Payment gateway integration — NOT YET CONNECTED

The subscription/billing scaffolding runs with **no gateway wired in**.
Everything works on internal state (workspaces trial for 14 days, the webhook
maps events to `Subscription.status`, mutations are subscription-gated). To go
live with a real provider (Paymob, Stripe, Fawry, …), only these need real
implementations — the rest of the flow is unchanged:

1. **`src/modules/billing/gatewaySignature.js` → `verifyGatewaySignature(payload, headers)`**
   — currently returns `true` for every request with a loud warning. Implement
   the chosen provider's webhook signature / HMAC check here.
2. **`src/modules/billing/billingService.js` → `EVENT_STATUS_MAP`** — maps
   generic event names (`subscription.activated`, `payment.failed`,
   `subscription.canceled`) to our `Subscription.status`. Replace the keys
   with the provider's real webhook event names.
3. **Subscription creation** — `billingService.ensureSubscriptionForWorkspace`
   only creates the internal `trialing` row. When a merchant actually pays,
   call the provider's subscribe/checkout API and store the returned ids on
   `Subscription.externalSubscriptionId` / `externalProvider` (columns already
   exist). `expireStaleTrials()` already skips rows that have an
   `externalSubscriptionId`.

Not built (out of scope for now): card storage, prorated upgrades/downgrades,
BillingInvoice/PDF generation, annual billing, self-service plan-change UI,
real payment-retry scheduling.

## External credentials still required for production

- A real SMTP/email provider (or Twilio, Meta WhatsApp Business API, etc.)
  for `notifications`
- A real payment gateway (Paymob, Fawry, Stripe, etc.) implementing the
  4-method adapter interface in `src/modules/payments/providers/`
- A shipping carrier API (Bosta, Aramex, etc.) for `src/modules/shipping/`
  waybill creation (only rate *pricing* is implemented; carrier integration
  is a documented extension point, not yet built)
- Production JWT secrets (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`) —
  generate with e.g. `openssl rand -hex 32`
