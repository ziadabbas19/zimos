# Zimos Public API & Webhooks

Connect a store's orders to your own system — a fulfilment partner, a
warehouse, a call centre, a courier, a spreadsheet. Your system **receives**
every new order and every status change as a webhook, **reads** orders
whenever it needs to, and **writes** statuses back: confirmation, shipping,
delivery, returns, cancellation and COD cash collection.

Everything you change goes through exactly the same rules as the merchant's
own dashboard: the same stock movements, the same courier bookings, the same
audit trail.

- [Getting a key](#getting-a-key)
- [Authentication](#authentication)
- [Errors and limits](#errors-and-limits)
- [The order object](#the-order-object)
- [Order statuses](#order-statuses)
- [Endpoints](#endpoints)
- [Webhooks](#webhooks)
- [Verifying a webhook signature](#verifying-a-webhook-signature)
- [A typical fulfilment integration](#a-typical-fulfilment-integration)

---

## Getting a key

In the dashboard: **Settings → Developers → API keys → New key**. Pick the
scopes, copy the key — it is shown **once** and never again (only its SHA-256
is stored). Lost it? Revoke it and create another.

Creating a key needs the **API access** feature on the store's plan; the
dashboard says so and points to the plans when it is missing. A key that
already exists keeps working whatever the plan.

| Scope          | Lets the key                                                                  |
| -------------- | ----------------------------------------------------------------------------- |
| `orders:read`  | list and read orders and their shipments; pull the accepted-orders feed and acknowledge what it took (see *Tills and kitchens*) |
| `orders:write` | everything above, plus confirmation, cancellation, shipments, COD collection |
| `orders:pos_status` | report the order's status in your till or kitchen (`received`, `preparing`, `ready`, `completed`) — a note beside the order that never moves its stage. Only by this scope's name: `orders:write` does not grant it |

A key acts **as the teammate who created it**. A request is allowed only when
both the key's scopes and that person's role in the store allow it — so a key
made by a Workspace Manager cannot confirm COD orders (that role has no
`orders.confirm`), whatever its scopes say. If that person leaves the store,
or the store is suspended, the key stops working. Actions show in the order
history under their name.

## Authentication

```http
GET /api/v1/public/me HTTP/1.1
Host: <your Zimos API host>
Authorization: Bearer zk_7Hq2mP9xa_Wq8…
```

`X-API-Key: zk_…` works too. Start with `GET /api/v1/public/me` — it tells you
which store the key belongs to and what it may do:

```json
{
  "workspaceId": "de139192-a106-4598-a634-4a0f84a55fca",
  "apiKey": { "id": "…", "name": "Sharks fulfilment", "keyPrefix": "zk_7Hq2mP9xa", "scopes": ["orders:read", "orders:write"] },
  "actingAs": { "id": "…", "fullName": "Mostafa Fahiim" }
}
```

Every bad key — missing, malformed, wrong, revoked, its creator gone, its
store suspended — gets the same `401 INVALID_API_KEY`.

## Errors and limits

Errors always look like this:

```json
{ "error": { "code": "ORDER_NOT_COD", "message": "Only cash-on-delivery orders go through confirmation", "requestId": "…" } }
```

| Status | Meaning                                                                        |
| ------ | ------------------------------------------------------------------------------ |
| 401    | `INVALID_API_KEY`                                                              |
| 403    | `FORBIDDEN` — the key's scopes or its creator's role don't allow this          |
| 404    | `NOT_FOUND` — no such order *in this store*                                    |
| 409    | the order's state doesn't allow it (`OUTCOME_UNCHANGED`, `ORDER_CANCELLED`, …) |
| 422    | `VALIDATION_ERROR`, with `details: [{ field, message }]`                       |
| 429    | `RATE_LIMITED` — slow down                                                     |

**Rate limit:** each key has its own per-minute limit (60 by default, set
when it is created), reported in the `RateLimit-*` response headers. Every
request also counts against the server's per-IP limit.

**Money** is always an integer in the currency's minor unit, exactly as
stored: `12550` with `"currency": "EGP"` is 125.50 EGP.

## The order object

```json
{
  "id": "1b0e…",
  "orderNumber": "1042",
  "stage": "ready_to_ship",
  "confirmationState": "confirmed",
  "financialState": "pending",
  "fulfillmentState": "unfulfilled",
  "paymentMethod": "cod",
  "currency": "EGP",
  "amounts": { "subtotal": 25100, "discount": 0, "shipping": 5000, "tax": 0, "total": 30100, "paid": 0, "refunded": 0 },
  "contact": { "fullName": "Mona Adel", "phone": "+201000003333", "alternatePhone": null, "email": null },
  "shippingAddress": { "country": "EG", "province": null, "city": "Cairo", "addressLine": "9 Nile St", "postalCode": null, "notes": null },
  "notes": null,
  "items": [
    {
      "id": "…", "productId": "…", "variantId": "…",
      "name": "Cotton hoodie", "variantOptions": { "Size": "L" }, "sku": "HD-L",
      "offerName": null, "quantity": 2, "unitPrice": 12550, "lineDiscount": 0, "lineTotal": 25100,
      "isOrderBump": false, "isUpsell": false
    }
  ],
  "shipments": [
    {
      "id": "…", "carrierCode": "Sharks Fulfilment", "waybillNumber": "SH-1001", "trackingCode": "zg123456789",
      "trackingUrl": null, "status": "in_transit", "shippedAt": "…", "deliveredAt": null, "createdAt": "…", "updatedAt": "…"
    }
  ],
  "confirmedAt": "2026-09-29T10:02:11.000Z",
  "cancelledAt": null,
  "cancellationReason": null,
  "createdAt": "2026-09-29T09:58:40.000Z",
  "updatedAt": "2026-09-29T10:02:11.000Z"
}
```

`shipments` is included when you read one order, and in webhooks; the list
endpoint leaves it out (absent means "not loaded", not "none").

### Menu options, custom answers and the till's status

When the platform turns them on, the order carries more for tills and kitchens
(the fields are absent otherwise — check for them, do not assume them):

- **`items[].options`** — the menu options the line was sold with, as charged,
  and the code each choice has in your system (set per choice on the product
  page, *Till code*; `null` when it has none):

  ```json
  "options": [
    { "groupId": "…", "group": "Size", "choices": [ { "choiceId": "…", "name": "Large", "priceDelta": 3000, "externalCode": "SZ-L" } ] }
  ]
  ```
- **`items[].customizations`** — the customer's answers to the product's custom
  fields: `[{ "fieldId", "type", "label": { "ar", "en" }, "value", "priceDelta" }]`.
  A photo is only named (`"photo": true`, `value: null`): it is on the order page.
- **`pos`** — what your till last reported (`PUT /orders/{orderId}/pos-status`):
  `{ "status": "preparing", "reference": "T-12", "updatedAt": "…" }`, or `null`.

## Order statuses

An order has **three independent states** plus its latest shipment — a
delivered COD order is not automatically paid, and a paid card order may not
have shipped. `stage` combines them into the single answer to "where is this
order?", the same tab the merchant sees it under:

| `stage`                | means                                                      |
| ---------------------- | ---------------------------------------------------------- |
| `awaiting_payment`     | prepaid (card / wallet / transfer) and not paid yet        |
| `pending_confirmation` | COD, waiting for the confirmation call                     |
| `needs_follow_up`      | COD call unanswered or the customer asked to call later    |
| `ready_to_ship`        | confirmed (or paid) and not shipped yet                    |
| `shipped`              | collected by the courier, in transit                       |
| `out_for_delivery`     | with the courier on the delivery round                     |
| `delivery_failed`      | the courier could not deliver it                           |
| `delivered`            | delivered                                                  |
| `returned`             | came back                                                  |
| `cancelled`            | cancelled, or rejected on the confirmation call            |

| state               | values                                                                          |
| ------------------- | ------------------------------------------------------------------------------- |
| `confirmationState` | `pending` `confirmed` `rejected` `unreachable` `postponed`                      |
| `financialState`    | `pending` `partially_paid` `paid` `failed` `refunded` `partially_refunded`      |
| `fulfillmentState`  | `unfulfilled` `partially_fulfilled` `fulfilled` `returned`                      |
| shipment `status`   | `created` `picked_up` `in_transit` `out_for_delivery` `delivered` `failed` `returned` `cancelled` |

## Endpoints

Base URL: `https://<api host>/api/v1/public`. All bodies are JSON.

### Read

| Method & path                          | Scope         |                                             |
| -------------------------------------- | ------------- | ------------------------------------------- |
| `GET /me`                              | any           | the key's store and scopes                  |
| `GET /orders`                          | `orders:read` | list, newest first, 50 per page             |
| `GET /orders/{orderId}`                | `orders:read` | one order, with its shipments               |
| `GET /orders/by-number/{orderNumber}`  | `orders:read` | by the number printed on it (`1042` or `#1042`) |
| `GET /orders/{orderId}/shipments`      | `orders:read` | its shipments                               |

`GET /orders` filters (all optional): `stage`, `confirmationState`,
`financialState`, `fulfillmentState`, `q` (order number, customer name, phone
or email), `from` / `to` (ISO dates, on created time), `sort` (`newest`
`oldest` `total_desc` `total_asc`), `limit` (1–200). Page with
`cursor=<nextCursor>` from the previous answer until `nextCursor` is `null`:

```json
{ "orders": [ { … }, { … } ], "nextCursor": "7f3a…" }
```

### Tills and kitchens: the accepted-orders feed

For a system that cannot receive webhooks — a till on a shop's local network —
pull the **accepted** orders with the key and acknowledge each one you took.
*Accepted* means: a cash-on-delivery (or manually paid) order once it is
confirmed, an online order once it is paid; never a cancelled one. Available
when the platform turns it on (otherwise these paths answer 404).

| Method & path                             | Scope               |                                                         |
| ----------------------------------------- | ------------------- | ------------------------------------------------------- |
| `GET /orders/accepted`                    | `orders:read`       | accepted orders **this key** has not acknowledged, oldest first |
| `POST /orders/ack`                        | `orders:read`       | acknowledge up to 100: `{ "orderIds": ["…"] }`           |
| `POST /orders/{orderId}/ack`              | `orders:read`       | acknowledge one                                         |
| `PUT /orders/{orderId}/pos-status`        | `orders:pos_status` | `{ "status": "preparing", "reference": "T-12" }`        |

```json
{ "orders": [ { "…the order object…": "", "acceptedAt": "2026-10-24T12:30:05.000Z", "acceptedVia": "confirmation" } ], "nextCursor": null, "since": "2026-10-17T12:31:00.000Z" }
```

- Ask every few seconds; take each order, then acknowledge it. An order you
  did not acknowledge (your till crashed) is offered again; one you did is
  never offered to this key again. Each key keeps its own receipts: a till and
  a kitchen screen with two keys both get every order.
- `since` (ISO time) is how far back the feed looks: by default the later of
  the key's creation and 7 days ago, at most 30 days back. `limit` 1–100
  (default 50); `cursor=<nextCursor>` pages through one answer.
- `POST /orders/ack` answers `{ "acked": [{ "orderId", "ackedAt" }], "unknown": ["…"] }`:
  ids that are not this store's orders are listed as unknown, and nothing is written for them.
- Phones are partly hidden in the feed, as in `GET /orders`, unless the key
  also has `customers:read` and its creator may see full numbers.
- `pos-status` is set only on an accepted order (409 `ORDER_NOT_ACCEPTED`
  otherwise). It is a note: "ready" does not ship and "completed" does not
  deliver — those stay the shipment's and the courier's.

### Write — all `orders:write`

#### `POST /orders/{orderId}/confirmation` — COD confirmation call outcome

```json
{ "outcome": "confirmed" }
{ "outcome": "unreachable", "notes": "No answer, 2 tries" }
{ "outcome": "postponed", "notes": "Call after 6pm" }
{ "outcome": "rejected", "reason": "Customer refused" }
```

Recorded exactly as an agent working the confirmation queue records it:
`unreachable` and `postponed` send the order back to the queue with a retry
time; `rejected` releases its stock. `reason` is required for `rejected`.

Changing a **final** outcome (`confirmed` ↔ `rejected`) is a correction: it
needs a `reason`, and the key's creator must also hold `orders.manage`.
Correcting a confirmed order to rejected cancels its courier booking — for a
courier without a cancel API, add `"acknowledgeManualCancel": true` once you
have cancelled it with the courier yourself.

Only COD orders have a confirmation step (`409 ORDER_NOT_COD` otherwise).

#### `POST /orders/{orderId}/shipments` — register a shipment

```json
{ "carrierCode": "Sharks Fulfilment", "waybillNumber": "SH-1001", "trackingUrl": "https://track.example.com/SH-1001" }
```

The order must be confirmed (COD) or paid first, and may have only one active
shipment. If `carrierCode` names a courier the store has **connected**
(e.g. `bosta`), the parcel is booked with that courier through the
merchant's account; any other name records your own shipment.

#### `PATCH /orders/{orderId}/shipments/{shipmentId}` — move a shipment

```json
{ "status": "out_for_delivery" }
{ "waybillNumber": "SH-1001-B", "trackingUrl": "https://…" }
```

`status`: `picked_up` → `in_transit` → `out_for_delivery` → `delivered`, or
`failed` / `returned` / `cancelled`. The order's fulfilment state and stage
follow automatically.

#### `POST /orders/{orderId}/cod-collected` — the courier handed over the cash

No body. Captures the order's cash-on-delivery payment: `financialState`
becomes `paid` and `amounts.paid` the total. Calling it again changes nothing.

#### `POST /orders/{orderId}/cancel`

```json
{ "reason": "Out of delivery zone" }
```

Releases the order's stock and closes its confirmation task. An order that
has already shipped cannot be cancelled.

Every write answers with the updated order (`{ "order": … }`) or shipment
(`{ "shipment": … }`).

---

## Webhooks

In the dashboard: **Settings → Developers → Webhooks → Add endpoint**. Give
an **https** URL and the events you want; copy the **signing secret** (shown
when created and when rotated, never otherwise). **Send test** posts a
`webhook.test` event at once and shows how your server answered.

### Events

| Event                  | Sent when                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `order.created`        | a new order is placed                                                                                       |
| `order.status_changed` | the order's `stage`, any of its three states, or its latest shipment's status changes — whoever changed it: the dashboard, a courier, your own API calls |
| `order.accepted`       | the order was **accepted**: a cash-on-delivery (or manually paid) order was confirmed, or an online order was paid. Once per order, with `data.acceptedVia` (`confirmation` / `payment`) and `data.acceptedAt`. The event id is `order.accepted:<orderId>` |
| `*`                    | subscribe to everything, including events added later — **except `order.accepted`**, which an endpoint lists by name (beside `*` if it likes) |

Events usually arrive **within about 5 seconds** of the change.

### Request

```http
POST /your/webhook HTTP/1.1
Content-Type: application/json
User-Agent: Zimos-Webhooks/1.0
X-Zimos-Event: order.status_changed
X-Zimos-Event-Id: order.status_changed:1b0e…:1790000000000:3f9a1c2b7d
X-Zimos-Delivery-Id: 5c1d…
X-Zimos-Timestamp: 1790000000
X-Zimos-Signature: t=1790000000,v1=5d1f0a…
```

```json
{
  "id": "order.status_changed:1b0e…:1790000000000:3f9a1c2b7d",
  "type": "order.status_changed",
  "createdAt": "2026-09-29T10:02:15.000Z",
  "workspaceId": "de139192-…",
  "data": {
    "order": { "…the order object…": "" },
    "previous": { "stage": "pending_confirmation", "confirmationState": "pending", "financialState": "pending", "fulfillmentState": "unfulfilled", "shipmentStatus": null },
    "current":  { "stage": "ready_to_ship",        "confirmationState": "confirmed", "financialState": "pending", "fulfillmentState": "unfulfilled", "shipmentStatus": null },
    "changed": ["stage", "confirmationState"]
  }
}
```

**Large events.** A body larger than 256 KB is sent with ids only and
`"truncated": true` — `data.order` becomes `{ "id", "orderNumber" }`; read the
rest with `GET /orders/{orderId}`. The event id is unchanged.

`order.created` carries `data.order` and `data.current`. An order placed
**before** the endpoint was added, changing now, arrives as
`order.status_changed` with `previous: null` — its state is news, its previous
state isn't known.

### Responding, retries, duplicates

- Answer **2xx within 10 seconds**. Do slow work after answering.
- Anything else — an error status, a timeout, a refused connection, a
  redirect — is retried after **1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h**:
  eight attempts over about two days. After that the delivery is marked
  exhausted; the merchant can **Redeliver** it from the dashboard.
- A retry carries the **same `X-Zimos-Event-Id`**. Store the ids you have
  processed and ignore one you have seen: you may get an event twice if your
  server was slow to answer.
- Events can arrive out of order after retries. `data.order.updatedAt` tells
  you which is newer — or simply re-read the order.
- **A redirect is a failure.** A receiver that answers 3xx (a Google Apps Script
  web app does, to every POST) is retried and, after three days of nothing but
  failures, switched off. See `docs/webhooks-no-code.md` for Apps Script.

## Verifying a webhook signature

`v1` is the hex HMAC-SHA256 of `"{t}.{raw body}"` with your signing secret.
Use the **raw** body bytes, before any JSON parsing, and reject requests older
than 5 minutes.

**Node.js (Express)**

```js
const crypto = require('crypto');

app.post('/zimos/webhooks', express.raw({ type: 'application/json' }), (req, res) => {
  const header = req.get('X-Zimos-Signature') || '';
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const expected = crypto.createHmac('sha256', process.env.ZIMOS_WEBHOOK_SECRET).update(`${t}.${req.body}`).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
  const valid = v1 && v1.length === expected.length && crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
  if (!fresh || !valid) return res.sendStatus(400);

  const event = JSON.parse(req.body);
  res.sendStatus(200); // answer first, then work
  handle(event);
});
```

**PHP (Laravel)**

```php
Route::post('/zimos/webhooks', function (Illuminate\Http\Request $request) {
    $raw = $request->getContent();
    parse_str(str_replace(',', '&', $request->header('X-Zimos-Signature', '')), $sig);
    $expected = hash_hmac('sha256', ($sig['t'] ?? '') . '.' . $raw, config('services.zimos.webhook_secret'));

    if (abs(time() - (int) ($sig['t'] ?? 0)) > 300 || ! hash_equals($expected, $sig['v1'] ?? '')) {
        abort(400);
    }

    $event = json_decode($raw, true);
    // Ignore an event id you have already processed (retries repeat it).
    dispatch(new \App\Jobs\HandleZimosEvent($event));
    return response()->noContent();
});
```

## A typical fulfilment integration

1. The merchant creates an API key with `orders:read` + `orders:write`, and a
   webhook endpoint for `*` pointing at your server.
2. On `order.status_changed` where `current.stage` becomes `ready_to_ship`,
   pick and pack the order (`data.order.items`, `data.order.shippingAddress`).
3. `POST /orders/{id}/shipments` with your waybill number.
4. As the parcel moves: `PATCH /orders/{id}/shipments/{shipmentId}` with
   `picked_up`, `in_transit`, `out_for_delivery`, then `delivered`, `failed`
   or `returned`.
5. When the courier hands over the cash: `POST /orders/{id}/cod-collected`.

If you run the confirmation calls too, answer `pending_confirmation` orders
with `POST /orders/{id}/confirmation`.

Missed something while your server was down? Webhooks are retried for two
days, and `GET /orders?stage=ready_to_ship` always tells you where things
stand.


## More than orders

The same key reaches the rest of the store when it has the scope for it. The
full reference — every path, field and error — is the OpenAPI description
served at `/public-docs` (JSON at `/public-docs.json`, source
`docs/public-openapi.json`, rebuilt with `node scripts/build-public-openapi.js`).

The API answers under `/api/public/v1` and, as before, under `/api/v1/public`.
The key may also be sent in an `Api-Key` header.

| Scope | Lets the key |
| --- | --- |
| `orders:read` | list and read orders, notes and shipments |
| `orders:create` | `POST /orders` (recorded with source `api`) |
| `orders:update` | change the stage, record confirmation, add notes, tracking and shipments, mark cash collected |
| `orders:delete` | cancel an order |
| `orders:write` | create + update + delete in one (the original write scope) |
| `products:read` \| `create` \| `update` \| `delete` | products and variants; `products:update` also sets stock by SKU |
| `categories:read` \| `create` \| `update` \| `delete` | categories (collections) |
| `customers:read` | customers; phones in full only if the key's creator may see them |
| `discounts:read` \| `discounts:write` | discount codes |
| `shipping_areas:read` \| `shipping_areas:write` | shipping areas and a bulk price update |
| `webhooks:write` | register and remove webhook endpoints |
| `analytics:read` | the sales summary |

A scope never gives a key more than the teammate who created it may do. Every
answer carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
`X-RateLimit-Reset`.

Order list filters: `status`, `created_from`, `created_to`, `updated_since`,
`product_id`, plus the dashboard's own (`q`, `paymentMethod`, `source`, …).

```bash
# stock from a warehouse system that only knows the SKU
curl -X PATCH https://api.example.com/api/public/v1/products/sku/TSHIRT-RED-M/stock \
  -H "Authorization: Bearer zk_…" -H "Content-Type: application/json" \
  -d '{"stock": 25}'
```
