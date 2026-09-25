# G79: a call carries its authorization, its task and its time, and never refuses history

**Date:** 25 September 2026 · **Lane:** g79 calls and callbacks · **Spec:** 9.1, 9.2, 8.2, 4.3,
Appendix A ("Log call outcome", "Callback confirm/complete"), Appendix D, Appendix G 17, 26, 32 ·
**Audit:** `GPT6-ASTRA-EXHAUSTIVE-20260925.md` items C04, C13, C14, C15, C16, C17, C18, S10, S15, C22

## What was wrong, in one paragraph

A call was recorded as a row that pointed at nothing. It named no step, so a logged
voicemail left its call task on Today for ever; it took the no-answer behaviour from the
request; it named no ticket or calling identity, because the Mac never kept them; its
time was the Mac's clock, so a fast Mac failed `recorded_at >= occurred_at`; a callback
without a time, or a wrong number without a route, was refused and the call was lost; a
refusal half-way through committed the effects before it; a route from another firm could
be retired; and the Today task behind a callback carried no callback id, so nothing on the
Mac could complete it. Beside it: a dial ticket was consumed without asking `authorizeDial`
again, the Mac resolved a DST gap an hour early, and an automated task's "snooze until
Thursday" was an indefinite firm-wide hold with the date thrown away.

## Decisions

### 1. The outcome is bound through the Today task, never inferred

`POST /calls/log` accepts `itemId`, the Today task the call was placed from. The domain
resolves it: `step-execution:<id>` binds the call to that step execution, `callback:<id>`
to that callback, `callback-time:<call log id>` to a callback that needs a time. A call
logged without a task — from the Firm page, or by an older Mac — is history and applies
nothing to any step. Guessing which step a free-standing call "was for" would complete a
step on a coincidence.

### 2. The step's frozen configuration decides, inside the same transaction

The bound execution and its enrollment are locked before the call log is written, and the
step's `on_no_answer` is read from the published, immutable version. `applyCallToStep`
(`packages/domain/dial/stepEffects.ts`) then does what 9.1 says: an engaged outcome
completes the step as `connected` with **no** successor and `applyManualModeStop` ends
every live enrollment at the firm in the same transaction (Appendix G 26 at the source,
not at the next outbox drain); voicemail, and a no-answer on an `advance` step, go through
`completeStepExecution`, the one function that times a successor; a no-answer on a
`retry_call` step re-arms the same row on the next business day at the step's own local
time, recorded as a `retry_call` shift (G8's one-row rule), and advances instead at the
database's bound of 20 attempts. `retryBehaviour` in the request is parsed, for old
bodies, and ignored.

The retry interval — next business day, same local time — is this lane's choice: 9.1 and
11.2 name the behaviour and not the interval, and "tomorrow at the time you were meant to
call" is the reading that never places a call outside a day the cadence itself would use.

### 3. Decide, record, apply — so a refusal can only come before any write

`logCallOutcome` has three phases. **Decide** checks every identity the request names
against the firm it names, under the firm's lock: contact at the firm, route at the firm
and at the named contact (S15), ticket of this workspace, firm, actor and route (C16,
S15), identity the actor's own, task at the firm. A contradiction is malformed input and
is refused with nothing written. **Record** writes the call log. **Apply** runs every
effect inside one savepoint; a refusal rolls the savepoint back and the command is still
accepted, with an `effects_not_applied` follow-up beside the recorded call (C14). An
exception — a journal that could not be written (10.2) — still rolls the whole command
back to be retried under the same command id.

The savepoint was chosen over a change to `runCommand` (which would have rolled back every
refused command's writes) because another lane is rewriting the command middleware today
(L-A), and because "recorded, with what could not be applied" is the answer 9.1 asks for;
a savepoint in the middleware would have turned the recorded call into a refusal again.

### 4. What a call still needs is a follow-up, not a refusal

`followUps` on the result: `callback_time_needed` (no instant, or one the server resolved
differently), `route_not_named` (a wrong number or do-not-call with no number), and
`effects_not_applied`. A callback without a time is recorded and a task **"Callback —
needs a time"** goes on Today in the callback lane, keyed `callback-time:<call log id>`,
`source_kind = 'callback'`, `source_id` null. The callback source carries it to each day
until `POST /callbacks/schedule` commits the instant beside that call, or a call is
recorded against it. No migration: the state is derived from `call_logs` (a
`callback_requested` call no `callbacks` row names) and the task's own completion.

### 5. "Just now" is the database's clock

The Mac sends no `occurredAt`. An entered time is history and may be any past instant;
ahead of database time by more than `CALL_OCCURRED_AT_TOLERANCE_SECONDS` (120) it is
refused as `occurred_at_in_future`, and inside that it is read as now, which is what an
older Mac's slightly fast clock is.

### 6. The ticket and the identity travel from the handoff to the log

`dialHandoff.ts` returns what authorized a call it opened (`opened` and `opened_unknown`).
The Today bridge keeps it in the main process — the renderer is told only the number — and
attaches the ticket id, calling identity, route and contact to the next outcome recorded
for that firm. The domain checks the ticket against the firm, the actor and any route
named, and fills route and identity from the ticket when the request left them out.

### 7. A callback's instant is the domain clock's answer (one implementation)

`localParts`, `zoneOffsetMinutes`, `localInstant` and the gap/fold rule moved to
`packages/contracts/src/localClock.ts`; the domain's `src/rules/localClock.ts` re-exports
them, and the Mac's `localToInstant` and outcome form call `callbackInstant` from the same
file. `createCallback` resolves the local date, time and zone itself and refuses a supplied
`dueAt` that disagrees (`callback_instant_mismatch`); a day with no hour resolves at
`CALLBACK_DATE_ONLY_LOCAL_TIME` (09:00), the constant the Mac already used. On a logged call
a disagreement is not a refusal: the call is recorded and the callback needs a time.

### 8. Consuming a ticket re-runs `authorizeDial`

`consumeDialTicket` locks the ticket, then re-runs `authorizeDial` at database time against
exactly what the ticket recorded — the route at the recorded *version*, the identity, the
contact — and issues the `tel:` URI only on an allow. A refusal writes nothing: the ticket
stays unconsumed, expires within its minute, and every further attempt is decided again.

### 9. An automated task is paused, not snoozed — visibly, and released by a person

The hold model has no scheduled release (`active_holds.released_at` is when a hold *was*
released), and a timer would shift the schedule by an interval nobody reviewed — G6's
reason, still true. Adding one would be a migration plus a worker release path that
belongs to the sequence-engine lane (L-D). So the action is named **Pause**:

* the hold is scoped to the task's **enrollment** (firm only for a task with no enrollment),
  so pausing one contact's email does not silence the firm;
* the task **stays open** on Today with `pauseHoldId`, and the Mac shows "Paused" and a
  **Resume** control where Pause was, on every day the task appears;
* `POST /today/pause/release` releases exactly that hold — only holds with
  `source_event_kind = 'today.delay_requested'` — and calls `resumeEnrollment`, so the
  enrollment's unexecuted steps shift by the union of its blocking intervals (or go to
  review past seven days);
* Pause asks for a reason and no return time. A return time from an older Mac is recorded
  in the audit event, as before, and acts on nothing.

### 10. Wire compatibility

Every request change is additive or relaxing, so a 1.0.4 Mac keeps working against the new
API: its `occurredAt` is honoured (clamped inside the tolerance), its `returnAt` is accepted,
its callback `dueAt` is checked. The expanded card gained four task fields, and a 1.0.4 Mac
parses the card with a strict schema, so they are sent only when the request carries
`cardVersion: 2`; without it `/today/firm` answers G6's shape exactly
(`todayFirmVersion1`). The new Mac needs the new API (it sends `itemId`, `cardVersion` and
bodies without `occurredAt`), so the API deploys first.

The shapes live in lane g78's shared contract, `packages/contracts/src/today.ts`: the four
task fields are optional there, so one `todayTaskDtoSchema` reads both versions exactly;
`todayFirmRequestSchema` carries `cardVersion`; the paused answer adds an optional `scope`
(`enrollment` or `firm`) to `todaySnoozeResultSchema`'s `held` variant, whose `holdId` and
`blockedActionKind` the domain already returned; and `todayPauseReleaseResultSchema` is
Resume's answer. `loggedCallResultSchema` (`./dial.ts`) declares every key `/calls/log`
returns. The API's route tests hold each answer to its schema with `wireDrift`.

## What is given up, or left to other lanes

* A released pause re-pends the execution and shifts its due time; whether the worker then
  picks it up depends on C02 (a job completed while its step was held is not re-enqueued),
  which is lane L-D's. The same is true of a retried call step's job — though a call task is
  worked from Today, which reads `step_executions` directly and shows it on its new day.
* A callback's source zone is still the workspace business zone, as before; the firm's own
  zone would be more faithful to "call me back at 2" and is not this lane's change.
* The retry interval and the 20-attempt bound are choices the specification leaves open.
