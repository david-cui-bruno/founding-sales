# G7-2: `held → prepared` is the one reverse edge, and it has to be

**Date:** 20 September 2026 · **Lane:** G7-2 sending · **Spec:** 12.5, Appendix B

## What Appendix B lists

```
prepared → dispatching → sent
dispatching → reconciling → sent | unknown_terminal
prepared → held
```

Six states, five edges, and no way out of `held`. Taken literally, a fence that was
held is held forever.

## The problem that creates

`held` is the state Appendix B's failure table assigns to "local validation, hold,
policy, coverage, window, or cap failure". Every one of those is *temporary*:

* a daily cap lifts at midnight;
* a sending window opens at 08:00;
* a coverage hold lifts when the recovery finishes;
* the domain guard lifts as the rolling window moves.

And 12.5 forbids the obvious workaround. "Partial unique indexes enforce one fence per
origin" means a step execution that was held cannot be given a second fence. So a
literal reading produces a system where the first email that arrives outside the
window is never sent at all, by anything, ever.

## Decision

`held → prepared` exists, and it is the only edge in the machine that goes backwards.

`releaseFence` is one `UPDATE ... WHERE state = 'held'`, and `dispatchOutboundMessage`
takes it automatically when it finds a held fence: release, re-run the gate, and let
the gate decide again from the current state of the world.

## Why it is safe, and why no other reverse edge would be

The whole of the argument is the definition of `held`. Appendix B's table says a hold
is set on a local failure and *"never enter dispatching"*. A held fence therefore
provably made no Gmail request: there is no attempt token, no dispatch timestamp, and
the state machine offers no path from `dispatching` to `held` for one to have arrived
by. Re-preparing it risks nothing, because nothing happened.

That argument does not extend anywhere else. `dispatching → prepared` would be a
second authorization to call Gmail for a fence that may already have sent, which is
the exact failure the fence exists to prevent. `reconciling → prepared` would be the
same thing one step later. Neither exists, and the trigger refuses both.

The trigger is what makes this a design rather than a convention:

```sql
(OLD.state = 'prepared' AND NEW.state IN ('dispatching', 'held'))
OR (OLD.state = 'held' AND NEW.state = 'prepared')
OR (OLD.state = 'dispatching' AND NEW.state IN ('reconciling', 'sent'))
OR (OLD.state = 'reconciling' AND NEW.state IN ('sent', 'unknown_terminal'))
```

Four lines, and every edge that is not one of them raises.

## The stale hold it must also clear

A held fence has an `active_holds` row recording why. When a new attempt releases the
fence it releases that hold too, because the gate is about to re-decide every one of
those questions from the database — last attempt's answer is stale by definition.
Leaving it would be worse than useless: the hold would be found by the *next* gate run
and become the reason the fence is refused, so a fence held by Monday's cap could never
send on Tuesday. The one exception is `send_unknown_reconciling` and
`send_unknown_terminal`, which no held fence can have and which only an admin's answer
ends.

## What a reviewer should check

That `holdFence` is reachable only from `prepared`, and that nothing in
`packages/domain/outbound` writes `state = 'prepared'` except `releaseFence`. Both are
one grep, and together they are the whole safety argument.
