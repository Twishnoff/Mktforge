# Analytics events

The events that define activation for Mktforge, written before any instrumentation.
PostHog is the event store (project "Mktforge", US cloud). This file is the contract:
if an event or property is not here, it does not get sent.

"HubSpot" in this file means Mktforge's own portal, where every Mktforge user is a
contact (the Week 2 system of record). A user's connected HubSpot account (the
`hubspot-connect` integration) is never a destination for analytics.

## Conventions

- Names are `snake_case`, `object_verb`, past tense for things that happened
  (`signup_completed`), present participle only for the start of something that can
  fail (`module_run_started`). Never a `$` prefix: PostHog reserves it.
- `distinct_id` is the Firebase `uid`. Before sign-up the browser is anonymous;
  `posthog.identify(uid)` at sign-in and sign-up merges the anonymous history into the
  person, so site pageviews before signup attach to the account.
- One event per thing that happened. No "generic" event with a `type` property.
- Properties are `snake_case`. Durations are milliseconds and end in `_ms`.
- The site (mktforge.io) and the app (app.mktforge.io) share the root domain, so
  posthog-js's default cross-subdomain cookie carries the same `distinct_id` across both.

## Properties on every event

| Property | Type | Source | Notes |
| --- | --- | --- | --- |
| `uid` | string | Firebase Auth | Same as `distinct_id`; absent on anonymous site events |
| `company_id` | string | `MktforgeData.activeCompanyId` | Absent until the first company exists |
| `plan` | `byok` \| `hosted` | `MktforgeKit.byok.status().plan` (client), access record (server) | Accounts created without an invite code are `byok` |
| `signup_source` | string | Person property, set once at `signup_completed` | See "Signup source" below |
| `app_version` | string | Git short SHA baked in at deploy | Lets a funnel break be tied to a release. **Not sent yet**: the app deploys straight from the repo with no build step, so there is nowhere to bake it in |

`uid`, `plan` and `signup_source` are also **person properties** (set with `$set`), so
PostHog can filter people, not only events. `company_id` is event-only: a person can
have several companies.

## Events

### Site and auth

| Event | Fires from | Properties beyond the common set | Meaning |
| --- | --- | --- | --- |
| `$pageview` | posthog-js on mktforge.io (`capture_pageview: true`; off in the app) | `$current_url`, `$referrer`, `utm_*` (PostHog's own) | A page of the marketing site was viewed. Anonymous. The one `$`-prefixed event in the contract, because it is PostHog's built-in rather than ours. |
| `signup_started` | `login.js` when the create-account view is shown (`show('create')`, including `?view=create` deep links from the site) | `invite_code_present` (bool) | Someone opened the sign-up form. Anonymous; aliased to the uid if they finish. |
| `signup_completed` | `login.js` after `MktforgeAuth.signUp()` resolves **and** `MktforgeInvite.register()` / `.redeem()` has returned, so `plan` is known | `invite_code_present`, `invite_label` (from redeem, if any) | Account exists in Firebase Auth and on the access allowlist. Sets person properties `plan`, `signup_source`, `signed_up_at`. |
| `email_verified` | `login.js` when `MktforgeAuth.refresh()` returns `verified: true` (the verify screen's "I've verified" path) | — | The verification link was clicked. Fires client-side the first time the app sees it, which may be minutes after the click; good enough for a funnel. |
| `api_key_added` | `module-kit.js` `byok.save()` on success (Manage Profile) | `key_status` (validated status from the Worker) | The account stored its own Anthropic key. |
| `api_key_removed` | `module-kit.js` `byok.remove()` | — | Not in the activation funnel; needed so `plan`/key state in HubSpot (Week 2) can go backwards. |
| `plan_changed` | `invite.js` `redeem()` when `upgraded: true`; `mktforge-access` server-side when the Week 2 HubSpot webhook flips the allowlist | `from`, `to` (`byok`/`hosted`), `via` (`invite_code` \| `hubspot`) | The account moved between plans after signup. |

### Companies and modules

| Event | Fires from | Properties beyond the common set | Meaning |
| --- | --- | --- | --- |
| `company_created` | `data.js` `createCompany()` on success | `company_count` (after creation), `auto` (bool: created by `onlyIfNone` on first sign-in vs. by the user) | A company record exists. The first one is created automatically, so `auto: true` is not a user action and is excluded from the activation definition. |
| `module_opened` | `app.js` `route()` when a module mounts | `module` | Navigation. Cheap, and it separates "verified but never looked at a tool" from "looked and did not run". |
| `module_run_started` | `module-kit.js` fetch wrapper, on any non-GET request to a `*.workers.dev` host that is a module Worker (not `mktforge-access`, `hubspot-connect`, `mktforge-slack`); GETs are status polls, not runs | `module`, `worker`, `run_id` (client-generated UUID minted once per module run in `pc.begin()` and shared by every Worker call that run makes, also sent to the Worker as `X-Mktforge-Run-Id`; the module id travels as `X-Mktforge-Module`) | A paid call left the browser. `module` comes from the mounted module, `worker` from the hostname; they differ for `draft-messaging` (serves build-positioning, draft-messaging and research) and `customer-overview-dashboard` (find-my-customer). |
| `module_run_completed` | **Server-side**, from each module Worker via PostHog's `/capture` endpoint, through `finishWithBilling()` in `shared/mktforge-auth.js` (every gated non-GET request; `target-messaging` not yet, until its bundled source is replaced) | `module`, `worker`, `run_id`, `duration_ms`, `billing` (`user` \| `host` \| `host-fallback` \| `none`), `outcome` (`success` \| `error`), `error_code` (e.g. `hosted_key_required`, `user_key_rejected`, `rate_limited`, `upstream`), `input_tokens`, `output_tokens` where the Worker has them | The Worker finished, whichever way. Sent from the server so a closed tab, a refusal, or a 500 still lands. `billing` is the same value as the `X-Mktforge-Billing` header. `distinct_id` is the uid from the verified ID token. |
| `pdf_saved` | `data.js` `savePdfDoc()` after `storeFile()` succeeds (the one path every module's PDF goes through) | `module`, `file_id`, `format` (`pdf`; `docx` once Word export lands), `size_bytes`, `inputs_summary` | A generated document was saved to My Company. The download itself is not tracked: it never fails and does not prove the output was wanted. |
| `hubspot_connected` | **Server-side** in `hubspot-connect` when the OAuth callback stores a token (the client leaves the page to authorize, so it cannot reliably fire this) | `portal_id` | A company is connected to a HubSpot portal. |
| `slack_connected` | **Server-side** in `mktforge-slack` on the OAuth callback | `team_id` | A company is connected to a Slack workspace. |
| `hubspot_disconnected`, `slack_disconnected` | `module-kit.js` `hubspot(cid).disconnect()` / `slack(cid).disconnect()` | — | Needed for the Week 2 lifecycle mapping (SQL = connected) to move back. |

### Not tracked, on purpose

- Sign-in. Sessions are visible from any event; a `signed_in` event would dominate the
  count without saying anything.
- Keystrokes, held text, inputs. PostHog autocapture is **off** in the app and session
  replay is off everywhere: the inputs are the user's company data and competitor lists.
- Errors shown in the UI other than run failures. Those come through
  `module_run_completed.outcome = error`.

## Signup source

`signup_source` answers "where did this account come from" and is set once, at
`signup_completed`, from the first of these that has a value:

1. `invite_label` from a redeemed invite code (e.g. `linkedin-post-oct`, `edra`)
2. PostHog's `$initial_utm_source` / `$initial_utm_campaign` on the person
   (`utm_source[/utm_campaign]`)
3. `$initial_referring_domain` (e.g. `linkedin.com`, `google.com`)
4. `direct`

Week 3's outbound campaign tags its links `utm_source=outbound&utm_campaign=<play>`,
so campaign-driven signups are separable from organic ones in both PostHog and HubSpot.

## Enforcement

`scripts/check-analytics-events.mjs` runs in CI (`.github/workflows/ci.yml`) on every
pull request and fails the build if the code sends an event name that is not in this
file. Add the row here first, then the `capture()` call.

## Activation

> **Activated** = a verified account that has completed at least one module run
> (`module_run_completed`, `outcome = success`) **and** saved at least one PDF
> (`pdf_saved`) within 7 days of `signup_completed`.

Rationale: a run proves the key or hosted access works; a save proves the output was
worth keeping. Verification alone is not activation, and a run that errors is not
either. Seven days matches the Week 2 nudge workflow (48 h no-run email) with room for
the second touch.

The funnel, in order, with the event that defines each step:

1. `$pageview` (site)
2. `signup_started`
3. `signup_completed`
4. `email_verified`
5. `api_key_added` *(byok accounts only; hosted accounts skip this step, so the funnel
   is built per plan)*
6. `module_run_completed` (`outcome = success`)
7. `pdf_saved`

`company_created` with `auto: false` and `module_opened` are diagnostic steps, not
funnel steps: they explain drop-off between 4 and 6.

## Where each piece of state lives

| Fact | Source of truth | Mirrored to |
| --- | --- | --- |
| Account exists, verified | Firebase Auth | PostHog person, HubSpot contact (Week 2) |
| Plan, key status | `mktforge-access` KV + access record | PostHog person property, HubSpot `mktforge_plan` / `mktforge_key_status` |
| Companies, saved files | Firestore | PostHog events, HubSpot `mktforge_companies` |
| Runs | Nowhere today (KV holds only a daily counter) | PostHog `module_run_*` becomes the record; BigQuery in Week 4 |

The Week 2 HubSpot properties (`mktforge_runs_total`, `mktforge_last_run_at`,
`mktforge_activated_at`) are derived from these events, not tracked separately.

## Backfill (Day 6)

Before the funnel is live it can be partly rebuilt from existing data, with
`$timestamp` set to the historical time:

- `signup_completed`, `email_verified`: Firebase Auth user export (creation time,
  `emailVerified`; verification time is unknown, so use creation time + 0 and flag
  `backfilled: true`).
- `company_created`: Firestore company docs' `createdAt`.
- `pdf_saved`: Firestore file docs with `source: 'generated'`, using `createdAt`,
  `moduleId`, `size`.
- `module_run_completed`: not recoverable; the KV daily counters give totals per uid per
  day with no module or outcome, enough for a "runs ever > 0" person property only.

Every backfilled event carries `backfilled: true` so it can be excluded from
duration metrics.

## PostHog project

- Project: Mktforge (id 667110), US Cloud, Free plan
- Ingestion host: `https://us.i.posthog.com`
- Project API key (public, client-side, goes in `assets/js/config.js`):
  `phc_sJwT9rVz5GHRRmz29Lppw2niseaSunXgikT7AQRyAxNg`
- Project defaults: autocapture off, heatmaps off, session replay off, web vitals on
