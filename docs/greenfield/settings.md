# Administration: settings, pauses, the dashboard, Diagnostics and the runbooks

Specification revision 3, sections 10.1, 13.3, 13.4, 16.2 and 8.1, and Appendices D,
E, F and G 7, 8, 25 and 42. Dialling policy, postures, calling windows and
suppression have their own page: `docs/greenfield/policy.md`.

## The short version

There is one administration window with three screens. **Settings** is the workspace's
configuration, versioned with a change history. **Dashboard** is 13.4's minimum
performance dashboard, computed over the firms the caller may see. **Diagnostics** is
the one page that answers "which part of this deployment is unhealthy" and puts a
runbook path beside every open alert.

Every settings command is a command with a receipt: the receipt, the payload hash,
the device and the mutation commit in one transaction, and a replay returns the
original version rather than writing a second one.

## Where everything is

```
packages/domain/db/migrations/0013_dashboard.sql   workspace_settings, and two indexes
packages/contracts/src/settings.ts                 the keys, their value schemas,
                                                    the commands, and what the Mac parses
packages/domain/settings/store.ts                  read, history, and the versioned write
packages/domain/settings/effective.ts              what a stored setting *means*
packages/domain/settings/elsewhere.ts              the configuration this store does not own
packages/domain/dashboard/aggregate.ts             13.4, as one read
packages/domain/dashboard/sources.ts               the figures other lanes' tables hold
packages/domain/dashboard/diagnostics.ts           13.3 and Appendix E, as one read
packages/domain/dashboard/runbooks.ts              alarm key -> runbook path
packages/domain/crm/stageAdmin.ts                  8.1's four verbs
packages/domain/crm/board.ts                       the pipeline board read
apps/api/src/routes/{settings,dashboard,diagnostics,pipeline}.ts
apps/desktop/src/main/settingsBridge.ts            the window's half of the bridge
apps/desktop/src/renderer/settingsView.ts          the window, as a value
docs/greenfield/runbooks/*.md                      one page per alarm
```

## What this lane stores, and what it deliberately does not

`workspace_settings` holds five slices: the alarm thresholds, the workspace business
zone, the supported client-version range, the postal footer and the production
sending attestation.

**The rule that decides what is in it:** a `jsonb` settings slice is for an operator
knob that nothing joins to, nothing constrains, and nothing freezes a version of.
Two slices were drafted here and removed before publication for failing that test —
the holiday calendar, whose *version* every stored due instant freezes (G8's
`workspace_holiday_calendars`, migration 0012), and the sending limits, whose
ceilings are row-level CHECKs rather than schema maxima (G7-2's `mailbox_send_ramp`
and `sending_domains`, migration 0010).
`docs/decisions/g9-two-slices-that-belong-to-other-lanes.md` is the argument.

Everything else 10.1 lists — state postures, calling windows, research limits and
route-eligibility thresholds, approved templates, memberships, devices, mailboxes,
pauses — already has its own table, its own versioning and its own commands, written
by the lane that owns the behaviour. None of it is copied here. A workspace with two
answers to "what is the calling window" is worse than a settings page with links on
it, so the settings response carries `elsewhere`: a list of topic, endpoint and
owning lane that the page renders as navigation. `SETTINGS_ELSEWHERE` in
`packages/domain/settings/elsewhere.ts` is that list, and it is data rather than
prose so a slice that moves breaks a test rather than leaving a dead link.

The business zone is the one overlap, and deliberately:
`workspaces.business_time_zone` stays the value every query reads and the setting row
is the history of how it got there. The command writes both in one transaction.

## The three rules of the store

**A change is a new version, never an edit.** `updateSetting` inserts version *n+1*
and marks version *n* superseded. "Who lowered the sending cap, when, from what, and
why" is a `SELECT`. `workspace_settings_current`, a partial unique index over
`superseded_at IS NULL`, is the invariant: one current answer per key per workspace.

**The key chooses the schema.** The command carries `settingKey` and an opaque
`value`, and the server picks the validator from `SETTING_VALUE_SCHEMAS`. A client
cannot nominate which validation applies to its own payload. It is also how the
bounds that are relationships are held: 13.3's warning threshold must stay below its
critical one, and a request that inverts them is refused with `invalid_value` and
writes nothing. The bounds that are *safety* bounds — 12.7's ceiling, 12.6's guard —
are not here at all; they are G7-2's CHECKs, because a schema binds the API and a
constraint binds everything.

**Two admins saving the same slice queue.** `pg_advisory_xact_lock` on
`(workspace, setting key)`, taken inside the command's transaction. Without it both
read version *n*, both write *n+1*, and the loser takes a unique violation — which
aborts the transaction and takes the command receipt with it. The lock is
transaction-scoped, so `updateSetting` must be called inside one; `runCommand` always
is, and the domain test wraps it the same way.

`superseded_at` is `greatest(now(), changed_at)` rather than `now()`, because `now()`
is the transaction-start instant and the superseding transaction may have begun
before the one it retires committed.

## The nine thresholds of 13.3

They are configuration, "versioned with the release", and they are also Terraform
variables that build the CloudWatch alarms. Two copies of one set of numbers drift,
so `packages/domain/test/settings/settings.test.ts` reads
`infra/modules/alerts/variables.tf` and fails when a default here disagrees with the
default there. Eight of the ten fields have a variable; the Today deadline is a
workspace-local time of day and the held fraction is a literal inside a metric-math
expression, and `ALERT_THRESHOLD_TERRAFORM_VARIABLES` records both exceptions as
`null` so the test's list stays honest.

Changing a threshold in the settings store does **not** move the alarm. The alarm is
Terraform, and infrastructure is deployed rather than configured at runtime. The
stored value is what the application reads and what an operator compares an alarm
against; moving both is a release.

## Pauses

Pauses are G4's and are unchanged: `POST /pauses/open`, `POST /pauses/release`,
`GET /pauses`. What matters for this page is the half of 10.1 the settings surface has
to get right — "a sending pause does not stop Gmail synchronization, opt-out
processing, Today construction, or manual calling unless calling is separately
paused". An `email` channel pause blocks `email_send` and nothing else; only a `call`
pause or a pause over all automation reaches `dial_authorization`.
`CHANNEL_BLOCKED_ACTION_KINDS` in `packages/domain/policy/types.ts` is that sentence,
and `packages/domain/test/policy/policy.test.ts` proves it.

## Sending caps, the ramp and domain authentication

Not this lane's. G7-2's `POST /outbound/cap` sets the admin lower bound and the raise
to 75 on `mailbox_send_ramp`; `POST /outbound/authentication` records the SPF, DKIM,
DMARC and Postmaster facts and the per-domain enable on `sending_domains`. The
per-domain ramp is computed from `healthy_sending_days` and never stored.
`personal_gmail_guard_per_24h` has no route on purpose — 12.6 calls changing it a
reviewed product-policy change — so the settings page renders it read-only. Both
`/outbound/*` paths are admin-only with a redacted 403, so the section is gated on
role rather than offering a control that answers 403.

## Production sending

Two switches, ANDed: the deployment flag the release process sets and the
`sending_enabled` setting an admin flips, the latter requiring a
`releaseGateReference`. `docs/decisions/g9-sending-enable-is-two-switches.md` is the
argument. Every surface shows both separately, because an admin who has enabled
sending and still cannot send has to see which half is off.

A **third** fact holds beside them and is not this lane's: G7-2's per-domain
`sending_domains.automated_sending_enabled`, the DNS authentication gate. The two are
not copies of one another — a domain with perfect authentication that nobody
rehearsed must not send, and a rehearsed release must not send from a domain that
fails DMARC — and all three must hold before an automated send. **G12 (release
gates) wires the send path's read**; this lane owns the storage, the history, the
admin command and the surfaces. Until G12 lands the attestation is enforced nowhere
on the send path, which is safe only because both switches are off by default and no
automated send exists yet. See
`docs/decisions/g9-two-slices-that-belong-to-other-lanes.md`.

## The dashboard

One read, `POST /dashboard`, over a window the caller names. The window is required:
a figure whose window the caller did not choose is a figure two people compare and
disagree about, and the upper bound is exclusive so two adjacent windows never
double-count.

Two rules make "respects the read matrix" true rather than claimed. Nothing in the
DTO names a firm, a contact or a person — every field is a count, a duration or a key
from a closed set, so there is no field a name could leak into. And the figures are
computed over the firms the caller may see at Appendix F's row-two visibility: the
workspace for an admin, assigned firms for a salesperson. See
`docs/decisions/g9-dashboard-visibility.md`; the short reason is that in a workspace
of two salespeople with one firm each, a workspace-wide count *is* the other person's
count.

Six of 13.4's figures read tables that are not on main yet. They are behind
`DashboardSources`, whose default answers `{ available: false, owner, reason }`, and
the Mac renders that as "not in this build (G7-2)" rather than as zero. Zero is a
measurement. See `docs/decisions/g9-dashboard-sources.md` for the wiring the owning
lanes do.

## Diagnostics

`GET /diagnostics`, authenticated and workspace-scoped. It is not `/health`, which
answers 200 while degraded for an operator, and not `/readyz`, which fails closed for
the load balancer: it is the page a person opens inside the Mac.

It shows the applied schema version against the range this API accepts, the supported
client-version range, both halves of the sending switch, the restore generation
against the operator's expected one, job counts and ages, every heartbeat with its
freshness, the canary age, every open alert with its acknowledgement state and its
runbook path, and the mailboxes.

The mailbox panel is Appendix F's third row — "mailbox diagnostics: mailbox owner or
admin" — so an admin sees every mailbox, a salesperson sees their own and no other,
and an admin reading somebody else's writes the access audit event 5.2 asks for.

## Stage administration

8.1's four verbs, admin-only, over G3a's `pipeline_stages`:
`POST /pipeline/stages/{create,rename,reorder,retire}`. All four refuse a terminal
stage (`stage_terminal`), and retire additionally refuses the last unretired
nonterminal one (`stage_last_active`). `docs/decisions/g9-terminal-stages-are-not-administrable.md`
has the reasoning and what it costs.

Positions stay contiguous from 1 with the terminal stages last after every command,
because `reopenOpportunity` takes "the first non-terminal, unretired stage" by
position. The reorder defers `pipeline_stages_position_unique` for its transaction and
writes the new order in one statement rather than shuffling through a temporary range
a concurrent reader could observe.

`POST /pipeline/board` is the board read that closes G6's gap; see
`docs/decisions/g9-pipeline-board-read.md`.

## Alerts and runbooks

`GET /admin/alerts` and `POST /admin/alerts/acknowledge` are G5's and are unchanged.
What this lane adds is the runbook per alarm: `docs/greenfield/runbooks/<alarm>.md`,
one per key in `local.alarms` in `infra/modules/alerts/main.tf` plus
`all_sequences_held`, each with Symptoms, First checks, Diagnosis, Safe recovery,
Escalation and **What must stay held**.

That last heading is the one 13.3 is unusual in naming. Under an alarm the instinct
is to clear the blockage, and for most of these the blockage is the safety property:
the hold on a mailbox whose coverage is unproved, the `dispatching` fence that must
never be resent, the restore holds that release at step 9 and not step 1.

`packages/domain/test/dashboard/runbooks.test.ts` reads the Terraform as text —
`terraform` is never run — and fails when the Terraform, `ALARM_RUNBOOKS` and the
files on disk stop agreeing in either direction.

## Running the tests

```
npm run gate:greenfield
npm run test --workspace packages/domain -- test/settings/settings.test.ts
npm run test --workspace packages/domain -- test/dashboard/dashboard.test.ts
npm run test --workspace packages/domain -- test/dashboard/runbooks.test.ts
npm run test --workspace packages/domain -- test/crm/pipelineAdmin.test.ts
npm run test --workspace apps/api -- test/administration.test.ts
npm run test --workspace apps/desktop -- test/settings.test.ts
```
