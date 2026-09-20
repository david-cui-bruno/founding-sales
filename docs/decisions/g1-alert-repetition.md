# G1: how "repeated while critical and unacknowledged" is delivered

**Date:** 19 September 2026 · **Lane:** G1 infrastructure · **Spec:** 13.3 — *"Alerts are sent by an independent AWS email path to configured admin recipients and repeated while critical and unacknowledged."*

## The problem

CloudWatch notifies on **state transitions**. An alarm that goes to `ALARM` publishes once and then stays silent for as long as it remains in `ALARM`. There is no native "re-notify every N minutes". So the specification's "repeated while critical and unacknowledged" cannot be expressed as an alarm property.

Nor can it be expressed as an EventBridge schedule that publishes unconditionally: that would send mail on a timer regardless of whether anything is wrong, which trains the recipient to ignore it.

## Decision

Repetition is driven by the application, and the infrastructure provides the alarm that carries it.

`infra/modules/alerts` creates `<prefix>-unacknowledged-critical-alert` over a metric the applications emit, `UnacknowledgedCriticalAlertAgeSeconds`. The contract is:

- when a critical condition is raised and no admin has acknowledged it, the worker publishes the age in seconds of the **oldest unacknowledged critical alert**, once per metric period;
- when there is nothing unacknowledged, it publishes nothing, and the alarm treats missing data as not breaching;
- the alarm breaches above `unacknowledged_critical_seconds`, default 3600 (a variable, because spec 13.3 says thresholds are configuration versioned with the release).

Because the metric is re-emitted while the condition persists and the acknowledgement clears it, the alarm cycles `ALARM` → `OK` → `ALARM` and each cycle publishes. That is the repetition, and unlike a timer it stops the moment someone acknowledges.

Acknowledgement itself is an FSS admin command, not an AWS one, because "who acknowledged which alert" is business state that belongs in the audit trail with the rest.

## What this hands to the application lanes

The worker must emit:

| Metric | Meaning |
|---|---|
| `UnacknowledgedCriticalAlertAgeSeconds` | age in seconds of the oldest unacknowledged critical alert, or no datapoint when there are none |

and the API must expose an admin acknowledge command that clears it. If neither lands, the alarm simply never fires and nothing else breaks — but the specification's repetition requirement is then unmet, so this belongs in the release checklist, not in a backlog.

## The rest of the alert contract, for the same reason

The same module wires alarms to metrics that do not exist yet. The full list the applications must emit is in `infra/modules/alerts/main.tf` as `local.alarms`, and the log-derived ones are in `infra/modules/observability/main.tf` as `local.metric_filters`. Both are exported as module outputs so a test can read them. Nothing in the infrastructure invents a metric name that is not written down in one of those two places.
