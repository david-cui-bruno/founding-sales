# Recipient-local morning prospecting

Approved October 7, 2026: cold email, including cold-sequence follow-ups, may dispatch
on weekdays from 09:00 inclusive to 11:00 exclusive in the firm's IANA timezone.
The default planned time is 10:00. A new email-first cohort created after the window
starts the next weekday morning; future emails default to 10:00 even if the initial
touch was created later in the morning. Calls keep their existing daytime timing.
Conversation follow-ups retain the existing 08:00–17:00 window.

The scheduler applies this rule to new work and already prepared/held cold emails.
Missed windows move forward to the next valid morning. The final dispatch transaction
rechecks the same rule, including the union of frozen and current holiday calendars,
so token refresh or queue latency across 11:00 cannot release an afternoon email.
The operational send-path preview uses the same origin-specific rule.

Existing cadence JSON is historical: its afternoon timestamps are interpreted through
the current morning window, without rewriting the original plan or its expiry. Both
next-touch selection and successor calculation use the adjusted times. Actual-touch
day spacing, one cold touch per firm per local day, lifetime limits and fixed expiry
remain enforced. A rescheduled execution records an append-only `send_window` shift.
Prepared fences are reused; sent or uncertain provider attempts are settled before
any scheduling change and are never reset or replaced.

The five-email offsets, approved copy, mailbox caps, recipient approvals and automatic
admission controls are unchanged. This is an application-only change; schema stays 61
and no desktop update is required to enforce server dispatch timing.

Validation covers timezone/DST and holiday placement, the exact window boundaries,
unchanged conversation afternoon placement, new and old cadence timing, late-touch
spacing, token-refresh crossing 11:00, and held/crash-recovered prepared fences that
reuse their original message on the next morning.
