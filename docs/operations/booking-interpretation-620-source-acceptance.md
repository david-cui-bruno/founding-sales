# #620 source acceptance, 2026-10-13

## Scope and authority

Source engineering only. No live model/provider/calendar/account calls, sends, appointments, deployment, activation, GitHub mutations or actual-quality claims occurred. Production composition has no booking authority or model adapter and visibly returns unavailable. Saved booking policy remains `enabled:false`.

The existing admitted-message seam is authenticated `/crm/business/mail/read` to `readMailConversation(context, ExactMailSource)` in `packages/domain/mail/crmSources.ts`. Interpretation takes exact canonical source references, not client body, attendee or permission flags. Original participant, dates, native account/generation, contexts and revision/hash lineage are preserved separately from transient authored provider input. Bounded prior outgoing sent-proof messages must be from the same native mailbox/account/thread.

The authority adapter delegates #622 `readCurrentBookingPolicy(..., capability:'interpretation')`, `revalidateBookingPolicy` and canonical budget observation. It does not duplicate policy, consent, readiness, funding or settings stores. Exact route is `us.anthropic.claude-haiku-4-5-20251001-v1:0`, provider `aws_bedrock`. Candidate output never authorizes an action. Every visible outcome has `permission:false`.

Lock order is native identity/source, booking-policy setting, booking budget, existing monthly spend. Model await is outside database transactions. The registered `crm.booking_interpretation` non-sending job uses existing `outbound_fence` runner categorization because that category permits the durable outside-transaction model wait, not because sending is authorized.

## Behavioral acceptance mapping

`apps/api/test/bookingInterpretation.test.ts` uses real disposable PostgreSQL, normal authenticated dispatch, normal owner policy save and canonical saved-policy runtime evidence. Provider surfaces and readiness observations are explicitly controlled, not actual provider evidence.

| Requirement | Observed check |
| --- | --- |
| Missing booking authority is unavailable, no extraction-grant reuse | unavailable request with immutable provenance and no copied body |
| Normal useful visible journey | owner save, registered worker, controlled exact Haiku, authenticated current read, approved-link candidate and settled one-cent ledger |
| Prior exact offer acceptance need not restate slot | prior date/time/IANA offer plus incoming `Yes that works` becomes guarded slot proposal |
| Generic interest is not slot agreement | mislabeled model accept-slot output clarifies |
| Opt-out/refusal retained | authored opt-out becomes stop |
| Conditional or mixed sales handling | conditional scheduling pauses with actionable original-question David handoff, unconditional accepted slot retains separate handoff |
| Authority loss after wait | cross-connection owner policy revoke hides candidate, conserves settlement |
| Source deletion after wait | canonical delete clears stored derived quotes/provenance/authority and public response retains only source-free finance |
| Strict shared budget and maximum reservation | insufficient shared allowance produces zero model calls and no reservation |
| Unknown accounting and restart | maximum estimated settlement, same-original new and queued repeat fenced, actual registered runner lost-lease recovery does not replay call |
| Minimized external data | captured controlled wire omits quoted third-party text and unrelated identity data, authored offsets retained |
| Real mounted caller path | closed desktop operation host, real authenticated client, dispatch, registered worker and mounted `EmailTimeline`; identity/access prop loss clears private proposal |

Worker exact-route/no-tools/no-fallback adapter and desktop unavailable component have focused tests. Real migration/constraint inventories include the new table and shape bounds. Each substantive vertical slice observed a genuine behavioral RED followed by minimum GREEN, including missing route/DI, opt-out, prior-slot, conditional/mixed handling, generic-interest false agreement, unknown queued repeats and provider data minimization.

## Reproduction

Use official Node 24.20.0 at `/Users/davidcui824/.jcode/scratch/node-runtime-24.20.0/node-v24.20.0-darwin-arm64/bin`, normal unchanged `npm ci`, then:

```sh
npm run test --workspace apps/api -- test/bookingInterpretation.test.ts
npm run test --workspace apps/worker -- test/bookingInterpretationModel.test.ts test/callTranscribe.test.ts
npm run test --workspace apps/desktop -- test/bookingInterpretation.component.test.tsx test/emailTimeline.component.test.tsx test/operations.test.ts
npm run test --workspace packages/domain -- test/db/constraints.test.ts test/db/migrations.test.ts
```

API tsconfig DOM/JSX additions compile only the existing included integration test that imports the real renderer. Production API imports no renderer/DOM code. Test-only hoisted JSDOM globals preserve Node URL behavior and are restored/closed after the suite. A root-approved byte-preserving `new Uint8Array(init.body)` copy in the existing default Deepgram fetch adapter resolves the resulting transitive fetch overload without changing headers, signal, route or custom injected HTTP behavior.

Final bounded checks passed on this source tree: all five workspace typechecks (contracts, domain, API, worker, desktop), focused changed TypeScript/TSX ESLint with zero warnings, `git diff --check`, 15 API real-PG interpretation tests, 47 worker model/transcription tests, 80 desktop operation/timeline/component tests, and 2,667 domain migration/constraint/policy-catalog tests. These are focused checks, not the root combined gate.

## Integration inventory

Owned additions: contracts `bookingInterpretation.ts`; domain CRM `bookingInterpretation.ts`, `bookingInterpretationAuthority.ts`, `bookingInterpretationOutcome.ts`, `bookingInterpretationSources.ts`; migration `0110_booking_interpretation.sql`; constraint support `bookingInterpretationCases.ts`; API route/test `bookingInterpretation.ts`/`bookingInterpretation.test.ts`; worker handler/provider/test `bookingInterpretation*`; desktop component/test `BookingInterpretation.tsx`/`bookingInterpretation.component.test.tsx`; this acceptance document.

Root-approved shared hunks: contracts exports; API modules/types/server options and test compiler configuration; worker registry/bootstrap; schema range, constraint and retention inventories; desktop operation descriptors/host and timeline ports/mount; one Deepgram default fetch compatibility line.

Frozen #622 policy commits cb93c711 and 728e7224 were imported with root approval, including policy contracts/settings, API module/test, domain policy/types/schema test and reservation subject enum plus both SQL CHECK expansions. These are not a competing #620 policy implementation. Isolated order is policy109 then interpretation110; root final order is #616109, #622110, #620111, #621112. Root owns renumbering and shared composition.

## Explicit limits and review follow-through

No actual Haiku quality corpus, live pricing verification, consent activation, native Gmail/LinkedIn/calendar acceptance, freebusy, attendee Route validation, guarded create, delivery or conversion is proven. Calendar/sender readiness is not borrowed to gate the independent interpretation capability. #621 remains the only future appointment authority.

Exact-slot source acceptance is deliberately bounded to explicit ISO date, 24-hour time and IANA zone, a future date, one recipient and at most one selected prior offer. Relative dates, abbreviations and less certain language clarify rather than guess. Provider lexical guards can withhold a proposal, not grant appointment authority. Actual language quality remains an activation gate.

The immutable e0471394 review baseline identified readiness-before-settlement withholding and terminal captured-readiness expiry. These findings are repaired by the root-approved isolated follow-through below. Large individually bounded citations can still exceed the persisted combined outcome-size constraint and follow conservative calling recovery instead of publication. The injected external adapter is expected to honor its abort signal. Neither limitation is represented as actual provider acceptance or complete edge-case proof. Root owns combined full gate, secrets/upgrade validation and independent review.

## Root-approved isolated review repairs

Original WT/branch stays clean at e047139435d204c58f1bd0440d77d8e464400e3b. Repairs are on `codex/booking-interpretation-620-freshness-repair` in `founding-sales-booking-interpret-620-repair-20261013`.

Frozen canonical #622 successors imported, in order: 509d5f85, fde8db40, 75a14ecf, f02cd3a2, e37d4fa1, 94e56db1, e3b2b28a, then 1cb6b1c5. These bring canonical owner settings/UI, current membership/date evidence fences, the pure `bookingPolicySnapshotReadyAt` helper, final-authentication read protection and same-observation available `{snapshot,budget}`. No mutable parent files were borrowed. Only the inspected duplicate policy import/mount was resolved to one entry, retaining interpretation DI and both closed operation families. Isolated policy109/interpret110 numbering and reservation SQL are unchanged. The final canonical 1cb6b1c5 successor only adds a newline before `CHECK` and a space before `(` in policy0109 so the existing static settings inventory can parse it. SQL tokens are unchanged after whitespace removal.

Owned repair inventory relative to e047: `apps/api/src/routes/bookingInterpretation.ts`, `apps/api/test/bookingInterpretation.test.ts`, `apps/worker/src/handlers/bookingInterpretation.ts`, domain CRM `bookingInterpretation.ts`, `bookingInterpretationAuthority.ts`, `bookingInterpretationOutcome.ts`, this document. Necessary approved test inventory follow-through also adds exactly two methods/inputs in desktop `test/registryTraffic.test.ts` and two unavailable-only answers in `test/support/bridgeAnswers.ts`. No new public operation/schema or production model/provider composition.

Observed genuine behavioral RED followed by minimum GREEN:

- Both actual PostgreSQL budget/settlement waits crossed a short captured authority deadline and originally persisted a complete proposal. Publication now takes native source, policy and booking/monthly locks, settles the conserved attempt first, then observes canonical current authority and applies its captured deadline immediately before outcome publication.
- Existing booking ledger195 plus this request's own maximum5 reserve and provider actual1 originally withheld a stale outcome. Settlement removes the owned calling hold and accounts actual1, then canonical readiness sees196 and publishes the candidate. No own-hold subtraction or arbitrary permission credit.
- Controlled canonical model consent changed during the budget observer and originally dispatched the controlled model despite current readiness false. A single canonical observation now supplies both fresh snapshot and budget under budget locks, checked before reserving the maximum.
- A real reserve COMMIT wait crossed the captured deadline and originally called the model. The terminal pre-call helper now makes zero calls and honestly releases only its owned never-invoked calling reservation with zero settlement.
- Native source delete followed by ordinary command replay on a fresh connection originally returned the immutable private provenance copy. New command receipts contain only `{requestId}`. Original/replayed/legacy-reference responses are freshly authenticated current reads, never copied receipt bodies. No immutable receipts are rewritten or deleted. Reassociation changes the current revision and returns a body-free stale view; final session loss refuses private readback. Source and policy locks remain held during the final authentication wait and the pure captured deadline is checked after that wait.
- A model quote cropped the first option from a whole authored two-option offer and generic `Yes that works` originally produced a slot. A prior SENT offer to Bob plus incoming Casey also produced a Casey slot. Prior offer normalization now requires sole exact recipient/owner direction and either one unique whole-authored ISO date/time/IANA tuple or an incoming explicit selection. The unique prior offer still accepts ordinary agreement without restating the slot.

The expanded owned real-PG suite also verifies captured-deadline expiry for request and current read. Normal owner policy save, registered controlled worker, current authenticated read and actual mounted timeline/closed host journey remain covered. No live calls, sends, creates, activation, pushes or full gate were performed in the repair WT.

Final repair checks: 52 API real-PG tests (27 owned interpretation plus 25 canonical policy), one exact model adapter test, 86 desktop closed operation/timeline/component/policy-bridge/traffic tests, all five workspace typechecks, scoped zero-warning ESLint and diff whitespace checks passed. The traffic harness's missing owned fixture methods were a setup-coverage failure, not claimed as behavioral RED. The owned repair adds no schema-range or reservation-DDL difference from immutable e047. The only migration difference is the approved canonical policy0109 whitespace inventory fix described above.

## Ordered source integration

The isolated proof above is retained as dated evidence. Final source composition places unchanged policy SQL at migration0110 and unchanged interpretation SQL at migration0111, following posting policy0109, with exact schema111. Both SQL files were byte-compared against the frozen reviewed originals. Shared exports, route/module inventories and closed desktop operations retain both parents additively. This ordering is not an executed upgrade, deployment, provider-quality or activation claim.

## Bounded final-review repairs, October 13, 2026

New isolated worktree: `founding-sales-620-final-review-repair-20261013`, branch `codex/booking-620-final-review-repair`, initially clean at `26a0363c25f8b23ac2f1ed805384cb4cc0eeb950`. Required AGENTS/domain/glossary, relevant source/authority ADRs, g78 wire decision and complete #620/#609/#607 bodies/comments were read before source work. No workers were spawned. Original worktrees and their running gates were untouched.

Frozen source commits, in order:

- `687aaf1fe4da54695bdd103efba7efc271226c7d`: root-approved exact additive Today test inventory names `crm.bookingInterpretationRequest` and `crm.bookingInterpretationRead` after `crm.processingRecordHealth`. No existing assertion was relaxed.
- `af84a57f761b8fad7b72cc2a44a2658a77dd7ae4`: bounded outcome/contracts repairs, focused API and desktop response tests. This section is a subsequent documentation-only receipt for that tested source.

### Observed RED and GREEN

Before either production repair, the normal authenticated API, canonical admitted-message capture and registered controlled model worker reproduced three unsafe slot proposals: an incoming reply accepting either of two exact offered slots, a model agreement citation cropped to the first alternative, and a directly authored two-slot reply without a prior offer. Each expected clarification but received `slot_proposal`. The incoming example was `Yes, either 2026-10-20 at 14:00 America/New_York or 2026-10-21 at 15:00 America/New_York works for me`. Explicit single selection and single selection with a quoted alternative already passed, as did the unextended mounted caller journey. These seven selected tests observed four failures and three passes, not an invented test-first claim.

The fourth behavioral RED was the real closed desktop host/authenticated client/API/registered worker/mounted `EmailTimeline` journey with added informational response fields. It cleared the proposal and displayed unavailable rather than rendering the approved-link proposal. Only controlled transport response extensions were injected, not a live server change.

Outcome validation now counts the existing bounded ISO date, 24-hour time and IANA-zone representations across the whole incoming authored text. Multiple or contradictory components withhold a proposal, including when the model crops its citation. Selection from a multi-option prior offer requires one whole-authored incoming tuple matching the chosen slot plus explicit cited selection. Ordinary generic `Yes` to one unique prior offer still passes. Quoted alternatives do not become authored choices. This is a conservative withholding guard, not a general NLP framework or appointment authority.

Success response objects now strip undeclared keys, including nested outcome, slot, citation, handoff, provenance, prior/current source reference, context and financial objects. Request/read commands, nested command source references and the separate controlled model candidate schema remain strict. Invalid types, vocabularies and `permission:true` still refuse parsing. Actual API responses are checked separately with `wireDrift`; injected informational additions are demonstrated to cause drift while installed-client parsing strips them. Five normal desktop host/client outcome branches exercise request and read with recursively extended response objects and exact retained-value assertions.

The Today inventory mismatch also reproduced locally before the approved two-name correction. Additional desktop fixture syntax/envelope setup failures were fixed and are not claimed as behavioral RED evidence. The inherited root test-inventory fixes were not re-added or edited.

### Final focused validation

Pinned official Node `v24.20.0` and normal unchanged `npm ci` succeeded. Final fail-fast validation on the frozen source passed:

```sh
npm run test --workspace apps/api -- test/bookingInterpretation.test.ts
npm run test --workspace apps/desktop -- test/bookingInterpretationResponse.test.ts test/today.test.ts test/bookingInterpretation.component.test.tsx test/operations.test.ts test/registryTraffic.test.ts
npm run typecheck --workspace packages/contracts
npm run typecheck --workspace packages/domain
npm run typecheck --workspace apps/api
npm run typecheck --workspace apps/desktop
npx eslint --max-warnings 0 packages/domain/crm/bookingInterpretationOutcome.ts packages/contracts/src/bookingInterpretation.ts apps/api/test/bookingInterpretation.test.ts apps/desktop/test/bookingInterpretationResponse.test.ts apps/desktop/test/today.test.ts
git diff --check
```

Observed totals: 35 real disposable-PostgreSQL API interpretation tests and 116 focused desktop tests (6 response, 49 Today, 1 unavailable component, 56 closed operations, 4 registry traffic). Four changed-workspace typechecks, scoped zero-warning ESLint and whitespace checks passed. Supplemental strict-model and conflicting-single-prior cases are regression coverage, not separately claimed RED cycles.

Only the five source/test files named above and this acceptance document differ from the clean base. Canonical bookingPolicy, bookingCreate/Change, migrations, lockfile and provider composition are unchanged. No full gate, upgrade, secret scan, live/cloud/provider/account operation, paid call, GitHub mutation, push, release or activation occurred. Independent lion/frog review and root integrated exact-head gates remain separate follow-through. Controlled model answers do not prove actual language quality.

## October 14 independent-review repair

The preceding receipt describes its original frozen repair, not the later PR head. Independent review of PR644 at `0cbd0294` found four bounded source defects. Repair commits `54f665f3`, `62542a6a`, `8c7bd920` and `fba4e5e6` address them, before integration with the reviewed PR643 main merge.

- Whole authored booking negation vetoes cropped positive agreement or interest. Five unsafe public PostgreSQL outcomes were genuinely RED, then all nine negation controls were GREEN, including unique prior-offer acceptance and quoted-negation controls. The exported pure predicate can only withhold a positive candidate.
- Admission reauthenticates the exact session after source/authority waits and rolls back the command transaction on lost authority, leaving no request, job or command receipt. Public sign-out and device revocation are exercised at observed PostgreSQL source waits.
- Private normal and replay reads carry the same server-only authority observation past transaction completion. Exact-session authorization follows COMMIT, and a final pure captured-deadline check follows that authorization wait. No second evidence observation or public authority flag is introduced. Short-expiry and revoked-session COMMIT-response waits refuse the private projection while preserving reference-only receipts and conserved model settlement.
- The mounted desktop retains one command UUID and its selected source inputs when an actually committed, settled request response is lost or unreadable. Retry replays that command, rather than admitting another paid request. A known accepted request recovers with a read-only refresh. Privacy/source changes clear the pending identity and ignore old replies.

Root observed both lost-response variants RED at `0849622ooi`, with different retry UUIDs. The same normal closed host, authenticated API and registered controlled model journey then passed with equal UUIDs, one new durable request and one controlled model call. Root final focused task `46003045xc` passed 70 desktop tests, both mounted PostgreSQL replay variants, API/desktop types, scoped lint and whitespace checks. Worker terminal admission/read coverage passed 49 PostgreSQL tests with domain/API types and scoped lint. These counts are source engineering evidence, not actual provider/model-quality, deployment, Enable, sending or booking acceptance. Renewed independent reviews and exact-head CI remain separate merge prerequisites.
