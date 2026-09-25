# The enrollment gauges: held means blocked by a hold nobody chose

**Lane:** g72 · **Date:** 25 September 2026 · **Spec:** 4.2, 4.3, 11.2, 13.3, 15, 16.2 · **Evidence:** review `GPT6-SOL-FULL-20260925`, section 1 row 5 and action 8

## The gap

`all_sequences_held` in `infra/modules/alerts/main.tf` is 13.3's "all active sequences
unexpectedly held". It is metric math:

```
held_fraction = IF(active > 0, held / active, 0)      >= 1
active = ActiveEnrollments, Maximum, 300 s
held   = HeldEnrollments,   Maximum, 300 s
3 of 3 periods, treat_missing_data = notBreaching
```

`METRIC_OWNERS` listed both inputs as `later_lane`, and nothing published either. Once
real enrollments existed, the critical alarm would have had no inputs at all. The worker's
coverage test missed it because it read only `local.alarms`, and this alarm is its own
resource.

## The decision

`collectSequenceMetrics` (`packages/domain/sequences/metrics.ts`) publishes both on every
metric pass. They have no dimensions, are summed across workspaces, have unit `Count`,
and are read in one statement.

**`ActiveEnrollments`** counts every live enrollment: `ended_at IS NULL`, which the
schema ties to `active` and `review_required`. Completed and stopped enrollments are not
counted. The numerator is a subset of the same population, so the fraction is at most 1.

**`HeldEnrollments`** counts live enrollments whose next work is blocked now by a
**counted** reason. An enrollment is held if any of these is true:

1. It is `review_required`: 4.3's long-hold review, which only a person resumes.
2. One of its step executions is `held` with a counted reason. This covers reasons that
   have no hold row: a missing route, an unapproved template, an owner with no
   connected mailbox, a fence the gate refused.
3. An open `active_holds` row with a counted reason applies to it. The hold is scoped
   to the workspace, its firm, its opportunity, its owner or the enrollment itself.
   Those are the scopes `holdSource` and `holdsAffectingEnrollment` apply. The hold
   must block the channel action kind of the unfinished step, or `enrollment_advance`,
   which blocks every channel.

Rule 3 is necessary. A step is only held when it comes due and the worker tries it, and
a cadence spends most of its time waiting for a step days away. Counting held steps
alone would call a workspace under a restore hold "mostly running" until each step's day
came.

**Counted** means every section 15 reason except `EXPECTED_HOLD_REASONS`:

| Not counted | Why |
|---|---|
| `scoped_pause` | Every stop somebody chose. An admin pause at any scope (`openPause`) and a salesperson's Today delay (`today/snooze.ts`) open it. The send hand-off also holds a step with it when sending is switched off: the deployment flag, the workspace attestation, the domain's automated-sending switch or a missing sending domain all map to it (`refusalFor` in `outboundSendHandoff.ts`), and no hold row is opened. |
| `daily_cap`, `domain_cap`, `outside_email_window`, `send_unknown_reconciling` | `CLOCK_CLEARING_HOLDS`. These are Appendix D's pacing and a fence waiting on Gmail's Sent index, and the scheduler asks again on its own. The list is derived from that constant, not copied. |

Every other reason counts, including any reason added later. Mailbox health, restore,
provider refusal, dead job, send unknown terminal, long-hold review, uncertain reply,
ambiguous match, manual-suppression review, route and template problems, reassignment
and posture problems all count. A counted hold under a pause still counts, because a
pause does not make a restore expected. An admin's enrollment-migration pause
(`migration_paused_at`) is also deliberate and is not counted.

### Why sending-disabled is not "held"

Production runs with sending off until the rehearsal gate passes and an admin enables it
(4.2, 16.2). With sending off, every due email step is held `scoped_pause` by the real
gate (`workspace_sending_not_attested`). If that counted, the first morning after David
enrolled contacts whose first step is email, the critical composite would page about a
switch that is off on purpose. 13.3 says "unexpectedly", so it does not count.
`apps/worker/test/enrollmentMetrics.test.ts` drives that exact path: the real scheduler
pass, the real `sequence.action` handler, a real fence and the real gate with
`deploymentSendingEnabled: false`. It gets 2 active and 0 held, then 2 and 2 once
`openRestoreHolds` runs.

### Behaviour at 0/0

Both gauges are published as 0 when nothing is enrolled. `IF(active > 0, held / active, 0)`
is then 0, below the threshold of 1, so the alarm moves from INSUFFICIENT_DATA to OK once
the worker runs this build, and it cannot fire on an empty system. **No Terraform change
is needed.**

Two properties of the Terraform are worth knowing; neither is a change request:

- Each input is `Maximum` per period, so a period breaches when at least one minute in
  it had every enrollment held at that period's peak count. It does not require all
  five minutes. Since held ≤ active every minute, the fraction never exceeds 1.
- With a handful of enrollments the fraction is coarse. With one enrollment, one
  uncertain reply reads 1/1. That really is every active sequence held, by something
  only a person clears, and the runbook's first check names the reason.

## Ownership made true

`later_lane` is gone from `MetricOwner` and from the coverage map's `MetricRaiser`.
`GmailWatchHoursToExpiry` is `mail` and `MailboxDisconnectedHours` is `outbound`. Both
were already published by those collectors under a stale `later_lane` label.
`apps/worker/test/metricCoverage.test.ts` now:

- reads the standalone metric alarms as well as `local.alarms`;
- requires every name owned by a collector to be declared by that collector and
  published by the real worker;
- requires every `log_derived` name to be derived by a metric filter in
  `infra/modules/observability/main.tf` and never published by the worker.

## Mutations

Two are appended to `scripts/releaseMutationCheck.mjs`, making 115. In the first, the
held gauge ignores open holds and counts only steps already held (12 cases go red). In
the second, the active gauge excludes only `stopped`, so completed enrollments stay
active (the "enrollments that are over" case goes red).
