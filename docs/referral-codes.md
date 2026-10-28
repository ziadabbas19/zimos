# Referral codes, second kind

Migration **725** (`725-referral-codes-v2.js`), flag **`REFERRAL_CODES_V2_ENABLED`** (off unless exactly `true`).
Code: `src/modules/referrals/` (`referralTerms`, `referralPricing`, `redemptionService`, `agentLinkService`,
`referralCodeAdmin`), wired into `billing/subscriptionChargeService`, `merchantPlansService`, `planSwitchService`,
`goLiveService`, `workspaces/workspaceService`.

## Two kinds of code

| | First kind (every code made before 725, and any code made with the flag off) | Second kind |
|---|---|---|
| Discount | `discount_type/value/currency` on **every** charge while the code is active | `terms[cycle].discount`: steps of N payments, the last may be open-ended |
| Commission | `commission_rate_bp` (or 30%) on **every** payment, on what was received | `terms[cycle].commission` steps, on what was paid (`commission_basis = paid`) or on the list price (`list`) |
| Agent | required | optional (none = discount only) |
| Entered | as before | once per store / owner account / normalized email, limit, dates, audience, restrictions |

A first-kind code becomes the second kind only when the console sends it `terms`. From then on (flag on) every
store that entered it follows the schedule from its next payment, at its own payment number (a payment's number is
1 + the paid charges of that store's use of the code).

A store that enters a second-kind code keeps the terms it entered it with (`referral_code_redemptions.terms`):
editing the code changes what later stores get. Switching a code off still stops its discount and commission on
every payment from then on, as before.

Flag off: second-kind codes can't be created, edited (second-kind fields) or entered; first-kind codes are created
and entered as before and price as before. Uses already entered keep their terms either way.

## Entering a code (`redemptionService.redeemInTransaction`)

One path: sign-up (`POST /workspaces` `referralCode`), plans page (`POST /billing/referral-code`, optional
`planId`/`billingCycle`), plan switch (`POST /billing/plan-switch` `referralCode`). Refusals (422 unless noted):

| Code | When |
|---|---|
| `REFERRAL_CODE_INVALID` | no such code, switched off, or second kind with the flag off |
| `REFERRAL_CODE_NOT_STARTED` / `_EXPIRED` | `starts_at` / `ends_at` |
| `REFERRAL_CODE_LIMIT_REACHED` | `uses_count >= max_uses` (checked by the same UPDATE that raises the count) |
| `REFERRAL_CODE_NEW_MERCHANTS_ONLY` / `_EXISTING_MERCHANTS_ONLY` | audience. New = the owner has no other store and no paid subscription charge on any store |
| `REFERRAL_CODE_NOT_FOR_PLAN` / `_NOT_FOR_CYCLE` / `_BELOW_MIN_PRICE` | restrictions, judged against the plan being chosen |
| `REFERRAL_CODE_TRIAL_ONLY` | extra trial days on a store that is not trialing or a draft |
| `REFERRAL_CODE_ALREADY_USED` | `details.by`: `store` / `account` / `email` |
| `REFERRAL_CODE_ALREADY_SET` (409) | the store's current code still discounts a payment to come |
| `REFERRAL_V2_DISABLED` (409) | a second-kind setting, or a code with a plan switch, with the flag off |

The same code again is a no-op (200 `attached: false`). A charge already priced keeps its price. Entering a code with
an agent and `links_agent` links a store that has no open agent link; an existing link is never replaced by a code.

## Console

| Route | Permission |
|---|---|
| `GET /admin/referral-codes` (`q`, `agentId` or `none`, `state`, `audience`) | agents.view |
| `POST /admin/referral-codes` (optional `agentId`) | agents.manage |
| `GET /admin/referral-codes/:id` (with `impact`: stores using it, trials not yet paid) | agents.view |
| `PATCH /admin/referral-codes/:id` (also `agentId`, second-kind fields) | agents.manage |
| `GET /admin/referral-codes/:id/redemptions` (`q`, `status`, `merchantKind`, `source`) | agents.view |
| `POST /admin/referral-codes/simulate` | agents.view |
| `GET /admin/workspaces/:id/referrals`, `GET /admin/users/:id/referrals` | agents.view |
| `POST /admin/workspaces/:id/agent-links`, `PATCH /admin/agent-links/:id`, `POST /admin/agent-links/:id/end` | agents.manage |

Audit actions: `referral_code.create|update`, `subscription.referral_code_attach` (also the bell's
`referral_signup`, titled with the code), `agent_link.create|update|end`.

## Rollback

`down` refuses while a code has no agent or a commission row has no code (the code before 725 can't read them);
otherwise it removes everything 725 added. Deploying the code before 725 over a database still at 725 is safe while
no such rows exist.
