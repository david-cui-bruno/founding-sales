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

- Alerts arrive by SNS email, which does not depend on any salesperson Gmail grant.
- **The e-mail comes from a composite alarm, never from the alarm a page is named
  after** (lanes g62 and g81). Each critical condition has its own composite,
  `<prefix>-critical-<condition>`, which e-mails when that condition trips — even while
  another critical condition is already open — and the page to open is the condition in
  its name. `<prefix>-critical`, over every critical alarm and `all_sequences_held`,
  sends one e-mail: the all-clear, when every critical condition has cleared.
  `<prefix>-warning`, over the warnings, sends one e-mail when it goes to `ALARM` and
  one when it returns to `OK`. The alarms these pages are named after keep their state
  and send nothing.
- **A dead worker is one e-mail.** The API, scheduler and mailbox heartbeats and the
  canary are published by the worker and trip whenever it stops publishing. Their
  composites stay quiet while `worker_heartbeat_missed` is in `ALARM`, and e-mail five
  minutes after it clears only if they are still true.
- **The warning roll-up still stays quiet when a second warning trips**, and sends its
  `OK` only when every warning has cleared. List what is in `ALARM` now before deciding
  which page to work:
  `aws cloudwatch describe-alarms --state-value ALARM --alarm-name-prefix fss-prod
  --query 'MetricAlarms[].AlarmName'`.
- Every alarm reads its own environment's CloudWatch namespace, `FSS/<prefix>`:
  `FSS/fss-prod` in production, `FSS/fss-rh-<run>` in a rehearsal. To read a metric
  by hand, name it: `aws cloudwatch get-metric-statistics --namespace FSS/fss-prod
  --metric-name <metric> ...`. Nothing publishes to the bare `FSS` any more, so a
  query there reads only data from before lane g55, and a rehearsal can no longer
  trip or mask a production alarm.
- A critical condition repeats while unacknowledged. `POST /admin/alerts/acknowledge`
  stops the repetition; it does not fix anything and it is audited. The repeat is
  `unacknowledged_critical_alert`, so since lane g62 it reaches the inbox through
  `<prefix>-warning`, and not at all while another warning holds that composite in
  `ALARM`.
- `GET /diagnostics` is the one read that shows schema version, client-version range,
  job health, heartbeats, mailbox health, restore generation and open alerts together.
- Nothing here authorises editing `infra/`. Threshold changes are a release.
