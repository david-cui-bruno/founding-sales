# G10: research has no scheduler source, and does nothing unless asked

**Date:** 20 September 2026 · **Lane:** G10 research · **Spec:** invariant 8, 13.1, 13.2

## Spec silence

Section 13.1 describes a one-minute scheduler pass that "finds due work through indexed
queries and inserts idempotent jobs", and `apps/worker/src/scheduler/sources.ts` says
in its own comment that "the sequence, Today, mail-sync, mail-recovery, watch-renewal,
**research** and retention sources are the lanes that own those tables".

The specification never says what makes research *due*. Every other kind in Appendix C
has an answer: a step execution reaches its due instant, a mailbox's watch approaches
expiry, a business date turns over. A territory does not become due.

## Decision

There is no `DueWorkSource` for either research kind, and `sources.ts` is not touched.
Both kinds are enqueued by:

* `POST /research/discover` — an admin command, per page;
* `POST /research/enrich` — a command, per firm;
* the discovery run itself, which returns the firms it created so its caller can
  enqueue enrichment for them.

## Why

**A sweep is a spend.** Discovery calls a paid provider. A scheduler that materialized
discovery pages would spend the workspace's research budget every minute it found the
day's ceiling unspent, which is a correct reading of "due" and an incorrect reading of
what a person wants. The ceiling would become a *target* rather than a limit.

**An enrichment is a re-read of somebody's website.** Refreshing a firm on a schedule
means requesting a prospect's pages repeatedly with no person having asked for any of
those requests. Section 7.4 caps and audits provider calls; it does not ask for them to
be generated.

**It is the conservative reading of invariant 8.** "Research never initiates outreach"
is about contact, and a scheduler source would not breach it. But the shape invariant 8
describes — research produces material, a person acts — is easier to keep true when
research also does not *start* on its own. A discovered firm that appeared overnight
with evidence nobody asked for is still a firm on nobody's list, and it is also a bill
nobody approved.

## What this costs

There is no automatic backfill. A person who wants a territory swept pages through it,
one command per page, following `nextPageToken` from each report. That is a real
ergonomic cost and the right place to pay it down is the client: a "sweep this
territory" button that issues the commands in sequence and stops at the day's ceiling,
which is UI rather than a scheduler.

## When this should change

When there is a *business* signal that makes an enrichment due — a firm whose evidence
is older than the retention policy's horizon and which has an open opportunity, say —
that signal is a `DueWorkSource`, and it should be added then, with its own ceiling. The
absence here is about not inventing one, not about refusing to have one.

Adding it is four lines, by construction: `docs/greenfield/jobs.md`'s "Adding a handler"
checklist, step 4. The scheduler pass takes an array and this lane did not change the
array, which is what keeps that true.
