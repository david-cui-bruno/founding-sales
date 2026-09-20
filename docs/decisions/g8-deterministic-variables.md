# G8: what counts as an eligible value for a deterministic template variable

**Date:** 20 September 2026 · **Lane:** G8 sequences · **Spec:** 11.1, 15

## The tension

11.1 says "Launch templates support deterministic variables from eligible CRM data"
and, two sentences later, "Missing required variables hold the step". It does not say
what makes a value eligible, and the difference matters most for the one variable that
is not a column: `contact_first_name`.

A contact's recorded name is free text somebody typed or a provider produced. Some of
those strings are names. Some are `?`, `-`, `N/A`, `unknown` and `(vacant)`.

## Decision

`packages/domain/sequences/variables.ts` holds the whole closed list, and a value is
eligible when it is present and non-blank. `contact_first_name` additionally requires
that the first whitespace-separated token of the full name:

* is at least two characters,
* contains at least one letter, and
* is not one of a short list of recorded placeholders.

A name that fails any of those has no eligible first name, the variable is absent, and
`renderTemplate` holds the step with `missing_variables`.

An absent value is *absent*, never an empty string: `renderTemplate` treats a blank as
missing, so a map carrying `''` would render a gap rather than hold.

## Why this and not the alternatives

**Substitute an empty string.** Rejected. "Hello ," is an email that tells the
recipient the sender does not know who they are, which is worse for Callie's
reputation than a step that held for a day.

**Fall back to the firm name.** Rejected. It is a guess, and a template author who
wrote `{contact_first_name}` asked for a person.

**Accept whatever is recorded.** Rejected for the reason above; `?` is recorded.

## What it costs

A contact genuinely named with a single letter — an initial — holds a step that could
have gone out. That is the conservative direction under spec silence, and the hold is
recoverable, named `missing_variables` in section 15's vocabulary, and visible on the
card with the variable that was missing.
