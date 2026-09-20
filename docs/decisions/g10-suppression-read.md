# G10: how research reads a suppression before G4's view exists

**Date:** 20 September 2026 · **Lane:** G10 research · **Spec:** 10.2, invariant 4, 7.4

## Spec silence

The lane's acceptance list requires "a suppressed firm is never refreshed". The
specification does not say it: invariant 4 and section 10.2 are about email and
dialing, and research is neither.

Where the spec is silent, the common rule says take the conservative option. A
suppression is a prospect's answer, and continuing to re-read their website to add
evidence and suggestions against their record is not a thing to keep doing after it.
So research stops.

Section 10.2 also names the authority: "One `effective_suppressions` view is
authoritative for email and dialing." Lane G4 owns it, and it does not exist yet.

## Decision

`packages/domain/research/suppression.ts` reads `suppression_events` directly, with
this rule:

> A firm is suppressed when there exists a `scope = 'firm'` event whose
> `canonical_key` is the firm id, whose `source` is one of the four **suppressing**
> sources, and which has **no direct supersession**.

`SUPPRESSING_SOURCES` is `prospect_opt_out`, `prospect_do_not_call`,
`salesperson_manual` and `import`. The other two values the CHECK admits —
`mistaken_entry_correction` and `admin_supersession` — are rows in the same table, with
the same scope and the same canonical key, whose job is to *lift* the event they
reference.

Section 10.2 gives supersession the properties that make this safe: an event is
insert-only, "at most one direct supersession may reference an event", and the only
reasons are `mistaken_entry`, `correction` and `documented_reconsent`. So an event with
no supersession is a live request, and one with a supersession has been answered by
somebody entitled to answer it.

## The bug this found

The first version of the rule did not filter on `source`, and the test for "research
refreshes again once an admin has superseded the event" failed. A supersession event is
itself a firm-scoped row with the firm's canonical key and no supersession of its own,
so it satisfied the predicate — and every supersession re-suppressed the firm it had
been written to release, permanently and silently.

That is worth recording because the same trap is waiting for G4's view, and because the
fix is not obvious from reading `suppression_events`' schema: nothing in the table's
shape says which sources suppress and which lift, only the CHECK's list of six values.

## What is deliberately not consulted

**Handle suppressions.** Section 10.2 makes a handle suppression global across the
workspace, and its effect is that the *route* may not be used. It says nothing about
whether the firm's own website may be read, and a firm whose one published address is
suppressed still has facts worth recording. The route is refused at the point of use,
by G4.

## The swap when G4 lands

`isFirmSuppressed` and `suppressedFirmIds` are the seam. When `effective_suppressions`
exists, their bodies become a read of it and their signatures do not change, so the
change is one file. The `SUPPRESSING_SOURCES` constant should then be deleted rather
than kept beside the view — two places deciding what suppresses is how they diverge.

Until then, the direction of error is one-way: this rule can only ever say "suppressed"
about a firm a person could still research, never the reverse.
