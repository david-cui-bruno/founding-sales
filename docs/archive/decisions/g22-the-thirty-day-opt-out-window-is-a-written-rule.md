# G22: the thirty-day opt-out window stays a written rule, and the code says nothing about it

**Date:** 22 September 2026 · **Lane:** G22, the G15 follow-ups · **Spec:** 12.6,
invariant 4, section 10.2 · **Source:** the 21 September deviations sweep, part 1
item 24; David's decision 3 of 21 September 2026

## The sweep item

`.context/FSS-DEVIATIONS-FROM-SPEC-20260921.md`, item 24:

> Per-mailbox 30-day opt-out processing window (your 19 Sep note) | Opt-out obligation
> tracked per mailbox | No column, constraint or rule implements it, and no document
> says it was deferred | **Decided 21 Sep: written operational rule for v1 (G15
> documents it); guard later**

This lane's brief asks: "if any code path still implies enforcement, align the docs and
the code and say which way you went."

## What the code says

Nothing, and it was checked rather than assumed:

* No column, CHECK or index anywhere in `packages/domain/db/migrations/**` mentions a
  thirty-day window, an opt-out deadline or an opt-out-processing state. The only
  `INTERVAL '30 days'` literals in the tree are two retention policies in migration
  0014 (`unmatched_gmail_metadata`, `canceled_drafts`), which are about deletion.
* `effective_suppressions` (migration 0006) has **no time term at all**. A suppression
  is effective from the moment its event commits and is ended only by an explicit,
  audited supersession. There is no expiry, no lapse and no window.
* `disconnectMailbox` and `POST /gmail/disconnect` refuse nothing on these grounds. The
  thirty-day *mailbox lifecycle* rule — "a mailbox that has sent automated mail in the
  last thirty days is not disconnected" — is an operating rule too, recorded by lane
  G15 in `docs/greenfield/mail.md` and `docs/greenfield/release.md` section 6, and the
  refusal-with-audited-override is explicitly a later lane's.
* The only thirty-day figure the software acts on is the `MailboxDisconnectedHours`
  alarm, which is 12.6's own sentence ("a mailbox that sent in the last 30 days and
  remains disconnected for 48 hours") and is a metric, not a permission.

So no code path implies enforcement, and none was removed.

## Which way this lane went, and why

**The docs were aligned to the code, and the rule was left written.** The alternative —
building the window — was not this lane's to build (David's decision 3 defers the
guard) and would not improve the behaviour, because the code is already stronger than
the rule it would enforce.

A processing window is a deadline for acting on a stop that is sitting unprocessed.
Invariant 4 is "suppressions are effective immediately and database-enforced", and
`decideSend` reads `effective_suppressions` before every single dispatch, so a
reply-based stop takes effect at the next send attempt and never lapses. FSS has no
queue of unprocessed opt-outs for a deadline to apply to. Zero days is inside thirty.

What version one genuinely lacks is not enforcement but **evidence**: a per-mailbox
record that the obligation was met, which is what a guard lane would add (a refusal on
the disconnect route, an audited admin override, and a report an operator can show).
That is stated as the gap rather than implied by its absence.

`docs/greenfield/mail.md` gained the paragraph, under "Mailbox lifecycle: the thirty-day
rule", so that the two thirty-day rules live beside each other and neither reads as a
guard.
