# G3a: the terminal-stop and Today-transfer hooks are an append-only outbox

**Date:** 20 September 2026 · **Lane:** G3a CRM core · **Spec:** 7.3, 8.1, Appendix A, Appendix C

## The tension

Two of this lane's deliverables describe a hook into a lane that does not exist yet.

* Section 8.1: "Closing an opportunity stops its active enrollments." Enrollments are
  lane G8's. The brief says to define the hook and not implement sequences.
* Appendix A, row *Reassign firm*: the assignee change, the reassignment hold, the
  future-work cancellation and "Today transfer" commit together. Today is lane G7's.

Both need something that commits *with* the business change, because Appendix A's
whole point is the "commits together" column — a terminal stop that could be lost
between the stage change and the enrollment stop is a sequence that keeps sending to a
firm that said no.

## The options

**A callback passed into the command.** Whoever calls `changeStage` registers what
should happen on a terminal stage. Rejected: a stage change arrives from the desktop,
from an import, from a merge closing the source's opportunity, and later from a call
outcome and a reply. Every one of those call sites would have to remember, and the one
that forgot would fail silently and in production.

**A `jobs` row.** The queue exists and is exactly the right shape for at-least-once
work. Rejected for three reasons: `JOB_KINDS` in `packages/domain/jobs/jobKinds.ts` is
a closed set lane G5 owns and this lane does not; `HandlerRegistry` refuses a kind with
no registered handler, so the worker could not claim it; and a job that exhausts its
attempts becomes a dead job, which raises `dead_job_unresolved` and pages an admin
about work nobody has written yet.

**An append-only outbox table.** Chosen.

## Decision

`crm_domain_events`, in migration 0004:

```sql
UNIQUE (workspace_id, event_kind, dedupe_key)
GRANT SELECT, INSERT ... ; REVOKE UPDATE, DELETE, TRUNCATE ...
```

`emitCrmDomainEvent` writes one row in the caller's transaction with
`ON CONFLICT ... DO NOTHING`, and `readCrmDomainEvents` reads a kind after a caller's
own high-water mark.

Seven kinds, each with the lane that will read it, are tabulated in
`docs/greenfield/crm.md`.

## Why this is safe to subscribe to

* **Committed or absent.** The row is written in the business transaction. A
  subscriber that sees it is looking at a fact; a rolled-back command left no signal.
* **Deduplicated by the database.** A command replayed under the same command id, or a
  handler run twice, produces one signal. The key is built in `emitCrmDomainEvent`,
  never at a call site.
* **Append-only by privilege.** No writer can rewrite history, and a subscriber's
  progress is its own business — which is what lets G8 and the Today lane read the
  same stream at different speeds without a shared cursor column they would contend on.

## What would change this

When G8 and G7 exist, the natural next step is a single worker job kind —
`crm.domain_event` — that drains this table and dispatches, added to `JOB_KINDS` by
whoever owns the queue at that point. The table would not change; it would gain a
reader. That is the reason the read function takes a caller-supplied watermark rather
than marking rows consumed: the table is already the right shape for it.

## Deviation from the brief

None. The brief says "define the hook, do not implement sequences", and this is the
hook. It is worth naming, though, that the terminal stop is a *signal* and not yet an
*effect*: until G8 subscribes, closing an opportunity stops no enrollment, because
there are no enrollments. The coordinator should treat G8's subscription to
`opportunity.terminal_stop` as a required follow-up rather than an optional one.
