# #622 source acceptance and integration map

Scope: source only. No account/provider settings writes, Enable, paid calls, model calls, sends, bookings or deployment were performed.

## Existing seam and shipped source

The Calendar section in `apps/desktop/src/renderer/settings/SettingsView.tsx` already mounted `renderer/meetings/BookingCapacity.tsx`, backed by authenticated `/meetings/booking-capacity`. This exact seam and paths were named before tests. Standing policy controls are mounted beside it for the signed-in admin, keyed by identity generation.

- `renderer/settings/BookingPolicySettings.tsx` and `bookingPolicySettingsPorts.ts`: typed configured choices, explicit approval, Save/read, lower ceilings, Disable and Revoke. No manual provider IDs or JSON editor.
- `main/bookingPolicyBridge.ts`, approved `shared/operations.ts` and `main/operationHost.ts` additions: strict authenticated read/change operations with generation checks before and after waits.
- `apps/api/src/routes/bookingPolicy.ts`: existing authenticated owner GET/POST endpoint. `?view=settings` wraps the current policy with bounded already-observed configuration choices. Plain GET remains the canonical view.
- `contracts/src/bookingPolicy.ts`, `domain/meetings/bookingPolicyTypes.ts` and `bookingPolicy.ts`: the single saved policy and current reader/fence consumed by #620/#621.
- `db/migrations/0109_booking_policy.sql`: existing versioned settings key and BOTH existing reservation subject/priced-shape CHECK additions. No new consent, money, authority or scheduler tables. Root renumbers this to final110 after #616 final109, before #620111/#621112.

## Authority and money semantics

Saved business-policy validity is independent of technical readiness and activation. A normal owner save produces a genuinely available current business snapshot, while operational readiness remains unavailable by default and `enabled:false` remains held. Save is not consent evidence, provider acceptance or Enable.

`readCurrentBookingPolicy(context, query, runtime?)` and `revalidateBookingPolicy(context, snapshot, runtime?)` bind workspace, current owner membership, policy revision and the exact account generation, event/calendar, source data scope, sender authority and model/consent/purpose/quality/budget tuple. Query capability is `interpretation|booking`, default booking. Interpretation does not inherit irrelevant calendar/create/sender/release gates. Neither mode grants sending. A non-owner user cannot obtain the owner's authority snapshot. Revision and membership are reread after observations and budget reads, and owner membership is reread after the writer's settings lock wait.

Optional trusted runtime evidence/configuration ports read already-observed exact configured evidence only. Production composition is absent by default. Controlled adapters establish engineering observations, not actual provider acceptance. Current evidence must match the full saved binding and remain valid at completion. Unknown setup yields no choices; saved policies can still be lowered, disabled or revoked.

`readBookingBudget(context,{at,bindings,funding?})` observes existing ledger and open reservations for `aws_bedrock.booking`, `google_vertex.booking`, `calcom.booking`, using New York day/calendar-month boundaries. Booking caps are at most200/2500 cents and within stricter verified shared remaining amounts and existing cash ceilings. Unknown funding gives unknown remaining amounts, never an invented allowance. `lockBookingBudget` precedes the existing monthly spend lock. Consumers reserve/settle through existing priced reservation machinery. Provider suffixes preserve base funding accounting. Cal.com nonzero/unknown costs remain unsupported/unknown, not token-priced by this ticket.

The canonical rules include20-minute calls plus10-minute buffer, weekday9–18 New York,2-hour notice,14-day horizon, NO call-count cap, supported explicit agreement/attendees, unconditional logistics separated from David's question handoff and conditional agreement pause, one confirmation/provider email reminder1h/noSMS/duplicates, nudges3/7 including manual and any-reply stop, only David-confirmed no-show rebooking once next business day, selected authorized free/busy only. They are policy constraints, not claims that native settings or execution of reminders/nudges have been accepted. The adjacent historical three/week display is explicitly labeled an unenforced legacy preference, without changing provider availability algorithms.

## Observed checks

Node24.20.0 official pinned local runtime and unchanged `npm ci` flags/dependencies.

- API `test/bookingPolicy.test.ts`:12 real disposable PostgreSQL tests. Normal owner save/read, positive snapshot then revoke, controlled technical positive with Enable held, interpretation-only readiness, arbitrary model rejection, completion-time expiry, revoke during observation wait, owner loss during settings evidence wait, non-owner reader rejection, independent authenticated session revision race, immutable prior history, NY month/DST/open reservation/shared credit accounting.
- Domain `test/meetings/bookingPolicySchema.test.ts`: actual PostgreSQL catalog and invalid token/unit reservation shape regression, preserving old subjects.
- Desktop `test/bookingPolicyJourney.test.mts` with owned `vitest.bookingPolicy.config.ts`:4 mounted component -> registered operation host -> authenticated client -> real mounted API dispatch -> disposable PostgreSQL journeys: configured Save/read, lower budget with unavailable setup, Disable with unavailable setup, Revoke invalidating a formerly positive snapshot after fresh app-runtime session/context construction.
- Desktop `bookingPolicyBridge.test.ts`: changed-identity responses withheld for read and change. Existing booking-capacity component/operation regressions remain intact; exhaustive operation/traffic fixtures include new descriptors.
- Contracts/domain/API/desktop source typechecks and owned journey typecheck. Focused source/test lint, no dependency or production compiler-policy changes.

Run the real-PG UI journey explicitly: `npm exec --workspace apps/desktop -- vitest run --config vitest.bookingPolicy.config.ts`. Typecheck it with `npm exec -- tsc --noEmit -p apps/desktop/tsconfig.bookingPolicyJourney.json`. It is deliberately separate from the shipped desktop strip-only source compiler policy.

## RED/GREEN honesty

Genuine behavioral REDs preceded minimum GREEN slices: initial owner route404; current policy unavailable before implementation; missing controlled readiness; interpretation incorrectly inheriting irrelevant gates; arbitrary model accepted200 instead of400; evidence expiry still ready; settings wrapper absent; mounted Save/budget/Disable/Revoke controls absent; non-owner current reader incorrectly available; corrected owner-loss fixture returned200 instead of403; legacy capacity text omitted no-cap clarification. Supplemental concurrency/accounting/session regressions were not claimed as newly failing behavioral REDs.

Early jsdom/module URL migration failure, journey compiler isolation failure, first owner-loss fixture blocked by the existing last-admin invariant, and a mistyped lint path were setup problems, not successful RED evidence. They were repaired without changing dependency flags or relaxing production TypeScript rules. Source acceptance is not installed Electron/native acceptance, real provider/model acceptance, PostgreSQL daemon restart, production configuration/secret acceptance or final integrated paid dispatch.

## Root integration and remaining operational gaps

Root owns duplicate-free API module/runtime composition across #620/#621, #616 shared settings integration, migration renumbering/upgrade, full gates/secrets and final independent Spec+Standards review. No consumer may treat an available business snapshot, controlled evidence or saved revision as a live dispatch grant. Default setup/runtime remains unavailable/held until separately authorized configuration and technical acceptance. Revoke invalidates pending policy-bound work but does not undo accepted external actions or cancel unrelated meetings. No generic pending-work library or #624 scheduler expansion is included.
