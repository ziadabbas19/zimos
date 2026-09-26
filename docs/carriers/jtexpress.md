# J&T Express (Egypt) adapter notes

Adapter: `src/modules/shipping/carriers/jtexpress.js` (code `jtexpress`).
Rollout: beta only (`CARRIERS_BETA=jtexpress` plus
`CARRIERS_BETA_WORKSPACES=<slug>`).

## Sources (fetched 2026-09-26)

- https://open.jtjms-eg.com — J&T's Egypt open platform. The API docs are
  public, with no login. The site is a Vue app, and every doc page's content
  ships in its JavaScript, which is where we read it:
  - `#/apiDoc/index` — the docking process, where credentials come from,
    both digest algorithms, and sandbox vs production
  - `order/addOrder`, `order/cancelOrder`, `order/printOrder`,
    `order/getOrders`, `logistics/trace`, `trace/subscribe`, the two
    `statusFeedback` push pages, `vip/checkCusPwd`, `location/getLocation`,
    `waybill/getWaybillInfo`
  - the error-code tables and the documented sample requests/responses
- https://download.jtjms-eg.com/open/PHP%2Bsignature%2Bexample.zip — the
  official PHP signature example (the exact digest steps)
- https://download.jtjms-eg.com/open/Project%2Bexample.zip and
  `jt-openapi-sdk.zip` — the official Java SDK sample project
- The platform's SDK page samples (Python/PHP/Java/C#): the Egyptian
  addOrder payload shape, and the sandbox host

Hosts: production `https://openapi.jtjms-eg.com/webopenplatformapi/api`,
sandbox `https://demoopenapi.jtjms-eg.com/webopenplatformapi/api`.

## Capabilities

| capability | value | why |
|---|---|---|
| cancel | `api` | `order/cancelOrder` is documented. It cancels by `txlogisticId`, which we store as `carrierShipmentId` |
| label | true | `order/printOrder` returns `base64EncodeContent` (the sample is a PDF) |
| webhook | `none` | see Unverified 10 |
| polling | true | `logistics/trace` |
| bulkStatus | true | trace takes up to 30 waybills per call (the adapter chunks at 30) |
| addressLevels | `governorate`, `city`, `area` | `getLocation` returns province/city/area rows, and addOrder takes all three names |

## Unverified

The numbers match the `UNVERIFIED (n)` comments in the adapter.

1. **`orderType`.** It is not in addOrder's parameter table, and it is
   required together with `customerCode` in cancelOrder's table ("1
   individual, 2 contract customer"). We default to `2`, and the `orderType`
   setting overrides it for bookings. Cancel always sends `2`.
2. **Location API access.** Whether every merchant account may call
   `location/getLocation` is not stated.
3. **Scan types 7, 8 and 12.** 7 is "Proxy revenue scan" (代理点收入扫描)
   and 8 is "Express take out scanning" (快件取出扫描); both keep the
   current status. 12 is "Warehousing of stored parts" (留仓件入仓), mapped
   to `failed` (a delivery that did not complete that day). These are
   interpretations of the doc's names.
4. **"Delivery scan" (派件扫描)** appears in the trace sample but not in the
   numbered table. It is mapped to `out_for_delivery`.
5. **Response shape.** `getLocation`'s sample answers `code: "10"` (every
   other sample answers `"1"`), and its `data` is documented as an Object but
   shown as a list. We treat `msg: "success"` with data as success too, and
   read `data` as a list of rows.
6. **Pickup window.** The time zone and the required length of
   `sendStartTime`/`sendEndTime` are not documented. We send now → now+24h
   in Cairo time.
7. **`serviceType` 01 / 02.** Only "must be 01 or 02" is documented. Default
   is `01`; there is a setting for it.
8. **COD ceiling.** Nothing is documented beyond `itemsValue` being
   String(12). COD also needs "COD business" enabled on the J&T account
   (error 145003112).
9. **Cancellable states.** Which states can be cancelled is not documented,
   and neither is the wording of a refusal (only 145003082/145003089 are).
10. **Webhooks.** J&T documents a track push (`statusFeedback`, a form post
    of `bizContent` with apiAccount/digest/timestamp headers). To receive it:
    the callback URL is "provided by the access party" outside the API, each
    waybill is subscribed with `trace/subscribe`, the push digest's algorithm
    is not spelled out, and the expected acknowledgement body appears only in
    a sample (`{"code":"1","msg":"success","data":"SUCCESS"}`). Too much of
    that is unconfirmed, so it is not built; the cron polls.
11. **Trace order and codes.** The order of `details` is not documented, so
    we pick the newest by `scanTime`. The trace sample carries English
    `scanType` labels and a Chinese `problemReason`, but no `scanTypeCode`.
    The mapping reads the code, then the label, then `problemReason`.
12. **Rate limits.** None documented.
13. **Mobile format.** Documented as String(11), so we send
    `01XXXXXXXXX`, but one sample shows `+01111400750`.
14. **Timestamp skew.** The server's tolerance for the `timestamp` header
    is not documented.

## What a merchant enters

- Credentials: **API account** (`apiAccount`), **private key**
  (`privateKey`), **customer code**, **customer password**, and optionally
  **environment**. `sandbox` uses J&T's published test credentials and ships
  nothing, so only stores in `CARRIERS_BETA_WORKSPACES` may use it: any
  other store gets 422 on `credentials.environment` when connecting, and a
  stored sandbox connection books nothing (409 `CARRIER_SANDBOX_NOT_ALLOWED`)
  once the store leaves that list.
- Settings: the **pickup address** in J&T's own names (contact name, mobile,
  governorate, city, area, street), which is checked against J&T's location
  list on connect and required to book. Also **default weight** (needed
  unless the store uses weight tiers or product weights), plus optional
  service type, freight payment (`PP_PM` monthly / `PP_CASH`), customer
  type, goods type and label size.

## Getting credentials / carrier-side setup

From the platform's "Docking process" and "Parameter Introduction":

1. Register on https://open.jtjms-eg.com, apply to become a developer, and
   complete **enterprise certification**. After approval, **apiAccount and
   privateKey are shown in the personal center**. This is self-serve.
2. **Customer code and password are "assigned by the platform"**, i.e. by
   the J&T outlet/branch the merchant has a contract with ("provided by
   contacting the shipping outlet"). A merchant without a J&T contract has
   to get one first.
3. The docs also describe joint debugging in the sandbox, then contacting
   J&T's interface staff "to confirm the online details" before production.
4. COD must be enabled on the account (error 145003112 otherwise).
5. Nothing to paste into J&T (no webhook). Status comes from polling, so the
   `sync-carrier-shipments` cron must run.
