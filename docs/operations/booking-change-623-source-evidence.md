# #623 source acceptance evidence

Date: October 13, 2026. Source only. No real appointment, provider-account call, activation, Enable, consent, deployed runtime or production completion is claimed.

## Named ordinary journey and smallest seam

Before tests, the journey was named: the authenticated owner selects the exact supported existing Cal appointment and verified attendee, reads the current canonical original mail and access context, and explicitly confirms the attendee's cancellation or unconditional agreed reschedule instant and IANA timezone. A legitimate previous outgoing offered tuple and incoming acceptance are supported. This is an independent human source-backed decision, not a #620 interpretation result, caller permission boolean or NLP guess.

The smallest seam is the new registered `/meetings/booking-change` POST/GET and `/meetings/booking-change/inspect` POST module, optional typed runtime forwarding, and `meeting.booking_change` registered urgent outbound-fence handler. Tests use ordinary authenticated commands, a real disposable PostgreSQL database and the real registered runner. Existing signed Cal lifecycle callbacks, meeting readbacks, notes/outcomes and Today are reused. There is no new reminder sender, meeting model or capability mode.

## Frozen dependency and approved shared scope

Original parent: `29b4562cb6686680e6a9af6e619e5136116c1c57`. Root approved rebase of only the two own commits through `8baae7de` onto immutable repaired parent `3167da528fa27e09fe2c125d330e7c0f0cd20eb3`. Rebase completed without conflicts. Nonempty `git range-diff 29b4562c..8baae7de 3167da52..770a3343` reports exact identical `=` pairs: `4fb82f9c` to `7b77ed15`, and `8baae7de` to `770a3343`. No mutable parent files were borrowed. Own implementation commits are `7b77ed15`, `770a3343` and terminal/reservation follow-through `21379f9e`, followed by the evidence-document freeze commit reported to root. Parent45 create API/transport plus19 policy tests and child38 baseline tests passed before the approved symmetric reservation edit.

Root-approved shared edits only: contracts index export, API optional runtime types/forwarding and registered module, worker optional bootstrap handler, job kind/key/lane, schema pin, retention and negative constraint inventory. The later exact additive `bookingCreate.ts` reservation UNION checks only pending/unknown reschedules under the same existing workspace/provider-account advisory lock. Both directions use symmetric half-open 20-minute call plus10-minute buffer windows. Unknown remains held. Existing accepted create occupancy follows current meeting facts and cancellation, not stale receipt times.

Isolated schema is policy0109/create0110/change0111 with schema maximum111. Change DDL and symmetric create hunk must integrate atomically. Root owns final change migration114, dependency successors, exact frozen delta review and combined gates. A subsequently announced parent-only Route/firm lock-order repair is not silently imported into this source freeze.

## Acceptance mapping

| Requirement | Public or boundary evidence |
| --- | --- |
| Existing appointment, verified attendee, exact binding | `bookingChange.test.ts` cancels an externally seeded signed-Cal appointment and leaves an unrelated booking booked. Guard tests reject wrong Route, booking UID, meeting, outgoing agreement, ambiguous duplicate email and unsupported confirmation. |
| Human path independent of interpretation | Policy save, canonical controlled native capture/read, owner confirmation and ordinary change command have no interpretation command, result or model call. Saved controlled readiness is never actual Enable. |
| Legitimate prior offered tuple | Existing outgoing SENT proof plus the incoming acceptance admits a reschedule. Lost response, signed callback before inspection and restarted registry recover the same receipt, with one write. |
| Create-derived appointment | `bookingChangeReservations.test.ts` creates through the ordinary create command and runner, then independently cancels/reschedules that exact current meeting/UID through change. |
| Existing human history and no invented attendance | Public notes at revision1 survive changes and older duplicate signed callbacks. Outcome readbacks do not invent attended status. Existing meeting and Today routes still read normally. |
| Final policy windows | Guard commands reject short notice, outside14-day horizon, weekend and outside New York09:00–18:00 windows. Shared canonical slot logic retains20-minute call, separate10-minute buffer and no count cap. |
| Stale authority after external waits | Fourteen availability-wait cases cover source delete/revision/context, native disconnect, policy revoke, owner role, provider generation/event/calendar binding, cost, expiry, unavailable slot, changed current meeting and opt-out. No provider write occurs. |
| Last cost wait protects all provider stages | Real registered-runner tests change account access during the final controlled cost await for initial target/availability, write dispatch and inspection. All stop before the respective provider work. Canonical captured readiness is observed after the cost await. |
| Actual receipt-row waits | `pg_blocking_pids` proves real PostgreSQL receipt lock waits. Evidence deadline, actual job lease, current appointment expiry and invalid terminal clock stop the marker and write. Marker SQL itself requires exact live owner/fence/lease and RETURNING one claimed row. |
| At-most-once and conservative recovery | Concurrent ordinary requests for the same target admit one action. A second command before dispatch returns the same durable action identity. Restart and explicit inspect never replay a dispatched write. Wrong participant evidence remains unknown. |
| Shared create/reschedule holds | Ordinary concurrent create-first and reschedule-first calls actually wait on the existing account lock. One admission wins and one receives `slot_unavailable`, with one provider write. An unknown reschedule still refuses colliding create after registry restart; inspection is read-only. |
| Narrow current Cal transport | `calcomBookingChange.test.ts` verifies exact singleton target, v2 path/version, minimized cancellation/reschedule payload, no recurring/bulk cancellation or override flags, opaque correlation, replacement UID linkage and GET-only inspection after response loss. |
| Reminder replacement/cancel barrier | Exact provider-owned transition evidence is required for a fulfilled accepted receipt. Missing reminder proof retains the accepted external meeting fact/UID but holds the receipt unknown/unverified. No Callie reminder sender is added. |
| Privacy without pretend undo | Source deletion/correction, context correction, policy change/revoke and opt-out clear payload, source and target fingerprints. Undispatched requests fail. Accepted external facts and write marker survive deletion/revoke/opt-out during POST. Redacted unknown cannot dispatch or bypass access to inspect. |
| Durable negative barriers | Existing constraint catalog has26 new failing cases plus complete inventory check. Ordinary acceptance precedes direct database-negative tests proving marker/state reset and private-provenance restoration are rejected with the owned irreversible constraint. |
| Costs, readiness and default | Missing runtime refuses. Unknown/nonzero exact contractual cost refuses before provider HTTP, without pretending free Cal pricing or budget exhaustion. Canonical New York $2/day and $25/month ceilings and stricter shared funding remain inherited. No money framework/table is added. |

Genuine behavioral RED followed by minimum GREEN was observed for ordinary public route admission, scoped adapter cancel/reschedule, lost-response inspection alias recovery, wrong participant evidence, missing reminder evidence retaining external facts, actual expired lease, cost-wait authority at all three provider stages, both terminal current-target/invalid-clock waits, and symmetric reschedule reservation refusal. Malformed fixture setup and PostgreSQL monitoring setup failures were not counted as RED.

## Owned files and shared approved integration files

New owned implementation:

- `packages/contracts/src/bookingChange.ts`
- `packages/domain/meetings/bookingChange.ts`
- `packages/domain/meetings/bookingChangeAuthority.ts`
- `packages/domain/meetings/bookingChangeProvider.ts`
- `packages/domain/db/migrations/0111_booking_change.sql`
- `apps/api/src/routes/bookingChange.ts`
- `apps/api/src/integrations/calcomBookingChangeClient.ts`
- `apps/worker/src/handlers/bookingChange.ts`

New owned evidence:

- `apps/api/test/support/bookingChangeFixture.ts`
- `apps/api/test/bookingChange.test.ts`
- `apps/api/test/calcomBookingChange.test.ts`
- `apps/api/test/bookingChangeGuards.test.ts`
- `apps/api/test/bookingChangeConcurrency.test.ts`
- `apps/api/test/bookingChangeReservations.test.ts`
- `packages/domain/test/db/support/bookingChangeConstraints.ts`
- this document

Approved existing integration files:

- `packages/contracts/src/index.ts`
- `apps/api/src/routes/modules.ts`
- `apps/api/src/routes/types.ts`
- `apps/api/src/server.ts`
- `apps/worker/src/bootstrap/main.ts`
- `packages/domain/jobs/jobKinds.ts`
- `packages/domain/db/schemaRange.ts`
- `packages/domain/retention/coverage.ts`
- `packages/domain/test/db/constraints.test.ts`
- `packages/domain/meetings/bookingCreate.ts` (only additive child reservation UNION)

No existing UI, meeting lifecycle, original-mail copy, testing database loader, reminder or sender implementation was edited.

## Focused commands and evidence

Pinned unchanged dependency install used Node24.20.0 and `npm ci --no-audit --no-fund`. No dependency or flag changes.

```sh
export PATH='/Users/davidcui824/.jcode/scratch/node-runtime-24.20.0/node-v24.20.0-darwin-arm64/bin:'"$PATH"
# From apps/api: parent64 + child53 focused public acceptance only.
npx vitest run test/bookingChange.test.ts test/calcomBookingChange.test.ts test/bookingChangeGuards.test.ts test/bookingChangeConcurrency.test.ts test/bookingChangeReservations.test.ts test/bookingCreate.test.ts test/calcomBookingCreateClient.test.ts test/calcomBookingCreateInspection.test.ts test/bookingPolicy.test.ts
# From packages/domain:27 pass,2657 intentionally filtered catalog cases.
npx vitest run test/db/constraints.test.ts -t 'booking_change|has a case for every constraint'
# From root, affected workspaces only.
npm run typecheck --workspace packages/contracts
npm run typecheck --workspace packages/domain
npm run typecheck --workspace apps/api
npm run typecheck --workspace apps/worker
git diff --name-only 3167da52 -- '*.ts' | xargs npx eslint
git diff --check
```

Parent64 and child51 passed together before the last two terminal-clock/current-target regressions. The final child53 focused rerun validates the latest terminal barriers. All four affected typechecks, exact changed TypeScript lint, owned constraints and diff checks pass. These are source acceptance checks, not full repository gates, independent reviews or actual provider activation.

## Primary public provider contract

Only official public Cal documentation informs transport. No authenticated account or provider API request was made. The singleton GET, cancel and reschedule endpoints pin `cal-api-version: 2026-02-25`. Cancellation sends only the opaque cancellation reason, never subsequent-recurring cancellation. Reschedule sends the exact start,20-minute length,same host and opaque reason, never conflict/out-of-bounds/booking-limit overrides.

- https://cal.com/docs/api-reference/v2/bookings/get-a-booking
- https://cal.com/docs/api-reference/v2/bookings/cancel-a-booking
- https://cal.com/docs/api-reference/v2/bookings/reschedule-a-booking

## Actual residual evidence and integration ownership

Default composition remains unavailable. The optional trusted Cal reminder-transition witness has no live implementation or activation in this slice. Missing genuine scoped reminder evidence therefore holds fulfillment unknown, while retaining accepted external facts. Current provider-owned reminder configuration/delivery/replacement/cancel behavior must be verified through existing provider machinery before actual activation, not assumed from cancellation status or this controlled fixture.

No genuinely scoped priced change machinery is present, so any nonzero or unknown cost remains unsupported. Exact cost0 fixtures prove engineering only, not real commercial Cal pricing, money authority or a funded operation. No real Cal account, browser, credential, provider HTTP, paid model, production DB, booking/cancellation, send, Enable, deployment or cloud operation was performed. No GitHub writes/push/merge, full repository gate, scanner, upgrade or children were run.

Root owns independent Spec/Standards review, final frozen parent successor integration and exact delta validation, migration renumbering/schema reconciliation, combined repository gates and any actual activation evidence. Supported transport remains regular singleton bookings only, never recurring/team-seat/bulk bookings or unrelated appointment cancellation. Selected-calendar conflict with the existing appointment is conservatively refused rather than subtracting unverified busy events. This slice does not implement #624's broader lifecycle.
