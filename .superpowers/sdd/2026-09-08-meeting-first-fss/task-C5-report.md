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

Source-configuration fence commit: `3616226` (six exact paths, 150 insertions, 34 deletions). Committed stat inspected, no sibling source included.

## Durable meeting work producer and bounded selection (2026-09-09 01:46 UTC)

Root approved this additional owned slice after the C6 source coordinator exposed a real missing seam. The prior implementation could verify caller-supplied intents but could not enumerate or produce durable unreserved work. Frozen DTOs/signatures were sent to root, elephant and humpback before implementation.

- `MeetingOffer.meeting` is an optional legacy-safe strict `{summary:'Callie meeting',inviteAttendees:boolean}`. It is admitted offer metadata, not copied model instructions or inferred recipient consent. Legacy offers without it cannot auto-prepare, but existing reservations remain reconcilable.
- `meetingWorkSchema` / `MeetingWork`: `{input:{intent:MeetingIntent,calendarId},fingerprint,preparedAt}`. `meetingApprovalSchema`: `{input,fingerprint}`. `approveIntent` atomically persists the full exact approval and immutable work. Changed approvals require a new command identity. Fingerprint-only legacy or input-tampered approvals cannot reserve.
- Repository exports `meetingOfferKey(account,thread)`, `meetingCommandKey(command)`, `meetingWorkKey(account,command)`.
- `listAcceptedOffers(accountId,cursor=null,limit=25)` returns `{offers,nextCursor}`. It lists persisted accepted-offer records, not new dispatch permission; final acceptance evidence is checked again during preparation/reservation.
- `listPreparedIntents(accountId,cursor=null,limit=25)` returns `{work,nextCursor}`, excluding already reserved or durably held commands.
- `listReservations(accountId,cursor=null,limit=25)` returns `{records,nextCursor}` for exact stored reconciliation. It does not create a new insert permit.
- All lists issue actual strong `QueryCommand` with `Limit` in 1..25 and `ExclusiveStartKey`. Opaque continuation binds account, key prefix and page limit. Wrong-account/prefix/limit continuations fail. Empty filtered pages still return continuation, including other-account reservation pages, so consumers must continue rather than restart page one. Oversized/inconsistent SDK pages fail rather than silently truncate.
- `prepareOfferedReply({accountId,threadId}):Promise<MeetingWork|null>` performs no provider calls. It uses the saved accepted offer, exact current single latest recipient message, real References/accepted-send evidence, current rules/source/AUTH, and the same durable evidence conditions used by reservation. Unsupported/mixed/negated/ambiguous replies do not produce automatic work. Ordinary one-offer `That works!` remains supported. A stable offer/reply command ID and offer meeting ID prevent a second identity on interrupted/repeated preparation. Existing work is immutable, and consumed/held work is not regenerated. Final reservation still checks current signed grant authority and every original domain fence.

TDD observations: full approval input was absent, list methods were missing, and the strict offer schema rejected carried metadata. These REDs are repaired. The actual C4 sender→accepted receipt→C3 parsed reply test now invokes this producer before reserving. Seven composed scenarios cover success, legacy metadata, negation, competing offers, mixed substantive content, source-change CAS and lost preparation acknowledgement. Repeated preparation/restart returns identical work and repeated reservation returns existing, with no second send. Tests verify zero HTTP requests during preparation. Query-boundary tests use real SDK inputs and a synthetic paginated response adapter, including consumed-work and foreign-account empty pages.

Integration responsibility remains explicit: elephant owns source tick/cursor consumption. Root and humpback selected optional strict `schedulingOffer` on the actual approved-reply command, with source calling `saveOffer` only after that immutable applied command and real accepted C4 receipt. No separate offer-registration click or speculative slot extraction is required. The proposed `planSaveOffer` request was cancelled before implementation. Humpback owns that normal command admission; this C5 test exercises real send/receipt/reply/producer but does not yet claim that new owner-command/source-tick path is verified. No explicit `approveIntent` owner route is added. No shared owner-command/handler edits were made by C5.

Final producer verification (01:47:36 UTC): **112 focused tests passed**, remote56 (repository45/coordinator11) and main56 (SQL7/provider14/rules16/delegation19). Strict/noUnchecked and root-compatible/noImplicitAny scoped TypeScript checks and exact three-source/test-path lint passed. No installs/builds/network/live/provider operations ran. Producer follow-up review and C6 normal command/tick composition remain separate from this green owned slice.

Exact slice scope: `src/shared/contracts/meetingContract.ts`, `cloud/lambdas/delegated-worker/src/meetingRepository.ts`, `cloud/lambdas/delegated-worker/test/meetingRepository.test.ts`, and this report. All earlier live/deployment/grant/invitation gates remain closed.

## Separate C6 authenticated policy setup adapter (2026-09-09 02:04 UTC)

Root approved this disjoint closure after confirming that ordinary configuration could not reach C4 `configureCaps` or C5 `saveRules`. C5's earlier source remains frozen. Owned new paths: `src/shared/contracts/workerPolicyContract.ts`, `cloud/lambdas/delegated-worker/src/policyConfiguration.ts`, and `cloud/lambdas/delegated-worker/test/policyConfiguration.test.ts`. No C2/C4/C5 setters, owner-command files, handler, IPC or presentation source were edited.

Frozen API: `WorkerPolicyConfiguration({auth,authorization}).apply(raw,bearer):Promise<WorkerPolicyReceipt>`. Shared `workerPolicyRequestSchema` / `WorkerPolicyRequest` is a strict union with common `{version:1,requestId:uuid,workspaceId,pairingId:uuid,mailboxSubject,expectedRevision:positiveSafeInteger|null}`. `kind:'sender-caps'` carries explicit `policy:{sender:email,dailyLimit:nonnegativeSafeInteger}`. `kind:'meeting-rules'` carries complete `rules:SchedulingRules`. No numeric defaults. Rules validate IANA timezone, increasing daily windows, distinct windows/calendars, actual selected owned calendar and the full conflict-calendar set. Existing C5 setter rejects ambiguous aliases and unconfirmed rules. `workerPolicyReceiptSchema` / `WorkerPolicyReceipt` is `{requestId,kind,status:'applied',revision,fingerprint}`. It is historical application evidence, not current settings or grant status.

Root froze one endpoint, **POST `/policies/configure`**, owned by humpback. The adapter authenticates an actual C2 `commands:write` device principal and binds workspace/pairing. It validates current remote Google grant metadata with `googleGrantSchema`, exact subject/sender or selected calendars and required capabilities. It reads metadata without decrypting token envelopes and performs no token refresh/provider call. The actual C4/C5 setter receives a real adapter decorator which forwards reads and joins the setter's exactly-one single-Put transaction with current grant revision and an immutable `POLICY_CONFIGURATION_REQUEST` receipt. Actual `WorkerAuth.fencedDynamo` adds current TOKEN and pairing checks. No captured/success-stub transaction, second persistence phase, account/AUTH/permission/action creation, cap-usage reset or work queue is introduced.

Exact authenticated replay returns the original receipt before inspecting newer policy/grant state. Changed input for the same request ID fails. Failed acknowledgements are recovered by strongly reading the atomic receipt. A later grant revoke does not rewrite history, but a revoked pairing still cannot authenticate a replay. New policy requests remain revision-CAS controlled.

TDD: the first focused run failed loading the absent adapter. After basic composition, two initial tests passed. Four added semantic rule tests then reproduced actual incorrect admission of an invalid timezone, reversed window, duplicate selected calendar and duplicate window. The pure policy refinement fixed those REDs. Final 25 policy tests cover actual setter persistence, single atomic receipt, exact sender/subject/workspace/pairing and capability denial, emergency/wrong-scope denial, final grant/pairing races, unknown acknowledgement and restart, stale revisions, changed request identity, explicit cap zero and invalid numbers, unchanged actual daily cap usage, all conflict calendars and alias rejection. Fixture OAuth uses actual C2 pairing/grant code and injected fictional HTTP; HTTP count is unchanged by configuration. The conditional SDK harness checks actual request conditions but is not live DynamoDB acceptance.

Verification: **81 focused tests passed** (policy25 plus unchanged C5 repository45/coordinator11). Strict/noUnchecked and root-compatible/noImplicitAny scoped TypeScript checks and exact owned three-path lint passed. A root-compatible test-fixture undefined inference issue and unused omitted-field binding were repaired only in the owned test. No installs/builds/network/live account/profile/grant/invitation operations ran. Root review and humpback's actual handler/local registration tests remain separate. No claim of live policy activation or end-to-end Mac-asleep acceptance.

## Narrow first-email union compatibility (2026-09-09 02:32 UTC)

After root release and dromedary's actual C4 union landing, `acceptedOffer` explicitly rejects `phone_requested_followup` with `offer_content_conflict` immediately after strict intent parsing, before thread/reference access. Phone-requested first-email permission is not a structured meeting offer. All existing threaded offer requirements remain unchanged; no first-email scheduling support or C4/shared schema changes were added.

TDD used the actual `phoneRequestedFollowupIntentSchema`, a real stored first-email DTO, and the actual parser. A test-only accessor instrument on parsed fields absent from that variant proved the original implementation read `threadId` before discrimination: expected `offer_content_conflict`, received `first_email_thread_field_access` (RED). The one-line guard made that boundary test GREEN. The same test also checks the uninstrumented first-email DTO rejects, without any offer persistence or transaction. This is a variant-access regression test, not a claim that an ordinary uninstrumented first email had previously booked a meeting.

Fresh **57 focused tests passed** (repository46/coordinator11), including existing accepted threaded offers. Strict/noUnchecked and root-compatible/noImplicitAny scoped TypeScript plus the exact two owned source/test lint checks passed. Commit scope is only `meetingRepository.ts`, its test, and this existing report. No live actions, other setters, policies, handler or presentation changes.
