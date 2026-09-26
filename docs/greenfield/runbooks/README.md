# Runbooks

One page per alarm in `infra/modules/alerts/main.tf`, named after the alarm key
(`<prefix>-<alarm-key-with-dashes>` in CloudWatch; the file uses underscores, as the
Terraform key does).

Every page has the same six headings, and
`packages/domain/test/dashboard/runbooks.test.ts` fails the gate when a page is
missing one, when an alarm has no page, or when a page names an alarm that no longer
exists. The table the application reads to put a runbook beside an open alert is
`ALARM_RUNBOOKS` in `packages/domain/dashboard/runbooks.ts`, and the same test keeps
it equal to the Terraform.

**The heading to read first is `## What must stay held`.** Under an alarm the
instinct is to clear the blockage. For most of these the blockage is the safety
property, and clearing it is how a duplicate email or a prohibited call happens.

General facts that apply to every page:

- **No alarm e-mails when it trips** (lane g99; the owner's decision 11C of
  25 September 2026). One e-mail arrives a day, the **daily alarm digest**, at
  **07:00 America/New_York** (EventBridge Scheduler evaluates the time in that zone, so
  it does not move at the daylight-saving changes). Its subject is
  `Callie daily alarm digest — <date>`. It lists every alarm whose name starts with
  `<prefix>-` that is not `OK` now, `ALARM` first and then `INSUFFICIENT_DATA`, each
  with the time it entered that state; then every state change of the last 24 hours,
  oldest first, as alarm name, from → to, and the time in New York. A day on which
  nothing was wrong and nothing changed is one line: `All N alarms OK.` The page to open
  is the one named after the alarm; a composite in the list,
  `<prefix>-critical-<condition>`, names its condition.
- The digest is SNS email on the alert topic, which does not depend on any salesperson
  Gmail grant, and reaches the addresses in `alert_emails`. It is published by the
  Lambda function `<prefix>-alarm-digest`, which logs to `/fss/<prefix>/alarm-digest`
  (14 days). To have it now rather than at 07:00:
  `aws lambda invoke --function-name fss-prod-alarm-digest /dev/null`.
- **To read an alarm immediately**, do not wait for the digest. What is in `ALARM` this
  minute, metric alarms and composites both:
  `aws cloudwatch describe-alarms --state-value ALARM --alarm-name-prefix fss-prod-
  --alarm-types MetricAlarm CompositeAlarm --query '[MetricAlarms, CompositeAlarms][].AlarmName'`,
  or without the flags, `aws cloudwatch describe-alarms --state-value ALARM`, which
  reads the metric alarms of every environment in the account. One alarm's day:
  `aws cloudwatch describe-alarm-history --alarm-name <name> --history-item-type StateUpdate`.
- The alarms keep their names and their state; only the e-mails went. `<prefix>-critical`
  is in `ALARM` while any critical condition is, `<prefix>-warning` while any warning
  is, and each critical condition has a composite of its own that changes state when it
  trips even while another is open (lane g81), so the digest shows a second incident as
  a transition of its own.
- Every alarm reads its own environment's CloudWatch namespace, `FSS/<prefix>`:
  `FSS/fss-prod` in production, `FSS/fss-rh-<run>` in a rehearsal. To read a metric
  by hand, name it: `aws cloudwatch get-metric-statistics --namespace FSS/fss-prod
  --metric-name <metric> ...`. Nothing publishes to the bare `FSS` any more, so a
  query there reads only data from before lane g55, and a rehearsal can no longer
  trip or mask a production alarm.
- A critical condition repeats while unacknowledged. `POST /admin/alerts/acknowledge`
  stops the repetition; it does not fix anything and it is audited. The repeat is
  `unacknowledged_critical_alert`, a warning, so since lane g99 it is a line in the next
  morning's digest like every other alarm.
- `GET /diagnostics` is the one read that shows schema version, client-version range,
  job health, heartbeats, mailbox health and open alerts together.
- Nothing here authorises editing `infra/`. Threshold changes are a release.
