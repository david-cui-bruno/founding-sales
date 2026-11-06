# Single-workspace implementation roadmap

November 5, 2026. Parent [#939](https://github.com/david-cui-bruno/founding-sales/issues/939), under [#783](https://github.com/david-cui-bruno/founding-sales/issues/783). Design direction is approved; real-product cutover is not released. [Design system](workspace-design-system.md) owns visual/interaction rules; [selling roadmap](../sourcing/roadmap-20261007.md) owns business priorities; [current state](../operations/current-state.md) owns dated runtime observations. This roadmap supersedes #939's earlier unordered checklist and prototype shortcuts, not domain safeguards.

## Decisions settled

Five primary destinations: Today, Prospects, Pipeline, Email, Social; secondary Settings; separate Sign in. Merge Calling into Prospects. Separate deal progress from call results. Keep Interested, Demo booked, Decision pending, Onboarding, Live, with Lost behind a filter. Measure value in dollars/month. Today surfaces relevant meetings and deals idle over five days. Explicit human email sending belongs in Callie. Compact light/green design, dark mode retained; desktop-first. Main model owns design/integration; no delegated visual redesign or new design interview is needed.

## Delivery sequence

Each milestone is an end-to-end usable slice with real data, not a layer-only scaffolding PR. Establish shared contracts first; ship in order where dependencies require it. Reviews are not permission to widen contact or spending.

| Milestone | Deliverable | Depends on | Observable finish |
| --- | --- | --- | --- |
| **M0 — Durable design** | Record tokens, patterns, state/error rules; preserve runnable reference; map old surfaces and actual contracts | Owner decisions | Another implementer can reproduce the look and find every retained capability without this chat/private scratch directory |
| **M1 — Shared shell + first real Today** | Semantic tokens, shared modules, existing-stack pattern gallery, sidebar/navigation/search, Sign in/Settings shell; migrate current Today list/detail | M0 | Actual signed app opens real current work with correct loading/empty/refused states; navigation preserves exact selection and private-state clearing; every destination remains functional |
| **M2 — Prospects and calling loop** | One company list, brief/source/activity, research decisions, calling panel, notes, outcome chips, promised draft and next company; secondary setup | M1 | Select → inspect → call through controlled provider → terminal receipt → record actual outcome → reopen same draft in Email → next company, without page hopping or lost custody |
| **M3 — Pipeline** | Exact-opportunity board/drawer, monthly values, stage history, next work, stage administration, Lost reason, safe compensation/Undo | M1 and exact CRM/browser contracts | Multiple deals at one Firm stay distinct; drag/click movement persists across reload; stale updates refuse; Lost/reopen and values work; no meeting/billing/outreach side effects |
| **M4 — Human replies from Callie** | Thread, manual editing/suggestion, exact review, send/status and current authority in browser transport | M1, email surface and closed browser contract extension | Controlled signed send stays in the right Gmail thread; edits invalidate review; duplicate/lost-response/revoked-session cases never produce blind resend or false Sent |
| **M5 — Today deal follow-through** | Meeting preparation and stale-deal nudges, real stage-entry timestamps, dates/zones, bounded ordering, navigation to exact deal | M3 plus Today | Qualifying open deals appear once; completed/moved/lost/inaccessible deals leave correctly; future meetings are clearly upcoming; reading/writing a draft never implies an action was done |
| **M6 — Promised emails and check-ins** | Explicit approved-recipient resolution, draft/save/review/send/status on existing outbound ownership; approved signature | M2/M4; reviewed new server contract | Actual saved promise becomes an editable email; no copied private notes or invented address; controlled delivery reconciles exactly; policy refusal remains actionable |
| **M7 — Social and remaining Settings** | Schedule-first post detail, existing Drafts/Library/voice/facts/media/Conversations, connections, calling setup, stage settings and diagnostics | M1 and existing Social contracts | Existing approved plan/account/content controls survive restyle; scheduled is not published; owner can edit/save/read back actual settings without credential leakage |
| **M8 — Integrated cutover** | Complete retained-capability map, delete superseded views/CSS/obsolete-only tests, journeys/docs updated, normal release | All shipped scopes and risk reviews | Real browser completes daily queue → conversation → outcome → follow-through → deal, with signed local acceptance and protected hosted smoke; no orphaned feature or fake fallback |

M0 design and M1 source are merged; M2 is the active product milestone. M1/M2 form the first useful release; M3 the next commercial workflow. M4 is the next sending priority, not postponed behind Social styling. M5/M6 complete follow-through. M7 can progress after shared patterns settle without delaying reply work. M8 means final acceptance, not postponing reviews, removals or production verification until the end.

M2 is locally composed, not accepted: initial types/web1199 passed; review corrections and signed workflow proof remain. A fresh free hosted browser lane preserves exclusive-runtime admission while leaving the unrelated local Cal sandbox untouched. Pattern-only Chrome proof is not full-loop acceptance.


## Existing implementation versus real gaps

Reuse React, the current BrowserClient/session gateway, PostgreSQL, API/domain handlers, outbound dispatch, source custody and Buffer publisher. Do not add a framework, provider, scheduler or private-data cache.

- Pipeline reads and commands exist (`/pipeline/board-v2`, `/opportunities/stage`, stage administration). Browser allowlisting, exact plural Opportunity projection and mounted UI still need implementation. Prototype keys/single-Firm cards are not production contracts.
- Reply preview/send/send-status and Gmail sending support exist server-side. Current browser authority intentionally excludes send/status (ADR0015); extend the exact allowlist, client/schema handling, pending custody and lifecycle checks. This is not merely adding a button.
- Calling follow-ups currently save/read private drafts; no promised-email send route exists. Reuse the single outbound dispatch owner, with current recipient, consent, suppression, footer, mailbox and uncertainty checks. No parallel mail sender.
- Stage timestamps exist in CRM history. Today needs a bounded authorized read/projection and defensible ordering. Do not download the whole CRM or infer progress from a call disposition.
- Resolve every old view from the inventory to a retained in-context action or a proven obsolete path. Keep meetings, multiple opportunities, source inspection, retained manual reports and access controls. Fewer destinations must not mean lost capabilities.

## M2 integration contract

Implementation work, not a delivered capability. Reuse these owners under `apps/web/src/client/`; main owns the composition.

| Responsibility | Existing owner and cutover invariant |
| --- | --- |
| Company selection and evidence | `PreparedProspects`/`CallingContext`: one visible list/detail, bounded exact reads, current epoch/revision/source expiry; research tools remain accessible. A candidate is not a Firm. |
| Preparation and live controls | `CallingPreparation`/`CallingExecution`: explicit source-bound preparation and current route checks; stable mounted controls during list inspection. Prevent silent subject changes during live media. Receipt-only recovery never reconnects. |
| Actual outcome and private promise | `CallingWrap`: preserve exact terminal link, separately authored notes/email, explicit disposition and independent Finish. Confirm before discarding unsaved prose; revocation clears without confirmation. |
| Same draft and next company | `CallingFollowUpDispatch`/Email: pass the accepted draft ID only, fresh-read its current authorized revision. Next respects pending/UNKNOWN custody; opening Email neither sends nor completes an outcome. |
| Secondary controls | Existing research/inventory and `CallingSetup`/`CallingAudioTest`: retain access, settings versions, microphone/budget checks and uncertainty; remove the separate Calling destination without duplicating owners. |

Acceptance extends `test/e2e/callingExecution.spec.ts`: signed controlled-provider full loop, lost response with identical command, cross-tab exclusion, blocked live subject change, cancelled dirty-note navigation, exact draft reload and owned cleanup. Expired optional research must not erase same-Firm recorded context, terminal linkage or authored notes. Sources remain readable without native disclosure triangles; technical record metadata belongs in Diagnostics.

## Acceptance and rollout

Every slice: one combined correctness/simplicity review; add authentication/privacy/sending/migration/money/production specialists only for actual risk. Preserve in-flight reviews. Use focused existing behavioral suites and disposable signed-browser/Postgres/provider fixtures; inspect actual UI, including loading/refusal/unknown/stale states and text preservation. No real prospect call/email/post as an engineering smoke.

Use normal PR/CI and protected release. No merge during an active deploy. Fresh release directory, paused sending, pinned PITR before DDL, current authority/readiness and hosted smokes/readback. No release dispatch 05:30–08:00 UTC daily, or Sundays 05:30–09:30. Healthy release removes only its temporary block; newer owner stops win. No new spending/subscription or scope increase. Production sending/publishing status is never inferred from a prototype, migration or UI release.

## Parallel operating work

- **#919:** observe the already-approved initial-email campaign: up to25 companies, one verified recipient/initial email each, no follow-ups, at most5/day/lower local caps. Signature C is approved visually; verify its exact rendered/compliance form before live template change. No forced holds or expanded authority.
- **#873:** measure three ordinary processing days of callable-company supply and actual cost; target30/day, explain any measured gap. No paid replay, raised limits or stock-count substitution.
- **Social:** observe the approved same-profile three-post/week plan; retain connection/voice acceptance, do not reactivate/reapprove needlessly or change posting frequency during restyle.
- **#932:** namespace-adoption/retagging hardening is independent risk work, not a prerequisite for UI layout unless a release check establishes a genuine blocker.
- **#928:** selected public-thread capture has a merged specification, not a delivered acquisition capability. Controlled implementation can proceed separately; genuine capture still requires the existing provider/access/retention prerequisites. No scraping fallback, account borrowing, DMs or auto-replies.

Defer automatic personal replies, meeting booking/coaching, bulk outreach, new channels, larger contact groups, mobile-first redesign, new analytics platforms and infrastructure rewrites. Deliver the approved daily selling workflow first.
