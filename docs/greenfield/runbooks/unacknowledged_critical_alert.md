# unacknowledged_critical_alert

**Metric:** `UnacknowledgedCriticalAlertAgeSeconds` · **Severity:** warning · **Spec:** 13.3

## Symptoms

A critical condition has been open and unacknowledged past its repeat interval. The
repeat warning appears in alarm state and the daily digest, not repeated alert mail.

## First checks

1. `GET /admin/alerts` as an admin: every open alert with its key, severity, raise
   time, last observation and acknowledgement state. `GET /diagnostics` shows the same
   list beside the runbook path for each.
2. Which condition is actually open — this alarm is about the *absence of an
   acknowledgement*, never about a new fault.
3. Whether anyone is already working it.

## Diagnosis

While a critical condition is open and unacknowledged the worker publishes its age.
When none is open the worker publishes nothing and the alarm's `notBreaching`
treatment of missing data says so. Historical repeated-mail/composite behavior was
superseded by the September25 daily-digest decision. No alarm mails when it trips;
the daily digest arrives at 07:00 America/New_York. See the [runbook index](README.md)
for current digest and alarm-reading semantics. Read current state rather than waiting:
`aws cloudwatch describe-alarms --alarm-names fss-prod-unacknowledged-critical-alert`.

So this firing means one of:

- nobody has seen the real alert;
- somebody is working it and has not acknowledged;
- the underlying condition was fixed but not resolved, and the row is still open.

## Safe recovery

- Open the runbook for the underlying alert key and work that.
- `POST /admin/alerts/acknowledge` stops the repetition immediately. It is admin-only
  and audited in the same transaction, because "who silenced it" is the first question
  afterwards.
- If the condition is genuinely over, resolve it. Resolving is not acknowledging: a
  resolved alert is simply over, and the age stops being published either way.

## Escalation

Escalate the underlying alert, never this one. Do not wait for per-alarm mail. If the
daily digest is missing, check its delivery and confirmed SNS subscriptions under the
index's digest procedure; that is separate from ownership of the underlying incident.

## What must stay held

- Acknowledging stops this repeat warning, not an alarm-mail stream. No hold is released by an
  acknowledgement and none should be.
- Do not acknowledge an alert you are not working. The acknowledgement is a claim of
  ownership and is recorded as one.
