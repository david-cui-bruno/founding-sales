# G15: the worker drains what the lanes left

**Date:** 21 September 2026 · **Lane:** G15 worker wiring · **Spec:** 7.3, 8.1, 10.2,
11.2, 12.7, 13.1, 13.2, invariant 3

## What was wrong

The 21 September deviations sweep found three domain functions that a lane had built,
tested, exported and documented, and that no later lane had ever called:

| Built by | Function | What its absence meant |
|---|---|---|
| G3a + G8 | `consumeTerminalStops` | Closing an opportunity Won stopped no enrollment |
| G4 + G8 | the `suppression_finalizations` marker reader | A finalized suppression stopped no enrollment |
| G7-2 | `closeSendDay`, `listDaysToClose`, `recordDaySignal`, `countDirectSend` | `healthy_sending_days` was zero for every mailbox that had ever existed, so the cap was five a day for ever, and the three counters `rampHealthFailure` judges a day on were always zero |

Every one of them was green in its own package's suite. Each lane had written down that
the caller belonged to somebody else — G3a's decision record says "until G8 subscribes,
closing an opportunity stops no enrollment"; G4's says "the sequences lane subscribes to
this marker rather than to a hook this lane would have had to invent" — and no lane ever
had "be the caller" in its brief.

**None of this was a sending leak.** The send gate
(`packages/domain/outbound/gate.ts`) reads `effective_suppressions` before every single
dispatch and refuses a suppressed recipient whatever any enrollment believes, and it
re-reads control mode and holds too. What was wrong was enrollment *state* — a
sequence that stayed active after the firm said no, held its next step rather than
ending, and appeared on the board as live work — and the ramp, which never advanced.

## What this lane added

Two job kinds, both `business_uniqueness`, both registered unconditionally because
neither needs any configuration and neither reaches outside PostgreSQL.

`sequence.terminal_stop`, key `terminal-stop:{outbox head}:{marker head}`, drains both
streams for one workspace in one transaction. `outbound.close_send_day`, key
`send-day-close:{mailbox}:{business date}`, closes one open day.

`recordDaySignal` is now called from `outbound/send.ts` (provider error),
`mail/effects.ts` (bounce, opt-out) and `classification/confirmations.ts` (a confirmed
`opt_out`). `countDirectSend` is called from `mail/pipeline.ts` for every imported
outgoing message that has no fence.

## The decisions the spec left open

### One job per workspace, not one per firm

The brief asked for one firm per job. `sequence_event_cursors.subscriber` is a text
column whose CHECK is `^[a-z][a-z0-9_.]{2,63}$`, which a uuid's hyphens do not satisfy,
so a per-firm cursor has nowhere to live and this lane may not add a migration.
Draining per workspace under the one cursor G8 built is what the table supports. The
cost is that a failure rolls back every firm's stops in that pass rather than one
firm's; the benefit is that the cursor cannot disagree with the stops, which is the
property that makes the whole thing exactly-once in practice.

### The source reads one workspace at a time, because the index does

`terminalStopSource` walks `SELECT id FROM workspaces` and asks
`readTerminalStopWork(session, workspaceId)` for each, the way `retentionSource` walks
the same list. The first draft asked one statement for every workspace at once, which
is shorter and wrong: the index on the outbox is `crm_domain_events_by_kind
(workspace_id, event_kind, occurred_at)`, leading column `workspace_id`, so a
workspace-blind statement cannot use it and would sequentially scan the outbox every
minute for ever. 13.1 says the pass "finds due work through indexed queries".
`suppression_finalizations` is the same shape — primary key `(workspace_id, event_id)`.

### The marker reader has no cursor, and that is better

`suppression_finalizations.event_id` is a sha256 hex string; `last_event_id` is a uuid.
Rather than invent a second cursor table, the reader defines its work as *the set of
live enrollments a still-effective finalized suppression covers*. Stopping an
enrollment removes it from that set, so the drain is idempotent with no column to
advance, a marker whose stops have happened costs one indexed read, and an enrollment
created after a suppression is stopped rather than missed. It reads
`effective_suppressions` rather than `suppression_events` because 10.2 makes that view
authoritative and an event an admin superseded before the sweep ran is not a reason to
stop anything.

The handle arm is deliberately a copy of `suppressionSource()`'s query in
`sequences/eligibility.ts`: the enrollments a handle suppression *stops* must be the
enrollments the eligibility read *refuses*, or a step would hold for a reason no stop
ever acted on.

### `opportunity.manual_mode` is drained too, with end reason `human_reply`

7.3: "manual is entered by a confirmed human email reply, user-recorded LinkedIn reply,
engaged call outcome, or direct Gmail send. Current active enrollments end terminally."
Nothing acted on that either. A confirmed reply set the control mode, released its
holds, promoted the reply card — and left the sequence active, which invariant 3 says it
must not be.

The end reason is `human_reply` for all of them. `ENROLLMENT_END_REASONS` also holds
`engaged_call` and `direct_send`, and the signal cannot distinguish them: every
manual-mode event carries `reason_code = 'opportunity_manual'` and a free-text
`detail.reason`, and parsing English out of a detail column to pick a stored code would
be worse than recording the fact the consumer can prove. **This is a deviation worth a
follow-up:** the honest fix is for the lanes that cause the other two — `dial/calls.ts`
and `mail/effects.ts`'s direct-send path — to stop their own enrollments in their own
transaction, which is what Appendix A's "commits together" column asks for anyway. Their
files were outside this lane's scope. Until then a stopped enrollment's history says
`human_reply` where it should sometimes say `engaged_call` or `direct_send`; the *stop*
is right and only the recorded reason is coarse.

### The fence lookup in the mail pipeline, which turned out to be load-bearing

`mail/pipeline.ts` has said since G7-1 that "until G7-2's fence exists, every outgoing
message that matches is a direct send ... the fence lookup goes here and changes nothing
else". Two of those clauses are no longer true. The fence exists, and the lookup changes
two things:

* `countDirectSend` on an FSS-sent message would double-count it, since
  `countAutomatedSend` already counted it before it left;
* `applyDirectSendEffects` on an FSS-sent message sets the opportunity manual — and now
  that the manual-mode signal is drained, that would terminally stop the enrollment
  which had just sent step one. FSS would have cancelled its own sequence on the first
  sync after its own first send.

`fenceForOutgoingMessage` joins on the deterministic `Message-ID` FSS wrote before
sending and on the provider id Gmail returned, either of which may be the only one
present. Adding it was not optional once the manual-mode drain existed.

### When a send day closes

When the workspace's own business date has moved past it. `mailbox_send_days.
business_date` is in the *workspace's* zone — migration 0010 says so beside the column
and distinguishes it from the send window, which is the firm's — so the day is over when
that zone's midnight has passed, which is after 17:00 and therefore after every window
the day could have had. The date is `(now() AT TIME ZONE business_time_zone)::date`,
computed by PostgreSQL, never by `Intl` on a worker host. `listDaysToClose` gained an
optional `workspaceId` so the cut-off can be each workspace's own; one global date would
close a workspace in a later zone a day early.

### What `providerWarning` is, and is not

`rampHealthFailure` takes both a `providerWarning` boolean and a `providerErrors` count.
`readSendDayHealth` always reports the boolean as `false`, because FSS subscribes to no
Postmaster Tools feed and the only provider complaint it can observe is an error during
dispatch — which is counted. Reporting a second, unsourced boolean would be inventing a
signal. **A known limit of version one:** a Google reputation warning that never becomes
a send error is invisible to the ramp. 12.7 puts Postmaster Tools in "the admin
checklist", which is where it stays.

### A bounce counts on the day it arrived

`recordDaySignal` is a bare `UPDATE` and does nothing when the mailbox has no row for
that date. That is the right behaviour rather than a gap: a day with no automated sends
is not a sending day (`rampHealthFailure` returns `no_sends`), so there is nothing for a
bounce to be a proportion of. The cost is that a bounce for yesterday's send, arriving
after yesterday's day has been closed, is not counted against it. Attributing it to the
originating fence's day instead would need the bounce report parsed back to a fence,
which is detection this lane was told not to invent. Named here so it is a decision and
not a surprise.

## David's numbers, unchanged

`RAMP_MAX_BOUNCE_RATE = 0.05`, `RAMP_MAX_OPT_OUT_RATE = 0.1`, `RAMP_RATE_FLOOR = 20`
and `RAMP_SMALL_DAY_TOLERANCE = 1` are values **the specification does not give**. David
confirmed them on 21 September 2026 and this lane changed none of them. They are his
values, not a lane's invention. `RAMP_SCHEDULE`, `RAMP_SETTLED_CAP`,
`RAMP_ADMIN_RAISE_LIMIT` and `RAMP_HARD_CEILING` are 12.7's own table and are untouched.

## The thirty-day mailbox rule

David's decision of 21 September 2026: a mailbox that has sent automated mail in the
last thirty days is not disconnected and its Google authorization is not revoked, so
that a late reply-based stop is still received and honoured. It is written in
`docs/greenfield/mail.md` ("Mailbox lifecycle: the thirty-day rule") and named in
`docs/greenfield/release.md` section 6. It is an operating rule for version one and not
a guard: nothing refuses a disconnect on those grounds, and the built guard — a refusal
with an audited admin override — is a later lane's. It is stated as the workspace's own
rule and cites nothing external.

## What catches the next one

`apps/worker/test/sourceRegistry.test.ts` compares `workerDueWorkSources()` with the
table in `docs/greenfield/processes.md` in both directions. A source with no row fails;
a row with no source fails. That comparison is the thing that was missing — every
unwired function above was green in its own suite, and nothing anywhere read the two
lists together.

`apps/worker/test/workerWiring.test.ts` is the behavioural half, and deliberately runs
the *real* pass rather than calling the domain functions: three workspaces holding the
same enrollment uuid, a Won close and a finalized suppression each followed by one
`runSchedulerPass(workerDueWorkSources())` and one runner pass, and the two stolen-lease
probes `docs/greenfield/jobs.md` makes mandatory. A test that called
`consumeTerminalStops` directly would have passed on main.

## No migration

None was needed and none was written. Two job kinds are entries in a TypeScript array;
`jobs_kind_shape` already admits both names; every table these handlers touch existed,
with the grants they need.
