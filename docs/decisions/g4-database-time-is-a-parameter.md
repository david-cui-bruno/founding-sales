# G4: database time is a parameter, not a call

**Date:** 20 September 2026 · **Lane:** G4 policy, suppression, dialing · **Spec:** 9.2, 10.2, Appendix D

## The rule

`authorizeDial`, `selectApplicablePosture` and `evaluateConfiguredCallingWindow` all
take the instant they decide at. They do not call `now()` and they do not read the
process clock.

`authorizeDialCommand` and `finalizeManualSuppression` read `databaseNow(context)`
once when the caller did not supply one, and pass the value down.

## Why

**One decision, one instant.** `authorizeDial` makes eight checks across four tables.
If each read its own `now()`, a posture could expire between step 6 and step 7 and the
refusal would name neither the state the posture was in nor the state it became. The
ticket would then record a posture version that was not applicable at the moment it
was minted.

**It is the database's clock, not the process's.** Section 10.2 says "within ten
minutes of database time" and 9.2 says "whose effective range contains database time".
A worker with a skewed clock must not be able to finalize a suppression early. So the
value comes from `SELECT now()`, on the same connection, inside the same transaction.

**It is the pattern G0 already chose.** Every ported rule in
`packages/domain/src/rules/` takes `now` as an argument, and their tests are
deterministic because of it.

## The thing to watch

A parameter a test can set is a parameter production could set wrongly. Two
mitigations:

* the API route never supplies one. `authorizeDialCommand`'s `at` is optional and the
  route omits it, so production always reads the database.
* the ticket's own `issued_at` and `expires_at` are `now()` and
  `now() + make_interval(secs => 60)` computed **in SQL**, never from the parameter. A
  caller who passed a false instant would change which posture and window were
  evaluated, and would still get a ticket that lives sixty real seconds from now.

The second is the one that matters. A dial decision made at a false instant is a bug;
a ticket that lived an hour would be a hole.
