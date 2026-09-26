# G0: how a daylight-saving gap resolves

**Spec silence.** Appendix G 32 requires that "DST gap and fold resolve
deterministically". It does not say *which* instant a skipped wall-clock time becomes.

**Decision.** A gap resolves **forward**, to the first instant the clock allows. A fold
resolves to the **first** of its two readings.

## The gap

02:30 on Sunday 8 March 2026 does not exist in `America/New_York`: the clock goes
straight from 01:59:59 EST to 03:00:00 EDT.

* The old module (`cloud/lambdas/delegated-worker/src/v1/localClock.ts`) settles on
  `2026-03-08T06:30:00Z`, which reads as **01:30 EST** — an instant *before* the wall
  clock that was asked for.
* `packages/domain/src/rules/localClock.ts` resolves to `2026-03-08T07:30:00Z`, which
  reads as **03:30 EDT**.

The conservative option under COMMON-G is the one that never does work earlier than
the time it named. A sequence step due at 02:30 that fires at 01:30 has been moved
into a window the scheduler did not authorise; one that fires at 03:30 has waited.
Waiting is always acceptable in this system — "a held or skipped email is acceptable;
a duplicate is not" — and being early is not.

The implementation keeps the old module's two-step offset correction and adds one
check: if neither candidate reads back as the requested hour and minute, the gap is
real, and the later of the two candidates is taken.

## The fold

01:30 on Sunday 1 November 2026 happens twice. Both modules choose the first, still on
daylight time (`2026-11-01T05:30:00Z`). The rule that matters is that the function is
a function: calling it twice gives one instant, so a fold is never two due times and
never two sends.

## Where this is tested

* `packages/domain/test/domain/calendar.test.ts` — both transitions, with the real
  2026 United States dates.
* `packages/domain/test/oracle/portedModules.test.ts` — asserts the old answer and the
  new answer side by side, so the divergence is a recorded claim. Every *ordinary*
  wall-clock time still resolves identically in both modules, across six zones.
