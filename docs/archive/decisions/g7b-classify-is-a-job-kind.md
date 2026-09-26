# G7b: the model call is a job, and it is enqueued by a sweep

**Date:** 20 September 2026 · **Lane:** G7b reply classifier · **Spec:** Appendix A "Record uncertain or ambiguous reply", Appendix C, 12.4

## The silence

Appendix A's reply flow ends with the deterministic classification, the holds, the
today-list item and the message committing in one transaction, and then: *"LLM
classification may be queued."* It does not say by what, and Appendix C's job table
does not list a kind for it.

Three questions follow. Is the model call part of the sync transaction? If it is a
job, which kind and which protection? And who enqueues it?

## Decision

**It is a job**, kind `classify.reply`, protection `business_uniqueness`, idempotency
key `classify-reply:<messageId>`, `maxAttempts: 2`, a 120-second lease.

**It is not part of the sync.** A network call to a third party inside the transaction
that writes a person's mail would hold a database transaction open for the provider's
latency, and would make a provider outage into a sync failure — a mailbox that stops
reading mail because a classifier is down is precisely backwards, since the
deterministic layer and the hold are what actually protect the salesperson.

**A scheduler source enqueues it**, not the sync. `classifyReplySource()` lists
messages whose deterministic row says `uncertain` and which have no `model` row yet,
and enqueues one job each, up to `CLASSIFY_SWEEP_LIMIT` per pass. The partial index
`mail_message_classifications_uncertain_deterministic (workspace_id, mail_message_id)
WHERE layer = 'deterministic' AND class = 'uncertain'` is what makes that query cheap.

## Why a sweep rather than an enqueue at the end of the sync

The honest reason first: G7-1's `pipeline.ts` is another lane's file and this lane may
not edit it. That constraint is real, but the sweep is also the better shape, and
would have been worth arguing for anyway.

An enqueue inside the sync transaction is an enqueue that rolls back with it, which is
fine, but it also means the sync has to know that a classifier exists, has to know
whether this deployment has one, and has to decide what to do when the job table
refuses the insert. A sweep knows all three by construction: it runs in the worker
that has the classifier, it finds the work by looking at what is actually unanswered
rather than at what was recently written, and a message the sweep missed on one pass is
simply on the next one.

It also recovers by itself from the two failures that matter. A worker that died
between the sync and the enqueue leaves an uncertain message with no job; under a
sweep that message is picked up thirty seconds later. A deployment that ran for a week
with the classifier switched off, and then switched it on, classifies the backlog
without anybody writing a backfill script.

The cost is latency — a reply waits for the next pass rather than being enqueued the
instant it lands — and Appendix A's "may be queued" is explicitly relaxed about that.
The person is not waiting on the model either way: the card exists the moment the
deterministic layer runs, and the hold is already on.

## What this required outside the lane

`packages/domain/jobs/jobKinds.ts` is a shared file and this lane added three lines to
it: `'classify.reply'` in `JOB_KINDS`, `'classify.reply': 'business_uniqueness'` in
`JOB_KIND_PROTECTION`, and `classifyReply` in `jobIdempotencyKey`. There is no way to
add a job kind without touching it — the whole point of that file is that the kinds
are enumerated in one place — and the edit is additive.

`apps/worker/src/bootstrap/main.ts` is the composition root and gained the source and
the handler registration, for the same unavoidable reason.

## The tests that hold it

`apps/worker/test/classifyHandlers.test.ts`:

* the protection matches Appendix C's table;
* nothing is registered when the process has no API key, and nothing when
  `FSS_CLASSIFIER=off`;
* one job per pending message, and **no second job on a repeat pass** — which is the
  sweep's real risk and the reason the idempotency key is the message id;
* the `runTwiceUnderStolenLease` probe produces exactly one model row (Appendix G 2);
* a message that already has an answer is not asked again.
