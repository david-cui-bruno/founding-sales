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

Bounded self-inspection identified conservative edge cases for root's independent Spec/Standards review: readiness revalidation precedes final budget settlement and can withhold a candidate when its own maximum hold consumes the last allowance; very large individually bounded citations can exceed the persisted combined outcome-size constraint, which then follows conservative calling recovery rather than publishing; the injected external adapter is expected to honor its abort signal. These are not represented as actual provider acceptance or complete edge-case proof. Root owns combined full gate, secrets/upgrade validation and final independent review.
