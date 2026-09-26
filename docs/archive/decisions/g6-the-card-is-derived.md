# G6: the Today card is derived by the database, not written by a command

**Date:** 20 September 2026 · **Lane:** G6 Today list · **Spec:** 8.2, Appendix A

## The question the specification leaves open

Section 8.2 says what a card contains — "Its card shows aggregate counts such as
replies, emails due, calls due, and LinkedIn tasks due", "The firm's lane and sort
instant come from its highest-priority and earliest-due unfinished item" — and it says
that promotions "commit with their source event". It does not say who *writes* the
card.

The obvious answer is the code that changes a task: the build writes the card after
writing the items, the reply promotion updates it, the callback promotion updates it,
the snooze updates it. Four writers of one invariant.

## What was chosen

One SQL function, `today_refresh_card(workspace, snapshot_date, firm)`, and a row
trigger on `today_items` that calls it after every insert, update and delete. No
application code writes `today_snapshots` at all.

## Why

**The invariant survives a writer that forgets.** "The firm's lane and sort instant come
from its highest-priority and earliest-due unfinished item" is a property of the item
rows. Recomputing it *from* the item rows, on the event that changed them, means there
is no code path that can change a task and leave a stale card — including a path this
lane has not seen, because G7's reply promotion and G8's due work both write items and
neither has to know the card exists.

**It is how a promotion can commit with an event in another lane's file.** Appendix A
requires the Today entry to commit with the callback that created it and with the
reassignment that transferred it. Both of those are written in files this lane does not
own (`packages/domain/dial/callbacks.ts`, `packages/domain/crm/firms.ts`) and must not
edit. A trigger is the one hook that cannot be forgotten by a caller and cannot be
committed separately from what caused it. `callbacks_today_promotion` and
`firms_today_transfer` are that, and the rolled-back-callback test is the proof.

**It makes the merge case work rather than fail.** A firm merge cascades
`contacts.firm_id` into `today_items`. With a foreign key from items to a card that had
to exist first, the merge would fail against a target firm with no card. With the card
derived, the cascaded update fires the trigger and both cards are correct afterwards.

## What is given up

**A build of N tasks recomputes each firm's card once per task.** The trigger is
`FOR EACH ROW`, so a firm with five due emails recomputes five times. At version one's
volumes — one salesperson, tens of firms — that is a few hundred indexed aggregates a
morning. A statement-level trigger over the transition tables would be the fix if it
ever mattered, and it is a change to one function.

**The recompute is SQL, so its rules are not in the TypeScript the rest of the lane is
written in.** That is mitigated rather than avoided: `packages/domain/today/lanes.ts`
states the same precedence and ordering as pure functions, `test/today/lanes.test.ts`
proves they are a total order, and `test/today/determinism.test.ts` proves the SQL
agrees by building the same data twice on two databases and comparing the lists. The
duplication is deliberate and tested, which is not the same as drift.

**A card can outlive its reason.** When the last task is finished the row stays with
`open_items = 0` rather than being deleted. That is wanted — it is the record of what
that day's list contained — and every reader filters on it.
