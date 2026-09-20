# G8: this lane opens exactly one kind of hold

**Date:** 20 September 2026 · **Lane:** G8 sequences · **Spec:** 4.3, 11.1, 11.2, 15

## The tension

`runDueStepExecution` can refuse a due step for eleven reasons. Every one of them has a
name in section 15's closed vocabulary, and `step_executions.hold_reason_code` records
which. The question is whether each also becomes a row in `active_holds`.

## Decision

One does: `missing_variables`. Nothing else.

## Why

4.3: "Clearing one hold never clears another." `releaseHoldsOfEvent` matches on the
source event and the reason code, so the lane that opened a hold is the lane that
closes it. A second row copied from somebody else's hold would match nobody's release
statement, and the automation would stay blocked after the real cause cleared — the
exact failure that sentence exists to prevent.

More concretely, every other refusal *is already* a hold or a cap somebody else owns:

* a `scoped_pause`, `reassignment`, `uncertain_reply`, `ambiguous_match`,
  `coverage_incomplete` or `mailbox_disconnected` is a row G4, G3a or G7 wrote, and
  `holdSource` found it by reading `active_holds`;
* `firm_suppressed` and `handle_suppressed` come from G4's `effective_suppressions`
  view, which is not a hold and has no interval to shift by;
* `opportunity_manual` is a control mode, not a reversible blocker — 4.3 is explicit
  that `held` is not a third control mode, and the converse holds too;
* `daily_cap`, `domain_cap` and `outside_email_window` belong to the sending lane and
  are re-read inside its own fence, where the answer that matters is decided.

`missing_variables` is different because nobody else can see it. It is discovered while
rendering, by comparing a template's required variables against the CRM data for one
contact, and 11.1 makes it this lane's: "Missing required variables hold the step."
Section 15 lists it as recoverable, so it exposes a control, and the hold is scoped to
the enrollment with the step execution as its source event — which is what lets the
release clear this one and nothing else.

## The consequence a reader should know

`resumeEnrollment` puts held steps back to `pending` when the union clears, and it
skips the ones held for `missing_variables`. A schedule shift does not put a name into
the CRM, so a step whose variable is still missing would hold again on the next pass;
leaving it held is the honest state and keeps the reason visible on the card.
