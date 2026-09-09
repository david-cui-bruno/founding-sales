# Task C5 report

Status: DONE_WITH_CONCERNS. Source implementation and focused offline verification complete. Live provider/DynamoDB acceptance and C6 activation remain separate gates. Source commit SHA is recorded below after the exact-path commit.

## Scope and ownership

Original seven C5 paths:
- `src/shared/contracts/meetingContract.ts`
- `src/shared/meetings/schedulingRules.ts`
- `src/main/meetings/calendarProvider.ts`
- `cloud/lambdas/delegated-worker/src/meetingCoordinator.ts`
- `tests/main/calendarProvider.test.ts`
- `tests/main/schedulingRules.test.ts`
- `cloud/lambdas/delegated-worker/test/meetingCoordinator.test.ts`

Root approved dedicated durable storage before implementation:
- `cloud/lambdas/delegated-worker/src/meetingRepository.ts`
- `cloud/lambdas/delegated-worker/test/meetingRepository.test.ts`

Root additionally required actual local source integration. After camel explicitly released shared files at schema22 commit `33c4cf849678ac390f49410f195d886cdcf12066`, C5 narrowly modified:
- `src/shared/contracts/delegationContract.ts`: explicit `meeting.outcome` variant only.
- `src/main/delegation/delegationRepository.ts`: existing-table meeting projector and exact prior-identity late-generation check only.
- `tests/main/meetingProjection.test.ts`: new real encrypted temporary database tests.

No migration, presentation, grant/auth/handler, C1 execution repository, C3 intake/draft, or C4 dispatch source was edited. No subagents, installs, builds, native rebuilds, network/cloud/live profiles/accounts/grants/invitations were used. Shared files are released to C6 after this commit.

## TDD evidence

Every npm/npx command used this export in its own shell:

```sh
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";
```

Observed RED/GREEN cycles:

| Boundary | RED observation | GREEN evidence |
| --- | --- | --- |
| Pure rules and real HTTP adapter | Initial missing-module RED, followed by executable scaffold RED: 17 failing tests (`not_implemented`) | Final rules 16 and adapter 8 pass |
| Refusal evidence and post-create races | 2 failures: negated quote allowed and external overlapping event not inspected | Both regressions pass |
| Real durable repository | 9 initial executable RED failures | Final repository 17 pass |
| Composed coordinator | 6 initial executable RED failures | Final coordinator 8 pass |
| Strict cross-boundary event shape | Real HTTP create result had extra write-only properties rejected by strict durable outcome schema | Adapter now returns exact provider projection, composed tests pass |
| Reservation acknowledgement / negation | Lost commit acknowledgement returned held rather than unknown; positive substring in negated full reply was accepted | Both pass, no insert retry |
| Useful automatic scheduling | Missing offered matcher and accepted-offer persistence; quote-only free-form intent previously admitted | Ordinary reply/References/accepted-message binding passes; noncanonical evidence requires owner approval |
| Offer completeness | An accepted email with an omitted second option was incorrectly admitted as a one-slot offer | Exact frozen body versus complete rendered offered-slot list now checked |
| All relevant intake | Another configured relevant mailbox could be ignored | Uses C4 real intake barrier and same final validity ceiling |
| Durable events/local projection | Remote outbox returned no events; real SQL projection initially rejected missing discriminator, then produced no row | Reservation/outcome AUTH/outbox transactions and existing-table projection pass |
| Late generation/wire evidence | Cancellation after revoke rejected; booked-without-provider accepted by wire schema | Exact prior identity permits late evidence while preserving revocation; forged provider state rejected |
| Final provider lookup race | A pause during provider GET still resulted in booking | GET/preflight precede final conditional reservation, then no external await before mutation |
| Held receipts/publication | Interest hold had no durable event; subscriber failure threw despite durable booked outcome | Held event persists; pending outbox can replay without downgrading provider evidence |

Final focused commands:

```sh
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test --prefix cloud/lambdas/delegated-worker -- test/meetingRepository.test.ts test/meetingCoordinator.test.ts
# 25 passed: repository 17, coordinator 8.

export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/meetingProjection.test.ts tests/main/schedulingRules.test.ts tests/main/calendarProvider.test.ts tests/main/delegationRepository.test.ts
# 48 passed: C5 projection 5, rules 16, adapter 8, existing delegation regression 19.

export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; TZ=Pacific/Auckland npx vitest run tests/main/schedulingRules.test.ts
# 16 passed independently of host-local timezone.
```

Scoped typechecks passed in both configurations:
- Strict, `noUncheckedIndexedAccess`, ES2023, bundler resolution, no emit, skipLibCheck/esModuleInterop for the nine original/additional remote C5 paths and tests.
- Project-compatible `noImplicitAny`, legacy node resolution, ESNext, no emit, skipLibCheck/esModuleInterop for the released shared union/projector and projection test, plus Calendar/coordinator/repository source. This caught and repaired non-strict-null Zod inference differences without weakening runtime validation.
- Exact 12 source/test paths passed `npx eslint --no-ignore ...` with the required export. `git diff --check` passed.
- No full root/package/native gate was run. No remaining foreign type errors in the scoped checks. A preliminary projection check with the wrong bundler resolver reported the existing migrate.ts legacy-resolver `@ts-expect-error`; using the project's actual legacy resolver resolved that configuration mismatch without editing migration code.

## Frozen public contracts

`meetingContract.ts` exports strict schemas and types for scheduling rules, intent, provider identity/event/outcome, reservation requests, saved rules/offers, reservation records, and `meetingOutcomePayloadSchema`.

- `validateMeetingIntent(input, rules, now)` and `overlapsWithBuffers(slot, busy, rules)` are pure. UTC instants, explicit IANA timezone, local wall representation and optional offset must agree. Spring gaps and unresolved autumn folds hold. Explicit valid fold offsets work. Duration, notice, horizon, weekly windows, buffers, confirmed rule revision, cancellation/reschedule policy and evidence are distinct checks.
- `CalendarPort` has `availability`, `create`, `get`, `update`, `cancel`. Availability optionally takes `excludeIdentity` for actual owned-calendar event enumeration. `createCalendarProvider({grant,accessToken,fetch})` requires injected HTTP and C2 capabilities/selected calendars. No implicit live fetch. Provider identity is a deterministic Google-valid SHA256 hex ID over workspace/meeting/calendar.
- Create deliberately selects `sendUpdates=all|none`; update/cancel use actual PATCH and If-Match. Provider statuses and attendee responses are retained. Requested Meet links must be real validated provider video URLs. Pending/missing conference creation remains unknown. A request for invitations is not proof of delivery or acceptance.
- Availability verifies every requested calendar. Post-create checking uses bounded owned-calendar `events.list`, excludes only the exact meeting ID, and checks other conflict calendars with free/busy. Truncation, calendar errors, or unexpandable all-day events hold instead of claiming freedom. External races are detected, not claimed impossible or automatically cancelled.
- `MeetingCoordinator({repository,authorization,calendarId,fetch}).coordinateMeeting(intent,signal?)` returns held/booked/unknown/cancelled. Provider GET and availability happen before final reservation. Only the winning durable reservation can mutate. Duplicate/unknown commands reconcile by GET and never insert again, even after an absent lookup. Update/cancel retain meeting identity and require current ETag. Existing cancelled state is terminal.

`DynamoMeetingRepository(options, realRemoteAuthorization)` uses actual C1 DynamoStore, not an in-memory Map or an allowed callback:
- Trusted `saveRules({rules,expectedRevision})`, `saveOffer({offer,expectedRevision})`, `approveIntent({intent,calendarId})`.
- `reserve({intent,calendarId}, GoogleAccessEvidence)` returns reserved/existing with exact persisted identity and frozen evidence.
- `command`, `rules`, `held`, `recordHeldIntent`, `recordOutcome` support idempotent reconciliation/audit.
- Durable keys: `MEETING_RULES`, `MEETING_OFFER` (account/thread), `MEETING_APPROVAL`, `MEETING_COMMAND`, `MEETING_HELD`, `MEETING`, and calendar-scoped `MEETING_CALENDAR` within the workspace.
- Final transaction binds exact active C1 AUTH version/generation, actual signed C2 pairing/grant CAS checks, C4 intake registry/all configured relevant polling/manual receipts with `<300000ms` age from poll start and no future times, current C3 thread/context, durable account suppression absence, exact rules/approval/offer and accepted send evidence, calendar head and occupancy.
- Raw background Dynamo adapter is required. Do not also wrap it in WorkerAuth.fencedDynamo, which would duplicate the pairing transaction target.
- Calendar serialization spans accounts. Booked/unknown occupancy persists. Reschedule reserves both old/new intervals until confirmed. Unknown reservations have no timed lease takeover. Occupancy/history bounds fail explicitly rather than truncating protected evidence.
- Reservation unknown, held, and final outcomes append real worker events while atomically advancing AUTH. Late outcome uses original reservation generation without restoring old ownership. Outbox publication failures remain replayable and do not change confirmed provider state.
- Local replay writes the existing schema21 `delegated_meetings`, stores provider/attendee evidence, and maps booked to its existing `created` storage state. It validates identity, ordered account stream, observations, duplicates, and cancellation terminality. Original-generation late evidence requires an exact previously observed meeting identity. No new table/DDL.

## Exact supported automatic agreement boundary

No generic positive classifier or arbitrary quoted UTC string grants scheduling authority.

Automatic offered-slot intents bind to C4's immutable accepted outgoing message and complete offered-slot body/content hash, C1 provider-accepted action, provider message/thread identity and deterministic outgoing RFC Message-ID. Current C3 reply References must refer to that actual offer. The current offer revision and accepted evidence revisions participate in the final transaction. Unknown outbound sends cannot establish an offer.

The supported outbound offer body is the complete newline-joined list from `offeredSlotText`, e.g. `Tuesday, September 15, 2026 at 10:00 AM to 10:30 AM (America/New_York)`. This proves no competing option was silently omitted. Prospects do NOT have to type ISO timestamps or internal tokens.

Supported full reply forms include:
- `That works!` / `That works for me` / `Yes, that works` with exactly one current offered slot.
- `Tuesday at 2 pm Eastern works for me` or `... works`, matching exactly one current offered slot and its timezone.
- `Any of those works, you choose.` permits choosing only among that accepted offer's exact slots.

Multiple matches, wrong/missing References, stale offers, conflicting newer content, substantive/mixed content, extra unrecognized/quoted body text, or noncanonical free-form interpretation do not silently book. Such noncanonical interpretations require an exact durable owner-approved intent. Explicit refusals and negation hold. This is a conservative technical boundary, not a claim to solve arbitrary natural-language scheduling.

## Remaining concerns / gates

- C4 review follow-up reported after source commit: root/C3/C4 are adding persisted full-account `MAIL_SCOPE` revision/fingerprint bindings and rescan-on-change to prevent recipient-subset polls advancing account currency. C5 consumes their shared intake barrier and creates no private poll targets. Re-run composed reservation tests against that final barrier before integration acceptance.
- Independent coordinator review remains appropriate, especially real two-client Dynamo semantics, offer evidence and unknown reconciliation. ConditionalCommandHarness interprets actual SDK conditions but is still synthetic, not live DynamoDB acceptance.
- Injected HTTP tests execute the real Calendar adapter. They do not prove Google permissions/resource ownership, actual Meet provisioning, invitation delivery, real attendee acceptance or live Calendar behavior.
- C6 owns scheduler/handler wiring, normal authenticated transport and outbox drain, relevant preflight polling orchestration, runtime activation, and authorized remote/reconnect acceptance. C5 delivers real source event/projection integration, not a fake claim of live completion.
- Live create/invite/update/cancel requires separately authorized safe test calendar and consenting attendee. Cloud deployment, grant creation, real mailbox reads and workspace migration remain gated.
- Booked, invited/requested, attendee accepted, cancelled and held outcomes are not attendance, a qualified meeting, or a pilot start.

## Commit

Source commit: `0eb6ca040ca030eaf021126ce68d669a27d95355` (`feat: coordinate agreed meetings with real calendar identities`). Exact-path `git commit --only` included the 12 approved source/test paths and this report. Inspected stat: 13 files changed, 1247 insertions, 2 deletions. Owned paths were clean afterward. No unrelated shared staged contents were included.

Shared `delegationContract.ts` and `delegationRepository.ts` turn released to C6 humpback after this commit. Root notified and independent review requested. This report's commit-reference update is a separate exact-path documentation commit.

## Review repair follow-up (2026-09-09 01:35 UTC)

The original `0eb6ca0` implementation was **not accepted** by frozen review. Full `task-C5-review.md` was read, and all three Important findings reproduced before narrow owned-code changes:
- Transition A -> unknown -> A produced four events with only three unique IDs. Transition IDs now bind command, prior durable meeting-row revision, and outcome. An exact retry of the current committed outcome publishes/reuses the same evidence without advancing the stream. Actual SDK-generated events for lookup-timeout reversion and attendee accepted -> needsAction reversion now replay through encrypted SQL close/reopen, including duplicate replay.
- Older command cancellation left a pending successor unsettled. Cancellation now atomically settles only a pending command with matching account and complete meeting/calendar/provider identity, under that command's CAS, and clears only that matching lock. Tests also preserve an unrelated meeting's lock and reject a successor-record race before cleanup.
- Six ambiguous selectors were accepted by provider construction and `primary` rules could be admitted. C5 now requires an exact lowercase explicit email-style resource ID for selected owned/conflict calendars and rules before provider/reservation. `primary`, noncanonical case/whitespace, escaped selectors, and arbitrary names return `calendar_resource_id_required`. A real fictional OAuth grant selecting `primary` for the same mailbox is held before any Calendar HTTP or reservation. No alias is guessed from a mailbox and no new Google scopes or C2 edits were added. This is rejection of unsupported aliases, **not proof of calendar resource access**.

Shared scope integration uses the committed C3 cursor-envelope scope and C4 barrier, not a private schema. C5 supplies the current thread and every attendee as required scope members. Additional attendee checks must return the identical snapshot conditions; the final transaction includes only one copy of each cursor fence. Missing current thread and uncovered second attendee both reproduced RED and now hold. Fixture scopes bind both poll/checkpoint revision and fingerprint.

Minor coverage: a new composed test invokes actual C4 `createDispatchService`, real C1 dispatch reservation/accepted outcome, actual prepared Gmail sender with fictional HTTP, durable accepted send receipt, C3 poller/provider parsing of `In-Reply-To` into References, and C5 automatic offered-slot reservation with `approvalId:null`. No accepted ACTION/evidence rows are manually seeded in this test. Initial failures exposed the fixture's missing source RFC Message-ID and encoded MIME-body expectation; fixtures now use exact earlier identity and decode the real MIME body. Existing synthetic accepted-row tests remain only for focused corruption cases.

Verification: 33 remote tests (repository25 + coordinator8) and 56 main tests (projection7 + provider14 + rules16 + existing delegation19), **89 passed**. Strict scoped typecheck passed. Root-compatible checking exposed two owned test inference annotations, repaired, plus sibling-owned mailPoller/sendReconciler nullable inference issues, reported to their owners. Final scoped results and commit recorded after verification. Original live/C6 gates remain unchanged. Root requested a separate follow-up for C6's new owner-source configuration fence after canonical admission freezes; it is not part of these three review repairs.

Exact repair scope before commit: `src/main/meetings/calendarProvider.ts`, `cloud/lambdas/delegated-worker/src/meetingCoordinator.ts`, `cloud/lambdas/delegated-worker/src/meetingRepository.ts`, `tests/main/calendarProvider.test.ts`, `cloud/lambdas/delegated-worker/test/meetingRepository.test.ts`, `cloud/lambdas/delegated-worker/test/meetingCoordinator.test.ts`, `tests/main/meetingProjection.test.ts`, and this report. No shared union/projector, DDL, C2/C3/C4 or presentation source edits.

Review repair commit: `78318be` (eight exact paths, 279 insertions, 22 deletions, stat inspected). Root dispatched frozen re-review against this commit before authorizing the separate integration below. The scoped root-compatible blocker was subsequently fixed by its owners (`fe38408`, `c600b30`), with no sibling edits by C5.

## Separate C6 source-configuration fence (2026-09-09 01:38 UTC)

Uses C6's existing `ownerSourceConfigurationSchema` and `ownerSourceKey`, with no shadow DTO or activation boolean. `DynamoMeetingRepository.sourceFence({intent,calendarId})` reads the actual canonical row and requires active state plus exact workspace/account/pairing/mailbox/calendar identity. It returns the actual store revision condition. The coordinator checks this before new-work Calendar preflight, and the repository reads it again inside evidence preparation and includes **one** condition in final reservation. AUTH, C2 grants, scope currency, accepted offers and exact approvals remain mandatory independent checks. Previously reserved commands can still perform read-only provider reconciliation and record late cancellation after source pause.

TDD: seven new cases initially admitted missing/paused/wrong pairing/mailbox/calendar/workspace/account configuration. They now hold before reservation. Four final-transaction race cases mutate only the canonical source row and prove the single source CAS refuses reservation. Real `OwnerCommandCoordinator.apply` authenticated `configure-owner` admission creates active configuration in the repository/coordinator/SQL fixtures, using real fictional pairing credentials, account/thread-backed scope validation and grant contracts. Authenticated source pause before HTTP and during preflight cannot mutate Calendar. Late cancellation after that actual pause still reconciles without mutation. No caller-injected success/allowed port and no direct success-row seed substitutes for source admission. Negative corruption tests alone seed invalid/mismatched rows.

Fixture AUTH/event versions now include the real configure-owner receipt. Actual SQL replay queues and applies that normal command event before meeting transitions. The C4-send/C3-References/C5 offered-slot test remains reachable under actual account activation, without a scheduler-only per-message allowlist.

Fresh scoped strict/noUnchecked and root-compatible noImplicitAny TypeScript checks and exact five-path lint passed. Final focused matrix and exact-path commit are recorded at completion. Scope: `cloud/lambdas/delegated-worker/src/meetingRepository.ts`, `cloud/lambdas/delegated-worker/src/meetingCoordinator.ts`, their two owned tests, `tests/main/meetingProjection.test.ts`, and this report. No shared owner/delegation contract, projector, C1/C2/C3/C4/C6 source, DDL or presentation edits. This is offline source integration, not live Google/DynamoDB or Mac-asleep acceptance.

Final source-fence matrix (01:38:21 UTC): **103 passed**, remote47 (repository36/coordinator11) plus main56 (SQL7/provider14/rules16/delegation19). Strict and root-compatible scoped typechecks, owned-path lint and diff-check passed. No scoped blockers remain. Re-review and live/C6 end-to-end activation acceptance remain pending.
