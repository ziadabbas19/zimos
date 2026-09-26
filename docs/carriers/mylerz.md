# Mylerz adapter notes

Adapter: `src/modules/shipping/carriers/mylerz.js`. Rollout: beta only
(`CARRIERS_BETA=mylerz` plus `CARRIERS_BETA_WORKSPACES=<slug>`).

## Sources (fetched 2026-09-26)

- https://integration.mylerz.net/Help — Mylerz's own auto-generated ASP.NET
  help pages. They give each endpoint's request/response schema and field
  limits, but no descriptions ("No documentation available"). Pages used:
  - `/Help/Api/POST-api-Orders-AddOrders`
  - `/Help/Api/GET-api-packages-GetCityZoneList`
  - `/Help/Api/POST-api-packages-GetPackageListStatus`
  - `/Help/Api/POST-api-packages-CancelPackage`
  - `/Help/Api/POST-api-packages-GetAWB`
  - `/Help/Api/POST-api-packages-TrackPackages`
  - `/Help/Api/GET-api-packages-GetTrackShipmentUrl`
  - (`GetPackageStatus` and `GetWarehouses` pages return server errors)
- https://wordpress.org/plugins/mylerz/ — the official Mylerz WooCommerce
  plugin (v5.0.5, author "mylerz"). It is the only official source for the
  `/token` exchange, the Egypt base URL and the call sequence a merchant
  integration uses.
- Not used: "Mylerz API v1.3.1" on Slideshare/Scribd. It was uploaded by a
  third party, so it is not an official source.

## Capabilities

| capability | value | why |
|---|---|---|
| cancel | `api` | `POST api/packages/CancelPackage` is documented, and the plugin uses it |
| label | true | `POST api/packages/GetAWB` returns the AWB bytes |
| webhook | `none` | no webhook is documented |
| polling | true | the only way to learn status |
| bulkStatus | true | `POST api/packages/GetPackageListStatus` takes a list of barcodes |
| addressLevels | `city`, `neighborhood` | `GetCityZoneList` returns cities with zones; AddOrders takes the zone code as `Neighborhood`. Sub-zones exist, but no create field takes them |

## Unverified

The numbers match the `UNVERIFIED (n)` comments in the adapter.

1. **No sandbox.** Only production hosts are published (the plugin readme
   lists one per country). A staging host appears only in the unofficial PDF.
2. **Status values are not documented.** `GetPackageListStatus` rows have
   `Status`, `StatusName`, `StatusId`, `PhaseName` and `PhaseId`, but none of
   their values are listed. Only two are mapped, both taken from the official
   plugin's code: `Delivered, Thank you :-)` → `delivered`, and
   `Rejected - reason to be mentioned` → `failed`. Every other value leaves
   the shipment unchanged, is stored as `lastCarrierStatus` and is logged as
   a warning. No state is known to mean "cancelled at Mylerz", so a refused
   cancel is never counted as already settled.
3. **Token lifetime.** `expires_in` is not documented. If it is missing we
   reuse a token for 1 hour (see "Login token" below for refreshes).
4. **Login failure response.** The HTTP status and wording are not
   documented. We treat 400/401 or `error: invalid_grant` (standard OAuth
   password grant) as wrong credentials.
5. **Phone format.** `Mobile_No` is documented only as "max 20 chars". We
   send Egyptian numbers in local form (`01XXXXXXXXX`), and anything else as
   `+<digits>`.
6. **Missing `WarehouseName`.** What Mylerz does when it is omitted is not
   documented. Presumably it uses the account default.
7. **`City` field.** It is not documented whether it takes a code or a
   name. Like the plugin, we leave it out and send `Neighborhood` (the zone
   code) plus `Country: "Egypt"`.
8. **COD ceiling.** None is documented, so none is enforced. Only
   `ValueOfGoods` (±999999) is checked.
9. **`Total_Weight` unit.** Not documented. We send kilograms.
10. **`GetAWB` content.** `Value` is a byte[]. It is not documented that
    this is a PDF, so we check for `%PDF`.
11. **Cancellable states.** Not documented, and neither is the refusal
    wording. A refusal (`IsChanged: false`) surfaces Mylerz's `ErrorMessage`.
12. **Rate limits and batch size.** Neither is documented. Bulk status is
    sent in chunks of 50 (the sync service's chunk size).
13. **Auth on `GetCityZoneList`.** The plugin calls it without a token. We
    send the token anyway.
14. **Which credentials.** Whether API access uses the merchant-portal login
    or a separate API user issued by Mylerz is not stated anywhere.

## Login token

- One `/token` login per username+password, cached in memory until
  `expires_in` (less a minute) runs out.
- A call refused with a **cached** token drops it, logs in once more and
  repeats the call.
- Only a refused **login** is `CARRIER_AUTH_FAILED`: the account is marked
  invalid, and the sync cron stops calling Mylerz for it (its shipments keep
  a slot at the normal interval and resume after the merchant reconnects).
- A call refused right after a successful login is
  `CARRIER_PERMISSION_DENIED` (API access not enabled), not bad credentials.

## What a merchant enters

- Credentials: **Mylerz username** and **Mylerz password** (the same pair
  the official WooCommerce plugin asks for).
- Settings (optional): pickup **warehouse** (chosen from the account's
  warehouses), **service type** (DTD/DTC/CTD/CTC, default DTD), **service**
  (ND/SD, default ND), and **default weight** (grams, used only when the
  booking tier has no upper bound and the order has no weight).

## Getting credentials / carrier-side setup

- The plugin's only instruction is: "You should have Mylerz credentials. If
  you are a new customer, please contact us to create an account." There is
  no self-serve developer portal or API-key page. An existing Mylerz merchant
  uses their Mylerz username and password. If those don't work for API
  login, they ask their Mylerz account manager to enable API access.
- Warehouses (pickup locations) are set up on the Mylerz side. The connect
  screen lists them.
- Nothing to paste into Mylerz, because there are no webhooks.
- Status updates come only from polling, so the `sync-carrier-shipments` cron
  must run.
