# g77: the dispatch rechecks everything under one lock, then claims

**Date:** 25 September 2026 · **Lane:** g77 send-path safety · **Spec:** 11.2, 7.3, 10.2,
12.3, 12.5–12.7, Appendix A, Appendix B, Appendix D, Appendix G 3, 4, 6, 33 ·
**Audit:** `GPT6-ASTRA-EXHAUSTIVE-20260925.md` S01, S02, S03, S05, S09, C25 (and T02)

Supersedes `g7-count-before-claim.md`, whose ordering this replaces.

## What was wrong

`dispatchOutboundMessage` ran four autocommit statements with a network call in the
middle: the gate read the world, the day's counter was incremented, the refresh token
was exchanged with Google, and a state-only `UPDATE … WHERE state = 'prepared'` claimed
the fence. Six defects followed from that shape.

* **S01.** A reply, an opt-out or a hold committed after the gate's read and before the
  claim was never seen. The token refresh made that window hundreds of milliseconds wide.
* **S02.** The gate answered five of 11.2's questions itself and never asked the
  enrollment, the control mode, the assignment or the template. Its route check let a
  `candidate` through and read the version without comparing it.
* **S03.** The gate trusted `sync_state = 'ready'`, which a mailbox keeps while every
  history read is rate limited. `recordSyncError` even moves `last_synced_at` forward.
* **S05.** The cap counted on `fence.business_date`, the date the placement planned, so a
  fence held overnight spent yesterday's allowance today.
* **S09.** The window check was weekday and minute only, so a fence prepared the evening
  before a holiday went out on it.
* **C25.** The counter moved before OAuth and was handed back by hand on the two failure
  paths anybody had thought of. A process that died in between left a count no fence
  explained.

## Decision

**Precheck, then OAuth, then one claiming transaction:**

1. **Precheck.** `decideSend` runs outside any transaction, so anything that can be
   refused without Google is refused without Google.
2. **OAuth.** The token refresh happens before the transaction opens, so no lock is ever
   held across a network call.
3. **The claiming transaction.** `BEGIN`, then:
   * take the **send gate** shared;
   * lock the fence and its enrollment `FOR UPDATE`;
   * run `decideSend` again. This is the complete step eligibility, proven coverage, the
     holiday-aware window, and the cap on the business date of this instant;
   * reserve the capacity: the conditional counter increment for that date;
   * claim: `prepared → dispatching`, writing the same business date onto the fence;
   * `COMMIT`.

   A refusal holds the fence inside the transaction. The step's `active_holds` row is
   opened after the commit. Every other exit before `COMMIT` rolls back, reservation
   included.
4. **Send, record, reconcile.** Unchanged, except the bytes sent are the *claimed* row's.

### The send gate

This is a per-workspace transaction advisory lock, `hashtextextended('fss.send-gate:' ||
workspace_id, 0)`, in `packages/domain/policy/sendGate.ts`.

* The claim holds it **shared**, from before its recheck until its commit.
* Every writer of a restrictive stop fact takes it **exclusive** in its own transaction:
  * `openHold`, which covers every hold: replies, ambiguity, pauses, mailbox health,
    review holds, the send path's own holds;
  * the direct hold inserts in `reassignFirm` and `commitDeparture`;
  * `recordSuppression`, `replaySuppressionJournal`, and a merge's
    `preserveFirmSuppressions`;
  * `setManualControlMode`;
  * `changeStage`, because Won and Lost stop automation;
  * `stopEnrollments`.

  The mail pipeline also takes it at the start of `applyClassificationEffects` and before
  it counts a direct send. That is for lock order, below.

Each claim and each stop now have a total order. A stop that took the gate first commits
before the claim reads, and the recheck sees it. A claim that took it first commits
before the stop can, so the send linearizes before the stop. Appendix B already accepts
that second order, because `dispatching` is irreversible. There is no third order.

### Why not row locks alone

A hold and a suppression are INSERTs into tables the dispatch reads by predicate. No
existing row is shared by the writer and the reader, so `FOR UPDATE` has nothing to lock.
Locking the fence and the enrollment still matters: every command that ends an enrollment
locks it first, and the fence's envelope is still mutable while it is `prepared`. Both
locks are kept alongside the gate, not instead of it.

### Why not a single conditional `UPDATE` or SERIALIZABLE

A single conditional `UPDATE` narrows the window to one statement's snapshot, but does
not close it. SERIALIZABLE isolation protects only transactions that are themselves
SERIALIZABLE, and every writer here runs READ COMMITTED. Even if they did not,
serializability without real-time order still allows the send to leave after the reply
has committed.

### Lock order

The claim takes the gate before any row. Writers take it before the rows the claim locks:
the fence, the enrollment and the send day. A writer that already holds one of those rows
and then asks for the gate can deadlock with a claim. PostgreSQL aborts one of the two.
That costs a retry, never a send: until `COMMIT` the claim has written nothing
irreversible, and Gmail is called only after it. The claim never asks for the gate
exclusive, which is why its refusal path opens `active_holds` rows *after* committing.

### One implementation, asked twice (S02)

The gate calls `decideStepPermission` (`outbound/stepPermission.ts`). That function runs
`composeEligibility()`, the same composition `runDueStepExecution` used to prepare the
fence. It adds `frozen`, the fence's route id and version and its template version, so
the questions at dispatch become about *this fence*:

* the frozen route must be `usable`, unretired, and at the version the fence froze. A
  version bump means the route's eligibility was re-decided;
* the frozen template version must still be approved and unretired.

The composition gains `enrollmentSource`: the enrollment is live and `active`, and the
execution is still its own. `holdSource` now also asks the owner's mailbox scope and the
step's channel scope, so an administrator's mailbox or email-channel pause is honoured.

The fence and the enrollment must still describe the same work: same firm, same
opportunity, and the enrollment's owner is the fence mailbox's owner. A mismatch is
refused.

Refusals from section 15 codes that have no send-refusal of their own (a reply's hold, a
pause, manual mode, a stopped enrollment, a reassignment) become the new
`step_ineligible`, with the code as the detail. `holdReasonForRefusal` opens no hold for
it, because the blocker already *is* somebody's hold or state. Before this, a reply's
hold surfaced as `provider_refusal` and opened a provider-shaped hold on the firm,
although Google had never been asked anything.

### Coverage is the watermark's age (S03), and no migration

`mailboxes` already separates the two instants the audit asks for:

* `last_synced_at` is the last **attempt**, written by a rate-limited failure too;
* `coverage_watermark_at` is the last **success**: 12.3's "instant through which every
  relevant message is known processed". It moves only when a sync finishes its history,
  or a recovery its interval, in the same statement as the cursor.

So coverage is proven when the mailbox is connected, `ready`, and its watermark is at
most `COVERAGE_FRESHNESS_SECONDS` (15 minutes) old on the database clock. The watermark
may also be at most `COVERAGE_CLOCK_SKEW_SECONDS` (5 minutes) in the future.
`mail/coverage.ts` is the one definition. `mailboxSource`, the gate through it, and the
ramp's day health all use it.

Fifteen minutes is five times the 13.3 heartbeat alarm, which fires after three missed
one-minute checks. A healthy mailbox's watermark is never more than a couple of minutes
old, because the check syncs every `ready` mailbox every pass and a sync with nothing new
still raises it. The window absorbs a capped backlog or a short 429, and bounds how long
a reply can sit unread before FSS stops writing to its author.

A stale mailbox holds as `coverage_incomplete`, exactly as an unproved one always has.
Automatic re-arming of held steps is lane L-D's (audit C02, C05), not this one's.

### The business date is the claim's (S05)

`decideSend` derives the workspace business date from its own decision instant
(`businessDateOf`). Inside the claiming transaction that instant is the claim, taken
from `clock_timestamp()` rather than `now()`, because the transaction may have waited on
the gate. The claim writes that date to `outbound_messages.business_date`. Migration 0010
names that column "the business date the cap counted this send against". The planned
date stays on the step's history.

### Holidays: the union of the frozen and the current calendar (S09)

The window check is `placeEmailSend(now, zone, { calendar }).inPlace`. That is the
placement rule itself, asked about the dispatch instant. The calendar is the union of
two:

* the version the enrollment froze;
* the workspace's current version.

The frozen version keeps a supersession from re-timing a cadence. That is a statement
about *when work is due*. The dispatch window is a licence: *is today a sending day at
all*. A holiday added this morning should stop today's sends whichever calendar planned
them. A holiday removed since enrollment was a day the step's own placement already
skipped, so honouring it costs at most that day.

### Capacity is reserved by the claim (C25)

The increment and the claim commit together or not at all. `releaseCount` is gone.
Every unit of `automated_sent` for a date is a fence claimed on that date, and
`claimedAutomatedSends` in `ramp.ts` derives the same number from the fences. A crash
before `COMMIT` leaves neither. After `COMMIT` the count stands whatever Google says,
because the message may have left. That is unchanged from G7-2.

### The claim refuses to run inside a caller's transaction

`SAVEPOINT` outside a transaction block is SQLSTATE 25P01. The dispatch uses that to
refuse a caller's transaction. A `BEGIN` inside one would only warn, and its `COMMIT`
would commit the caller's work while leaving the claim's durability to whoever called.

## What this does not cover

* A withdrawal of `sending_enabled` does not take the send gate. It is lane g71's
  section of `decideSend` (PR 211), and `updateSetting` has its own advisory lock. A
  claim racing a withdrawal by milliseconds can still send. The deployment flag is
  per-process and is not affected.
* Manual route edits and template retirement do not take the gate either. A claim is
  ordered against them by snapshot, not by lock. Bounces do take it: the bounce path's
  route invalidation opens a hold in the same transaction.
* Writers that run in autocommit mode get nothing from a transaction lock. Every writer
  that matters runs in a transaction: API commands, and every job handler except the
  `outbound_fence` one, which is the dispatch.

## How it is tested

* `packages/domain/test/outbound/dispatchRace.test.ts` enters the window through the
  real path: the Gmail client's token refresh commits a reply on another connection.
  Three replies are used: an uncertain one through the real mail sync, a confirmed one
  (manual mode and terminal stop), and an opt-out. A control with the same pause
  committing nothing still sends. `pg_locks` then shows the gate serializing in both
  orders, and a backend killed between the reservation and the commit leaves no count.
* `packages/domain/test/outbound/dispatchRecheck.test.ts` covers the rest:
  * a retired template, a re-versioned route and a `candidate` route;
  * manual mode, a stopped enrollment, a reassignment and an email-channel pause;
  * stale coverage, with a rate-limited sync that moves the attempt time but not the
    watermark, then a real sync;
  * a fence planned Monday and sent Tuesday;
  * a holiday in the current calendar and one in the frozen calendar.
* `apps/worker/test/sequenceActionDispatch.test.ts` drives the real `sequence.action`
  handler, the real hand-off and the runner, once to `sent` and once with a confirmed
  reply committing mid-dispatch.
* `test/release/scenario03.check.ts` now enters the race window (audit T02).
* Three mutations in `scripts/releaseMutationCheck.mjs`: the recheck removed, freshness
  removed, and the planned business date restored. Each turns its suite red.
