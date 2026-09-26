# G6: delaying an automated send opens a hold directly, and the server decides which

**Date:** 20 September 2026 · **Lane:** G6 Today list · **Spec:** 8.2, 4.3, 10.1, 15

## The sentence

"Salespeople may snooze manual tasks with a required reason and explicit return
instant. Automated sends are not snoozed ad hoc; delaying them creates a recorded
hold."

Two questions it leaves open: *which* hold, and *who decides* that a task is automated.

## Which hold

A `active_holds` row with `reason_code = 'scoped_pause'`, `scope_kind = 'firm'`,
`blocked_action_kinds` the one kind the task belongs to (`email_send`, `call_task` or
`linkedin_task`), `source_event_kind = 'today.delay_requested'`, `source_event_id` the
task's id, and `recovery_action = 'release_pause'`.

It is **not** an `administrative_pauses` row, which is what `openPause` in
`packages/domain/policy/pauses.ts` would have written. Section 10.1's pause is an
admin's configuration change, scoped to a workspace, owner, mailbox, opportunity or
channel; a salesperson delaying one firm's automated email is none of those scopes and
is not admin-only. Reusing `openPause` would have required either widening its scope
set or lying about who did it, and `administrative_pauses` is the history of
configuration rather than of day-to-day work.

`scoped_pause` is the reason code because it is the one in the closed set of section 15
that means "something reversible is deliberately blocking this", and it is in
`RECOVERABLE_HOLD_REASON_CODES`, so the hold exposes a control. The alternatives were
worse: `long_hold_review` is what a *seven-day* hold becomes, and inventing a code
would have meant editing `packages/contracts` and the `hold_reason_codes` table for a
distinction nothing else reads.

The requested return instant is recorded in the audit event's detail and not in the
hold. Section 4.3 gives a hold an "optional release time" and no automatic release: when
it clears, "unfinished due times shift by the union of all blocking intervals", and a
hold that expired on a timer would shift the schedule by an interval nobody reviewed. So
the delay is open-ended and a person releases it, which is what `release_pause` is.

The day's Today entry is closed with `status = 'cancelled'`. The send is not happening
today; what brings the work back is the hold being released and the sequences lane
producing the task again, not the clock.

## Who decides

The server, from `today_items.automated`, on one endpoint — `POST /today/snooze` — that
answers with which of the two it did.

The alternative is two endpoints, or one endpoint with a flag the client sets. Both make
the client the thing that decides, and the client is drawing a card that may be seconds
old. A window that believed a send was manual — because the sequences lane changed its
mind, because a rebuild moved the task, because the person left the window open over
lunch — would snooze it, get a snooze, and the send would go out on time with nobody
expecting it. That is the failure this whole section exists to prevent.

So the request says "delay this until then, because of this", and the answer says
`snoozed` or `held`. The Mac renders the label from the task's own `automated` flag so
the button is honest before it is pressed, and the Playwright spec presses both and
asserts the two different answers.

## What is given up

* There is no way to ask for a hold on a manual task, or a snooze on an automated one.
  Neither is a thing 8.2 describes.
* A salesperson cannot say when an automated send should resume. They can say why it
  should stop, and somebody — including themselves — releases the hold. Section 4.3's
  schedule arithmetic is what makes that the safe direction: the shift is computed from
  the interval the hold actually lasted, not from an intention recorded at the start.
