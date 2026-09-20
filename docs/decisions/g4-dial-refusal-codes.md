# G4: the refusals section 15 has no word for

**Date:** 20 September 2026 · **Lane:** G4 policy, suppression, dialing · **Spec:** 9.2, 15

## The tension

Section 15 lists the closed reason codes, and G0 seeded exactly that list into
`hold_reason_codes`, with a test comparing the table against the `@fss/contracts` enum
row for row. The brief asks `authorizeDial` to refuse "with the exact reason codes of
spec 15".

But section 9.2's eight steps produce refusals section 15 has no word for. There is no
code for "that calling identity is not yours", none for "the card you are looking at
shows version 1 of a route now at version 2", and none for "this firm's zone has never
been established" — although the CRM already has `zone_unresolved` for the last of
those.

## Decision

Two sets, in `packages/contracts/src/dial.ts`.

`DIAL_HOLD_REFUSAL_CODES` is a subset of section 15's vocabulary, spelled identically,
covering every refusal that is also a hold: suppression, the route's four eligibility
states, the window, the three posture failures, the pause, the restore.

`DIAL_REQUEST_REFUSAL_CODES` is the rest: `firm_unknown`, `not_assigned`,
`zone_unresolved`, `route_version_stale`, the five identity refusals and the four
ticket refusals.

`hold_reason_codes` is untouched. No new row, no migration, no change to the enum G0
seeded.

## Why not add them as hold reasons

Because none of them is a hold. Section 15's second paragraph says what a hold is:
"Holds name blocked action kinds, reason, scope, firm, owner, source event, start, and
permitted recovery action. Only explicitly recoverable holds expose controls."

A calling identity that belongs to somebody else has no scope, no start and no
recovery action. There is nothing to release and nothing to wait for; the request was
simply about the wrong thing. Writing an `active_holds` row for it would put a row in
the table that no control can clear and no interval can shift, and section 4.3's union
arithmetic would start counting a typo as downtime.

## The consequence a reader should know

A caller switching on a dial refusal has to handle both sets. That is deliberate:
`DIAL_REFUSAL_CODES` is their union and the zod enum is over the union, so the
distinction is visible only to code that wants it — the client's banner asks whether
the code is in `DIAL_HOLD_REFUSAL_CODES` to decide whether to offer a "try again when
it clears" affordance.
