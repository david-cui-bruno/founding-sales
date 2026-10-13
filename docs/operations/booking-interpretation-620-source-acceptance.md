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

Frozen canonical #622 successors imported, in order: 509d5f85, fde8db40, 75a14ecf, f02cd3a2, e37d4fa1, 94e56db1, e3b2b28a. These bring canonical owner settings/UI, current membership/date evidence fences, the pure `bookingPolicySnapshotReadyAt` helper, final-authentication read protection and same-observation available `{snapshot,budget}`. No mutable parent files were borrowed. Only the inspected duplicate policy import/mount was resolved to one entry, retaining interpretation DI and both closed operation families. Isolated policy109/interpret110 and reservation SQL are unchanged.

Owned repair inventory relative to e047: `apps/api/src/routes/bookingInterpretation.ts`, `apps/api/test/bookingInterpretation.test.ts`, `apps/worker/src/handlers/bookingInterpretation.ts`, domain CRM `bookingInterpretation.ts`, `bookingInterpretationAuthority.ts`, `bookingInterpretationOutcome.ts`, this document. Necessary approved test inventory follow-through also adds exactly two methods/inputs in desktop `test/registryTraffic.test.ts` and two unavailable-only answers in `test/support/bridgeAnswers.ts`. No new public operation/schema or production model/provider composition.

Observed genuine behavioral RED followed by minimum GREEN:

- Both actual PostgreSQL budget/settlement waits crossed a short captured authority deadline and originally persisted a complete proposal. Publication now takes native source, policy and booking/monthly locks, settles the conserved attempt first, then observes canonical current authority and applies its captured deadline immediately before outcome publication.
- Existing booking ledger195 plus this request's own maximum5 reserve and provider actual1 originally withheld a stale outcome. Settlement removes the owned calling hold and accounts actual1, then canonical readiness sees196 and publishes the candidate. No own-hold subtraction or arbitrary permission credit.
- Controlled canonical model consent changed during the budget observer and originally dispatched the controlled model despite current readiness false. A single canonical observation now supplies both fresh snapshot and budget under budget locks, checked before reserving the maximum.
- A real reserve COMMIT wait crossed the captured deadline and originally called the model. The terminal pre-call helper now makes zero calls and honestly releases only its owned never-invoked calling reservation with zero settlement.
- Native source delete followed by ordinary command replay on a fresh connection originally returned the immutable private provenance copy. New command receipts contain only `{requestId}`. Original/replayed/legacy-reference responses are freshly authenticated current reads, never copied receipt bodies. No immutable receipts are rewritten or deleted. Reassociation changes the current revision and returns a body-free stale view; final session loss refuses private readback. Source and policy locks remain held during the final authentication wait and the pure captured deadline is checked after that wait.
- A model quote cropped the first option from a whole authored two-option offer and generic `Yes that works` originally produced a slot. A prior SENT offer to Bob plus incoming Casey also produced a Casey slot. Prior offer normalization now requires sole exact recipient/owner direction and either one unique whole-authored ISO date/time/IANA tuple or an incoming explicit selection. The unique prior offer still accepts ordinary agreement without restating the slot.

The expanded owned real-PG suite also verifies captured-deadline expiry for request and current read. Normal owner policy save, registered controlled worker, current authenticated read and actual mounted timeline/closed host journey remain covered. No live calls, sends, creates, activation, pushes or full gate were performed in the repair WT.

Final repair checks: 52 API real-PG tests (27 owned interpretation plus 25 canonical policy), one exact model adapter test, 86 desktop closed operation/timeline/component/policy-bridge/traffic tests, all five workspace typechecks, scoped zero-warning ESLint and diff whitespace checks passed. The traffic harness's missing owned fixture methods were a setup-coverage failure, not claimed as behavioral RED. The repair adds no migration, schema-range or reservation-DDL difference from immutable e047.
