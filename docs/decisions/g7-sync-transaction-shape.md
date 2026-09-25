# G7: a mail sync is bounded, and its continuation is the scheduler

**Date:** 20 September 2026 · **Lane:** G7 gmail · **Spec:** 12.3, 13.1, 13.2, Appendix A, Appendix C

## Two constraints that pull against each other

Appendix A's import flow fetches a message body *before* the transaction that applies
its effects, so a slow network call is not holding a write transaction open. G5's job
runner, on the other hand, runs a handler **inside** the transaction that completes the
job, and that is what makes `business_uniqueness` protection mean anything: a worker
whose lease was stolen has its work and its failed completion rolled back together.

A `mail.sync` handler cannot have both. It reads from Gmail and it writes, and G5 owns
the transaction.

## Decision

The handler runs inside the runner's transaction, and each run is **bounded**:
`DEFAULT_SYNC_MESSAGE_LIMIT = 50` messages and `DEFAULT_SYNC_PAGE_LIMIT = 20` history
pages. A run that hits either cap advances the cursor to what it actually processed,
leaves the coverage hold open, and returns `moreToDo`.

**Amended 25 September 2026 (lane g76).** "What it actually processed" is measured in
whole Gmail history records: a run takes records until it holds 50 messages and never
part of one, and its cursor is the last record's id, compared as a uint64. Until then
the cursor a capped run wrote was the one it began from.
`docs/decisions/g76-history-records-are-the-unit-of-progress.md` has the defects and
the reasoning.

The continuation is not the handler's job. It is the one-minute scheduler.

## Why the run cannot re-arm itself

This was the subtle one, and it was got wrong first.

The obvious continuation is for a capped run to call `coalesceMailSync` for its own
mailbox before it returns. It does not work: the handler is executing inside the
runner's transaction, and its own job row is `running` in that same transaction. The
coalescing upsert would therefore *merge into the row it is currently executing*, and
the runner would immediately mark that row `done` at commit. The continuation would be
erased by the thing that scheduled it, and the mailbox would stop mid-history with a
clean-looking job log.

The same applies to `mail.recover` and `rearmRecoveryJob`.

So both self-re-arms were removed, and the continuation lives in
`apps/worker/src/scheduler/mailSources.ts`, on a connection that is not the runner's:

* `mail-sync-reconcile` coalesces a sync for every connected, `ready` mailbox on every
  pass (it was: whose `last_synced_at` is older than five minutes; see the amendment
  below);
* `mail-recovery` re-arms the `mail.recover` job of every recovery that has not
  completed at the mailbox's current generation.

Worst case, a capped run resumes a minute later (five, before the amendment). The alternative — an unbounded run
— is a handler holding a write transaction open across an arbitrary number of Gmail
calls, which is how a database ends up with a two-hour-old snapshot and a table it
cannot vacuum.

## Why the sweep is also the answer to lost push

Push is a hint, not a guarantee, and it fails silently in at least three ordinary ways:
a watch lapses, Pub/Sub exhausts retention while the API is down, the webhook refuses a
token through a rotation. The reconciliation sweep is the same mechanism answering that
problem, which is why it is a sweep over mailboxes rather than a queue of continuations.

**Amended 24 September 2026 (lane g58).** The five-minute filter made the sweep a
five-minute check while the mailbox heartbeat promised one a minute, and 13.3's
"three missed one-minute mailbox checks" alarm fired between healthy checks on
production's first mailbox. The sweep now asks for every connected, `ready` mailbox on
every pass, which is also what 12.3's "one-minute reconciliation" says. The cost is
one token refresh and one `history.list` a minute per mailbox; `docs/greenfield/mail.md`,
"The mailbox check, once a minute", has the numbers.

## What the sweep must not do

13.2 makes reviving an exhausted job "requeueable only by an audited admin command". A
scheduler is not an admin. So the sweep uses `coalesceMailSync`, which re-arms a `done`
job and leaves a `dead` one exactly as it is — and there is a test for precisely that,
because the tempting bug is a sweep that silently resurrects a sync failing every time
and makes a broken mailbox look busy.

## Where the body fetch still honours Appendix A's intent

Appendix A's real concern is not the literal ordering but the amount of network held
inside a write. The bound is what answers it, plus one rule the pipeline enforces: a
body is fetched **only** after the message has a plausible FSS match. An unmatched
message costs one metadata read and nothing else, so the common case — a mailbox full
of mail that is nothing to do with FSS — never fetches a body at all.
