# One-business-day reply reminder

Source behavior for #448 extends the existing Today action and durable desktop notification ledger. It creates no outbound email, routine reply, recipient or new notification scheduler. Backend release and signed desktop/native acceptance remain separate evidence gates.

The deadline uses the workspace's current business timezone and holiday calendar. Monday through Friday are permitted except configured holiday dates; an unconfigured calendar observes no holidays. The deadline is the next permitted local calendar date strictly after the received date, at the same local hour, minute, second and millisecond. It uses the calendar rather than an elapsed timer or a send window.

For a workspace in America/New_York:

| Received | Deadline |
| --- | --- |
| Friday at 10 a.m. | Monday at 10 a.m. |
| Saturday or Sunday at 10 a.m. | Monday at 10 a.m. |
| A configured Monday holiday at 10 a.m. | Tuesday at 10 a.m. |
| Friday at 10 a.m. before a configured Monday holiday | Tuesday at 10 a.m. |
| March 6, 2026 at 10 a.m. EST (15:00Z) | March 9 at 10 a.m. EDT (14:00Z) |
| October 30, 2026 at 10 a.m. EDT (14:00Z) | November 2 at 10 a.m. EST (15:00Z) |

The existing local-clock resolver chooses the earlier instant for a repeated local time and resolves a skipped wall time forward across the gap. Received timestamps are valid instants; current Monday–Friday deadlines normally avoid the Sunday DST transition. A source received at 10:00:00.875 remains open until exactly 10:00:00.875 on its deadline. Current reads recompute the projected deadline from current workspace configuration; the durable event identity stays bound to the source reply. The calculation is specific to reply obligations and does not change sequence business-day scheduling.

An unresolved reply remains current Today work. Only a supported substantive reply receives the `reply_overdue` notification phase; uncertain classification remains reply-review work. The existing source message identity yields one overdue event per unanswered obligation, independent of polling, desktop restarts and devices. An attention alert and the later overdue reminder are separate phases. Claiming, showing or acknowledging the reminder never answers the conversation. Today remains visibly overdue until current conversation authority says it is resolved or replaced.

Verified manual Gmail answers in the same conversation, resolved dispositions and a supported newer incoming reply suppress the old event. A stale click revalidates and opens no old target. Unsupported sent metadata, other conversations and unresolved matching ambiguity do not invent an answer. Suppression keeps the existing body-free receipt history and does not turn an attempt into a delivery observation.

Offline has no invented native receipt. Attempting, native-show observation, acknowledgement, failed and unknown remain distinct. An unknown overdue attempt survives restart and does not blindly reshow; persistent Today work still provides the unresolved obligation. Native macOS delivery, permission, cold-start and sleep behavior require the signed desktop acceptance gate in #466.

Focused verification uses public `readTodayActions` and notification read/claim/observe/ack operations with real PostgreSQL, controlled time and the existing controlled Gmail port. Fixture SQL varies arrival clocks and devices; assertions read public outcomes. Calendar tests cover weekend/holiday arrivals, skipped holiday Mondays, workspace zone changes, spring/autumn DST and the exact deadline. Durable tests cover concurrent devices, restart, unknown receipt truth, acknowledgement without completion and suppression after manual Gmail/resolved/newer state. Existing public desktop tests cover overdue visibility and offline/unknown labels. These controlled source checks are not a production rollout, received email proof or native acceptance.
