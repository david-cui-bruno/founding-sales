# G0: how the old modules are run as an oracle

**The brief.** "Run every ported module's old tests as an oracle where they exist."

**Decision.** Rather than copying the old expectations into new assertions, the old
*modules* are imported and executed in the same process as the ported ones, on the
same inputs, and the two answers are compared. The old code is the oracle, not a
transcription of what it used to say.

This lives in one file: `packages/domain/test/oracle/portedModules.test.ts`. It is the
only thing in the greenfield tree that reaches into `src/` or `cloud/`.

**What it covers.**

| Ported module | Oracle |
|---|---|
| `suppressionCanonicalization` | `src/main/domain/source/contactNormalization.ts` — every generated phone and address shape, refusals included |
| `localClock` | `cloud/lambdas/delegated-worker/src/v1/localClock.ts` — six zones, seven instants, and both daylight-saving transitions |
| `callingWindow` | `cloud/lambdas/delegated-worker/src/v1/callWindow.ts` — 192 consecutive hours across three window configurations |
| `templates` | `src/shared/contracts/replyTemplateContract.ts` — every shared text rule |
| `statePosture` | `src/shared/contracts/territoryClearanceContract.ts` — statements, federal citations, per-state rules and the state tables, byte for byte |
| `replyClassification` | `src/main/outreach/replyClassification.ts` — a corpus mapped through the old five-way vocabulary |

**Not covered, and why.** `cloud/lambdas/delegated-worker/src/v1/sequence.ts` imports
`dynamoStore`, which imports `@aws-sdk/client-dynamodb`. Running it would mean
installing the Lambda package's own lockfile into a tree that is being replaced. The
one rule ported from it, `startAnchoredDueAt`, is three lines of arithmetic and is
reproduced with its own cases in `test/domain/calendar.test.ts`.

**`test/oracle/**` is excluded from the greenfield typecheck.** Those old files are
written against the old, looser `tsconfig.json`; compiling them under
`tsconfig.base.json` (strict, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`) would report dozens of errors in code this lane does not
own and must not edit. Vitest still transpiles and runs them, so the oracle is real;
only `tsc` skips them. The exclusion is one line in `packages/domain/tsconfig.json`
with the reason written beside it.

**This file is temporary by construction.** It is deleted with the old trees. Until
then it is the only thing that would notice a ported rule drifting from the behaviour
the old build shipped.

**Two deliberate differences are recorded in the oracle rather than hidden:**

1. A daylight-saving gap resolves forward — see `g0-dst-gap-resolution.md`.
2. The bounce pattern recognises "Delivery has failed to these recipients", the
   wording Gmail's own notification uses. The old pattern was
   `delivery (?:failed|failure)`, which misses it, so the old module called a real
   bounce ambiguous. The oracle asserts both the old answer and the new one, so the
   widening is a recorded claim rather than a silent divergence.
