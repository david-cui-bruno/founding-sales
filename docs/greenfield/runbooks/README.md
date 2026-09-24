# Runbooks

One page per alarm in `infra/modules/alerts/main.tf`, named after the alarm key that
appears in the CloudWatch notification (`<prefix>-<alarm-key-with-dashes>`; the file
uses underscores, as the Terraform key does).

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
- Every alarm reads its own environment's CloudWatch namespace, `FSS/<prefix>`:
  `FSS/fss-prod` in production, `FSS/fss-rh-<run>` in a rehearsal. To read a metric
  by hand, name it: `aws cloudwatch get-metric-statistics --namespace FSS/fss-prod
  --metric-name <metric> ...`. Nothing publishes to the bare `FSS` any more, so a
  query there reads only data from before lane g55, and a rehearsal can no longer
  trip or mask a production alarm.
- A critical condition repeats while unacknowledged. `POST /admin/alerts/acknowledge`
  stops the repetition; it does not fix anything and it is audited.
- `GET /diagnostics` is the one read that shows schema version, client-version range,
  job health, heartbeats, mailbox health, restore generation and open alerts together.
- Nothing here authorises editing `infra/`. Threshold changes are a release.
