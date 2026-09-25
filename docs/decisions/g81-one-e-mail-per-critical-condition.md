# One e-mail per critical condition, and the alarms that were critical for no reason

**Lane:** g81 · **Date:** 25 September 2026 · **Spec:** 12.6, 13.3, Appendix E step 1 · **Evidence:** audit `GPT6-ASTRA-EXHAUSTIVE-20260925`, items O14, O15 and O16

## O14: the first open critical alarm hid the next one

`<prefix>-critical` was one composite over the OR of every critical alarm. A composite
e-mails only when its own state changes. Once one member was in ALARM, a second member
tripping changed nothing, so nobody was told. The all-clear also waited for the last
member to clear. Lane g62 had written this cost into the module header and accepted it.

**Decision.** Keep David's rule that only composites e-mail. Give each critical condition
a composite of its own:

- **`<prefix>-critical-<condition>`**, one per critical metric alarm plus
  `all_sequences_held` (13 today). The rule is `ALARM("<that alarm>")`. It e-mails on
  ALARM only, so a condition that trips while another is open is still announced.
- **`<prefix>-critical`** keeps the same rule. It now e-mails on OK only: the one
  all-clear, sent when every critical condition has cleared.
- The warning composite does not change. O13 is still David's call, and the triage kept
  it as it is.

The composite rule language has only `ALARM`/`OK`/`INSUFFICIENT_DATA` joined by
`AND`/`OR`/`NOT` (PutCompositeAlarm reference). It has no "at least N" function, so there
is no single-composite design that sends a transition for each new member. One composite
per condition is the smallest design that still follows the rule.

**What it costs.**
- A single incident is still two e-mails: the condition's ALARM and the all-clear.
- Each further condition that trips while the first is open adds one e-mail.
- A condition that flaps on its own sends one ALARM per flap and one all-clear, the same
  as before.
- Thirteen composite alarms at $0.50 a month each, about $6.50 a month.

**Correlated trips.** The worker's metric loop publishes every non-log metric. Four
critical alarms treat missing data as breaching:
- the API heartbeat,
- the scheduler heartbeat,
- the mailbox heartbeat,
- the canary.

All four trip whenever the worker stops publishing, whatever is really happening, and so
does `worker_heartbeat_missed`. Without more, a dead worker would be five e-mails.

Their four composites therefore carry a CloudWatch **actions suppressor**,
`<prefix>-worker-heartbeat-missed`:
- The wait period is 120 s. The two alarms evaluate the same missing minutes, so they
  trip within about a minute of each other.
- The extension period is 300 s.

While the worker alarm is in ALARM those four send nothing. When the extension ends,
CloudWatch performs the action for whatever state each is then in. A condition that is
still true, say the API really is down, is e-mailed five minutes after the worker
recovers. One that cleared with the worker sends nothing, because these composites have
no OK action to send. A dead worker is one e-mail in and one out.

The suppressed set is derived in Terraform, not listed: critical, missing data
breaching, and not the worker alarm itself. The log-derived safety alarms are never in
it: the journal failure, the restore mismatch and the invariant failure are
not-breaching and are raised through the log stream.

**Not done here: repetition.** 13.3's "repeated while critical and unacknowledged"
(`g1-alert-repetition.md`) still does not happen, for two reasons:
1. Nothing calls `raiseCriticalAlert`, so `critical_alerts` stays empty and
   `UnacknowledgedCriticalAlertAgeSeconds` is never published.
2. The age grows while the alert stays open, so its alarm would stay in ALARM, not
   cycle.

Fixing it means an application change: raise and resolve alerts from the alarm states,
and publish an age that restarts each interval. That is outside this lane.

## O15: an environment with no mailbox sat in critical ALARM

Two critical alarms breached with no mailbox at all:
- **`gmail_watch_expiring`** treated missing data as breaching. The gauge is published
  only while a mailbox is connected. The mail lane's and the worker's own comments said
  "not breaching", but the alarm said otherwise.
- **`mailbox_heartbeat_missed`** reads `MailboxCheckHeartbeat`. The job lane built it
  from every mailbox heartbeat row. With no mailbox ever connected there was no row, so
  no datapoint, which counts as breaching. A mailbox its owner disconnected left a row
  that aged into a 0.

Both held `<prefix>-critical` in ALARM, and that hid every other critical condition
(O14).

**Decision.** Fix each one where its meaning is decided.
- **The watch gauge: the alarm.** It becomes not-breaching. The collector already
  publishes 0 for a connected mailbox with no live watch, the state this alarm exists
  for. A worker that stopped publishing is caught by the heartbeat alarms, which still
  breach.
- **The check heartbeat: the publisher.** A missing datapoint must stay a missed check.
  So the mail lane now publishes it on every pass, over **connected** mailboxes only
  (`packages/domain/mail/metrics.ts`):
  - 1 when every connected mailbox's heartbeat is fresh, or none is connected;
  - 0 when any connected mailbox's heartbeat is stale or has never been written.

  The job collector no longer publishes it, and `METRIC_OWNERS` moves it from `jobs` to
  `mail`.

A revoked or failed grant is not a missed check. It is 12.6's `MailboxDisconnectedHours`,
with its 48 hours.

**Owner disconnect and `MailboxDisconnectedHours`.** That metric counted
`status IN ('disconnected', 'revoked')`, so a mailbox its owner disconnected on purpose
still raised the critical alarm after 48 hours if it had sent in the last 30 days.
`disconnectMailbox` writes `disconnected`. A refused grant (`holdForRevokedGrant`) and a
departure write `revoked`. The alarm cannot make this distinction, because the metric
carries no dimension, so the publisher does: `packages/domain/outbound/metrics.ts` now
counts `status = 'revoked'` only. The mail lane's twin in `packages/domain/mail/metrics.ts`
says the same. A departure still counts, because a departed owner's recently sending
mailbox is exactly a mailbox whose replies nobody reads any more.
`packages/domain/test/outbound/mailboxDisconnectedHours.test.ts` holds all three cases.

## The suppression journal alarm could not fire

`SuppressionJournalWriteFailures` is immediately critical and derived from the log event
`suppression_journal_write_failed`. Nothing in `apps/` or `packages/` logged that event.
A journal write that failed became a 503 `journal_unavailable` in the API, or a failed
job in the worker, and the alarm never heard of it.

**Decision.** Both writers log the event, at level `error`, on every refusal except the
`412`, just before they throw:
- `loadS3SuppressionJournal` in `apps/worker/src/bootstrap/deployment.ts`;
- `loadJournalPutObject` in `apps/api/src/bootstrap/deployment.ts`.

The line carries `writer` and `error_name`, and nothing that identifies what was
suppressed. It leaves out the bucket, the key and the event id, because the event id is
a digest of a phone number or an address. The caller may pass a logger. `bootstrap/main.ts`
in the API is outside this lane and passes none, so each loader falls back to its
process's stdout logger, which the awslogs driver ships.

The metric filter used to read the API's log group alone. The worker journals the
opt-outs that mail sync records, so `infra/modules/observability` now filters the worker
group too, into the same metric. Both filters publish 0 on every non-matching line, and
the alarm's `Sum >= 1` counts a failure from either process. The tests drive a fake S3
client that answers 409 and require exactly one line, and none for a success or a `412`.

## O16: the restore-mismatch alarm cleared while the mismatch lasted

At startup the worker logged `restore_generation_mismatch` once. The alarm over
`RestoreGenerationMismatches` looked at one minute and treated missing data as
not-breaching, so it read OK about a minute later while the database was still on the
wrong generation.

**Decision.** The worker's metric loop calls `observeRestoreGeneration` on every pass.
This new function in `apps/worker/src/bootstrap/restoreGeneration.ts` reads the
generation. If it differs from the pin, it logs the same event again, marked
`continuing: true`. The metric then reads one per pass while the mismatch lasts and
nothing once it is reconciled. The alarm fires on one datapoint and clears after three
quiet minutes (1 of 3). The loop is a fixed delay, a little over 60 s per pass, so about
one minute in several hundred has no line. At 1 of 1 that minute would clear the alarm,
and the next pass would send a second ALARM e-mail.

**This departs from the brief.** The brief asked for a 0/1 gauge published with
`PutMetricData`. This lane keeps the log-derived metric and repeats the event instead,
because:
1. The observability module derives all three immediately-critical metrics from logs,
   so that a task that cannot reach the metrics API still raises them.
   `observability.test.ts` holds that for this one.
2. `fss drill` and `fss admin restore-holds open` have no metric loop and must raise the
   same alarm. The full rehearsal's restore drill (`rehearsal-restore-drill.sh`, not this
   lane's) requires that transition to ALARM from the drill's one line.

With a `PutMetricData` gauge, point 2 would need a metric-math alarm over both sources,
with semantics for missing data that cannot be proved offline. The per-pass line gives
the behaviour the item asks for, a signal on every pass while the mismatch lasts and none
after, with neither cost.

## Addition: the coverage watermark's age, as a warning

Since lane g77 the send path holds an owner's automated email once their mailbox's
`coverage_watermark_at` is more than `COVERAGE_FRESHNESS_SECONDS` (900 s) old on
`clock_timestamp()` (`packages/domain/mail/coverage.ts`). Nothing outside the Mac showed
whether sync was advancing. The heartbeat says a check ran, and a rate-limited check runs
and proves nothing.

**Decision.** The mail collector publishes `MailboxCoverageAgeSeconds` on every pass, as
`mailboxCoverageAgeSeconds`. The value is the maximum over connected, `ready` mailboxes,
with each one judged by the gate's own `coverageIsFresh`:
- **A watermark the gate credits** reads its age, floored at 0. A few seconds of skew
  ahead of the database clock reads 0.
- **A watermark the gate refuses for its age** reads that age.
- **A watermark the gate refuses for any other reason** reads 901, one second past the
  window. The other reasons are no watermark on a `ready` mailbox, or a watermark more
  than five minutes in the future. Neither has an honest age, and the gauge must cross
  the threshold exactly when the gate holds.
- **No connected, `ready` mailbox:** no datapoint. Mailboxes in their baseline or
  recovering are held for their state, and `mail.recover` and the check heartbeat cover
  them.

The warning `mailbox_coverage_stale` fires on `Maximum > 900` for 3 of 3 one-minute
periods, treating missing data as not breaching. It is a member of the warning roll-up
only, because the gate is already holding and nothing unsafe follows. The threshold is
`var.mailbox_coverage_stale_seconds`, default 900. `test/release/alarmIncidents.check.ts`
keeps it equal to the constant. `packages/domain/test/mail/mailboxCoverageMetric.test.ts`
judges each boundary case by the gauge and by the gate on the same row, and requires the
two to agree.
