# unacknowledged_critical_alert

**Metric:** `UnacknowledgedCriticalAlertAgeSeconds` · **Severity:** warning · **Spec:** 13.3

## Symptoms

A critical condition has been open and unacknowledged past its repeat interval. The
critical alert mail is repeating.

## First checks

1. `GET /admin/alerts` as an admin: every open alert with its key, severity, raise
   time, last observation and acknowledgement state. `GET /diagnostics` shows the same
   list beside the runbook path for each.
2. Which condition is actually open — this alarm is about the *absence of an
   acknowledgement*, never about a new fault.
3. Whether anyone is already working it.

## Diagnosis

CloudWatch notifies on state transitions, so an alarm that stays in `ALARM` is silent.
`docs/archive/decisions/g1-alert-repetition.md` is the reason this metric exists: while a
critical condition is open and unacknowledged the worker publishes its age, the alarm
cycles, and each cycle mails. When none is open the worker publishes nothing and the
alarm's `notBreaching` treatment of missing data says so.

Since lane g62 the mail is `<prefix>-warning`'s, not this alarm's: this alarm is a
member of the warning composite and sends nothing itself. So while
`oldest_runnable_job_warning` or `dead_job_unresolved` already holds the warning
composite in `ALARM`, this alarm's transitions reach nobody's inbox. Read its state
rather than waiting for mail:
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

Escalate the underlying alert, never this one. If nobody acknowledged a critical alert
for an hour, also check that the SNS email subscriptions are confirmed — an unconfirmed
subscription is created successfully by Terraform and delivers nothing.

## What must stay held

- Acknowledging silences the mail and changes nothing else. No hold is released by an
  acknowledgement and none should be.
- Do not acknowledge an alert you are not working. The acknowledgement is a claim of
  ownership and is recorded as one.
