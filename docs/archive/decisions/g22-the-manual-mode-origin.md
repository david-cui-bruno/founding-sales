# G22: manual mode records the origin, and the confirmed reply stops in its own transaction

**Date:** 22 September 2026 · **Lane:** G22, the G15 follow-ups · **Spec:** 7.3,
8.1, 8.3, 12.4, 13.4, Appendix A ("Confirm human reply", "Stage change", "Log call
outcome"), invariant 3

## The two things G15 left open, and why they are one change

`docs/archive/decisions/g15-the-worker-drains-what-the-lanes-left.md` named both:

> The end reason is `human_reply` for all of them. `ENROLLMENT_END_REASONS` also holds
> `engaged_call` and `direct_send`, and the signal cannot distinguish them … **This is
> a deviation worth a follow-up:** the honest fix is for the lanes that cause the other
> two … to stop their own enrollments in their own transaction, which is what Appendix
> A's "commits together" column asks for anyway.

G15 was right about the diagnosis and half right about the remedy. Two distinct facts
were missing and they need different answers.

1. **The signal did not carry the origin.** Every `opportunity.manual_mode` row said
   `reason_code = 'opportunity_manual'` and a free-text sentence, and G15 correctly
   refused to parse English to pick a stored code. The fix is to write the fact down.
2. **The confirmed reply's stop was not in the confirmation's transaction.** 7.3 says
   it is, in as many words, and the drain — however good a net — cannot be the
   mechanism for a sentence that begins "performs one transaction".

## 1. The origin is a field, not an inference

`MANUAL_MODE_ORIGINS` in `packages/domain/crm/events.ts` is 7.3's four ways in plus one:

| Origin | Written by | `end_reason` |
|---|---|---|
| `human_reply` | `confirmReplyDisposition`, `resolveAmbiguity` when the reply is human | `human_reply` |
| `linkedin_reply` | `recordLinkedInResult` | `linkedin_reply` |
| `engaged_call` | `logCallOutcome` | `engaged_call` |
| `direct_send` | `applyDirectSendEffects` | `direct_send` |
| `salesperson_command` | `POST /opportunities/manual` | `admin_stop` |

`setManualControlMode` takes it as a **required** parameter, not an optional one with a
default. That is the whole point: G15 recorded `human_reply` for everything precisely
because the signal let a caller say nothing, and a default would let the next caller
inherit somebody else's answer without noticing. It is a separate parameter from
`reason`, because the reason is a sentence a person reads and the origin is a code a
consumer acts on; conflating them is how the coarse reason happened in the first place.

It is stored in `crm_domain_events.detail.origin` — jsonb, `NOT NULL DEFAULT '{}'` —
so **no migration was needed**. The alternative, a `manual_mode_origin` column with its
own CHECK, would be a migration, a schema-range widening and a contract migration for
one enumerated string that only one consumer reads.

`salesperson_command` is the fifth member and the one 7.3 does not list. An explicit
switch through the API is a person inside the workspace deciding, not a prospect signal,
and `ENROLLMENT_END_REASONS` reserves its first five members for prospect signals;
`admin_stop` is the member that means "somebody inside decided", which is what
`endReasonFor` already uses for a terminal stop the pipeline does not corroborate.

### Every existing reader keeps its answer

`manualModeEndReason(null)` is `human_reply`, and so is `manualModeEndReason` of any
string it does not recognise. Every `opportunity.manual_mode` row written before this
lane carries no origin, and `human_reply` is exactly what G15 recorded for it, so a
release that lands mid-stream reads the backlog the way the previous release did. The
alternative — refusing an event with no origin — would leave a sequence live after a
firm had said no, which is the one outcome invariant 3 forbids. Fail-closed here means
*stop*, not *refuse to stop*.

`crm_domain_events` is append-only by privilege, so there is nothing to backfill and
nothing that could be backfilled. The old rows stay honest about what was known when
they were written.

### The dashboard needed no change

13.4's enrollment source groups the window's ends by `end_reason`
(`packages/domain/dashboard/enrollmentSource.ts`), so it shows the precise reason the
moment the reason is precise. That is what "show it where they show it at all" comes to,
and `test/sequences/scenarios.test.ts` asserts it end to end: an `engaged_call` stop
appears in `enrollmentFacts().ended` as `engaged_call` and `human_reply` is absent.

## 2. The confirmed reply's stop moved into the confirmation

7.3: "A confirmed human reply performs **one transaction**: record and classify the
message; set manual; terminally stop every active enrollment for the firm across
contacts; cancel unclaimed executions; hold any irreversible dispatch fence; create or
promote the reply-lane Today entry; and write the audit event." Appendix A's row lists
the same things under "commits together" and locks "all firm enrollments and
nonterminal executions".

Before this lane the stop was none of that. `confirmReplyDisposition` set the control
mode, emitted the signal and returned; the enrollment ended on the next one-minute
worker pass. Two consequences, both real:

* **Between the two, the sequence was live.** `sequence.action` reads control mode and
  holds before dispatching, so no email left — the send gate is not what was broken —
  but the enrollment was on the board as live work and its next step was pending.
* **A drain that failed for its own reasons took the stop with it.** The
  `sequence.terminal_stop` job drains every outbox event for the workspace *and* the
  whole suppression-marker stream in one transaction, which G15 chose deliberately so
  the cursor cannot disagree with the stops. The price it named — "a failure rolls back
  every firm's stops in that pass rather than one firm's" — includes this firm's.

So `confirmReplyDisposition` now calls `applyManualModeStop`, in its own transaction,
and the drain calls the same function for the origins nothing commits at the source.

### Why running both is the design and not a tolerance

`stopEnrollments` locks and updates only enrollments with `ended_at IS NULL`, and
`auditStops` audits only the ids it actually ended. So the drain reads the same event
through its `(occurred_at, id)` keyset cursor, finds an empty live set, stops nothing
and writes no second audit event. The idempotence is keyed on the event — the cursor
never re-reads a consumed row — and backed by the enrollment's own end, which a replay
cannot undo. `test/classification/confirmation.test.ts` proves both halves by failing
the surrounding work: the drain's suppression half throws, the pass rolls back, the
confirmation's stop still stands with one audit event, and a subsequent successful drain
consumes the event and stops nothing.

### What was considered and rejected

* **Per-event transactions inside the drain.** The natural reading of "its own
  transaction" applied to the worker. It cannot be had there: the runner wraps a
  `business_uniqueness` handler in one transaction and must roll it back when the
  completion loses the lease, PostgreSQL treats a nested `BEGIN` as a no-op, and a
  savepoint does not survive the outer rollback. Making the handler own its
  transactions means giving up the stolen-lease rollback that makes the drain safe.
  Moving the stop to the transaction that causes it gets the property the sentence
  wants without weakening the net.
* **A new `consequences` member.** `mail_reply_confirmations_consequences_known` is a
  closed list and `enrollments_stopped` is not in it, so adding one is a migration.
  Nothing is missing without it: `opportunity_manual` is the consequence 8.3 names, the
  stop is what 7.3 says that consequence *is*, and `enrollment.terminally_stopped` is
  the audited, per-enrollment record.
* **Stopping at the other three sources too** (`logCallOutcome`,
  `applyDirectSendEffects`, `resolveAmbiguity`). G15 suggested it and Appendix A's rows
  for those commands are less explicit than the confirmation's: "Log call outcome"
  commits "call history and outcome effects", and `recordLinkedInResult` already stops
  in its own transaction. With the origin on the event, the drain now records the right
  reason for all of them within a minute, and 7.3's "one transaction" sentence is about
  the confirmed reply specifically. Left to a later lane rather than widened here; the
  brief asked for the reason to be precise and for the confirmation to be atomic, and
  both are.

## The one behaviour change beyond the reason

The drain's manual arm is now **firm-wide**. 7.3 says "terminally stop every active
enrollment for the firm across contacts" and Appendix A says "all firm enrollments";
G15's loop scoped every `opportunity.%` event to its opportunity, which every such
event names, so the firm-wide clause could never fire. An enrollment still live against
a firm's earlier closed opportunity survived a reply that said no. 8.1's close keeps its
own opportunity scope, which is what that sentence says. The change only ever stops
more, never sends more.

## No migration

None, and none was close. The origin is a key in a jsonb column that exists; the stop
is a call in an existing transaction; the firm-wide widening is a predicate. Schema
ranges are untouched at `{15, 15}`, which lane G20's migration 0015 set.
