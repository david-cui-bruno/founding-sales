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
packages/domain/dial/identities.ts                 the calling numbers "Your calling number" edits
docs/greenfield/runbooks/*.md                      one page per alarm
```

## What this lane stores, and what it deliberately does not

`workspace_settings` holds two active slices: the workspace business zone and the
production sending attestation. The alarm thresholds and the supported client-version
range were retired on 26 September 2026 (lane W1-C): the alarms read Terraform's values
and the API's client-version policy is code, so neither slice was read by anything.
Their rows stay allowed by the database until migration 0019.

It held a fifth, `postal_footer`, until 22 September 2026. David decided that an
automated email carries no postal address, so there is nothing to configure: the key
is gone from `SETTING_KEYS`, migration 0015 deleted every row of the slice and
narrowed `workspace_settings_key_known` to the four above, and the Mac's
administration page has no section for it. It is not in `SETTINGS_ELSEWHERE` either,
because that list is navigation and there is nowhere to go. See
`docs/archive/decisions/g20-automated-email-carries-no-postal-address.md`. The footer itself
survives — it is the sign-off and the reply-to-stop line, and it lives on the approved
template version rather than in configuration.

**The rule that decides what is in it:** a `jsonb` settings slice is for an operator
knob that nothing joins to, nothing constrains, and nothing freezes a version of.
Two slices were drafted here and removed before publication for failing that test —
the holiday calendar, whose *version* every stored due instant freezes (G8's
`workspace_holiday_calendars`, migration 0012), and the sending limits, whose
ceilings are row-level CHECKs rather than schema maxima (G7-2's `mailbox_send_ramp`
and `sending_domains`, migration 0010).
`docs/archive/decisions/g9-two-slices-that-belong-to-other-lanes.md` is the argument.

Everything else 10.1 lists — state postures, calling windows, approved templates,
memberships, devices, mailboxes, pauses — already has its own table, its own
versioning and its own commands, written by the lane that owns the behaviour. None of
it is copied here. A workspace with two
answers to "what is the calling window" is worse than a settings page with links on
it, so the settings response carries `elsewhere`: a list of topic, endpoint and
owning lane that the page renders as navigation. `SETTINGS_ELSEWHERE` in
`packages/domain/settings/elsewhere.ts` is that list, and it is data rather than
prose so a slice that moves breaks a test rather than leaving a dead link.

The business zone is the one overlap, and deliberately:
`workspaces.business_time_zone` stays the value every query reads and the setting row
is the history of how it got there. The command writes both in one transaction.

## How the page edits them (lane g88)

Each setting has typed controls, built by `settingFields` in
`apps/desktop/src/renderer/settingsView.ts` and read back by `settingValueFrom`:

* The business zone is a picker of the US zones that Add firm offers.
* Production sending is a switch and a release-gate reference.

Nothing is clamped on the Mac. The server's `invalid_value` is still the answer. The
version and when it changed, and the value as JSON, are behind each setting's
**Details**.
`elsewhere` is listed by topic, with endpoints and owning lanes behind **Where each is
changed**. A reason reads as a sentence ("Only an admin can change this."), not a code. A
slice this build does not recognise is edited as JSON under Details. This supersedes
`docs/archive/decisions/g9-settings-editing-is-json.md`. See
`docs/archive/decisions/g88-founder-authoring-and-review.md`.

## The three rules of the store

**A change is a new version, never an edit.** `updateSetting` inserts version *n+1*
and marks version *n* superseded. "Who lowered the sending cap, when, from what, and
why" is a `SELECT`. From desktop 1.0.5 it is also on screen: **History** under a setting
draws each version's note and the value it changed *from* and *to*, from
`POST /settings/history`'s `current` and per-version `value` (lane g78, release.md
8.0aj). 1.0.4 and older stripped both values and drew nothing. `workspace_settings_current`, a partial unique index over
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

## The thresholds of 13.3

They are Terraform variables of `infra/modules/alerts`, and the alarms are built from
them. Changing one is an infrastructure release, not a setting.

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
`personal_gmail_guard_per_24h` is a constant since the personal-Gmail guard was deleted
(26 September 2026); `/outbound/status` still answers it because installed desktops parse
it, and the desktop no longer shows it since wave 1 (lane W1-D). Both
`/outbound/*` paths are admin-only with a redacted 403, so the section is gated on
role rather than offering a control that answers 403.

The Settings view calls all of it. For an admin it reads `/outbound/status` — once
with no argument for the domain checklist, then once per mailbox for
that mailbox's ramp, because the status route has no list form and the mailbox ids
come from `/diagnostics`, which already applies the read matrix to them. For anyone
else the section is **absent, not inert**: an `/outbound/*` control offered to a
salesperson exists only to be refused. The checklist line names which of SPF, DKIM,
DMARC and the Postmaster review is still missing, and does not pre-empt the CHECK
that forbids enabling without all four — it shows the refusal rather than guessing
it. Nothing is clamped on the client: a raise above 75 comes back as a refusal an
admin reads, not a silent 75.

The checklist appears only when `/outbound/status` returns a domain. With no
`sending_domains` row the section reads **"No sending domain is configured."** and shows
no checkboxes, because there is nothing to record against. Lane g57 made the row
exist: a mailbox connect registers its address's domain, and for a mailbox connected
before g57 the operator runs `fss admin workspace bootstrap --sending-domain` (release.md
5.1a). `POST /outbound/domain` (admin only) creates it too, but the page has no "Add
sending domain" control yet. Adding one means a new bridge channel and a new desktop
build, which is a follow-up. Once the row exists, desktop 1.0.4 or later shows the
checklist with no change. `docs/greenfield/sending.md`, "How a sending domain comes to
exist", has the rules.

**No build before desktop 1.0.4 renders this section at all** (lane g69, release.md
8.0ae). The route answers `personalGmailRecipients` as `{ automated, direct, total }`,
and until 1.0.4 the desktop parsed it as a number. Every answer failed, and the section
was absent whatever the database held. From 1.0.4 the guard line read `total` (the line
is gone since wave 1), and a read that fails is no longer silent: for an admin the section keeps its heading and
shows one grey line, *Callie could not read the sending status.*, a sentence naming the
refusal code, and **Retry**, which shows Settings again. The sending read no longer waits
on `/settings` succeeding, and Home's focus and Refresh ask again while it is failing.
`apps/api/test/wire/sendingSection.test.ts` runs the real route into the real desktop
parser, so a change of shape on either side fails the API suite.

## Your calling number

The first section of the Settings screen, for **every role**, because the number is the
person's own and 9.2 refuses a dial from anybody else's (lane g60). Without an attested
number the Today card has no Call button. Before this section existed nothing could make
one, which is why production's only salesperson could not call.

What the section shows:

* **One sentence** naming the number Today calls from (*"Today calls from +1… (Mobile)."*),
  or why there is no Call button (no number yet, or none attested). If the list could not
  be read (offline, or an API older than the route), it says so and offers no Add. An
  empty list would read as "you have no number" and invite a second registration.
* **Each number** with its state. *In use* is the one Today calls from, chosen by the
  server (`usedForCalls`). *Verified* is attested but not in use, because another was
  attested more recently. *Not attested yet* and *retired* are the other two. Beside
  each: **Attest: This is the number I place my calls from.** for a number not yet
  attested or retired, and **Stop using this number** for one not retired.
* **Add**: the number with `+` and country code (spaces and dashes are fine), an
  optional name such as *Mobile*, the statement checkbox (unticked by default), and
  **Add number**. With the box ticked the bridge sends
  `POST /calling-identities/register`, then `/calling-identities/attest`. Unticked, it
  registers the number unverified.

The section is inert only offline or below the minimum client version. The page
decides nothing. It sends the number as typed and shows `number_invalid`,
`number_registered_to_another` and the other refusals as one sentence each.
`docs/greenfield/policy.md` has the rules, and
`docs/archive/decisions/g60-calling-identities-are-attested-in-version-one.md` has why an
attestation is what verification means in version one. The section ships in desktop
**1.0.2**, which the API admits from the release that carries lane g60.

## Workspace holidays

G8's, not this lane's. `workspace_holiday_calendars` is versioned because every due
instant G8 stores freezes the calendar version it was computed under, so a calendar
is superseded rather than edited — which is precisely why it could not be a slice of
`workspace_settings`, where a jsonb blob has no version another row can freeze.

The settings page owns the surface and G8 owns the write. `GET /settings` carries the
current calendar, read through G8's `currentHolidayCalendar`; the editor posts to
`POST /sequences/holidays`. The version box is empty rather than prefilled, because a
supersession needs a new name and offering the taken one invites a refusal. The
section is shown to a salesperson, inert: somebody whose step was delayed by a
holiday is entitled to see which holiday.

An empty calendar is a correct calendar, not an error. Weekends are skipped by the
rule rather than by the list, so a workspace that observes no holidays is a
configured workspace and the page says so in those words.

## Production sending

Two switches, ANDed: the deployment flag the release process sets and the
`sending_enabled` setting an admin flips, the latter requiring a
`releaseGateReference`. `docs/archive/decisions/g9-sending-enable-is-two-switches.md` is the
argument. Every surface shows both separately, because an admin who has enabled
sending and still cannot send has to see which half is off.

A **third** fact holds beside them and is not this lane's: G7-2's per-domain
`sending_domains.automated_sending_enabled`, the DNS authentication gate. The two are
not copies of one another — a domain with perfect authentication that nobody
rehearsed must not send, and a rehearsed release must not send from a domain that
fails DMARC — and all three must hold before an automated send. G12 wired the send
path's read of the attestation (`docs/archive/decisions/g12-the-send-gate-reads-both-switches.md`).
See `docs/archive/decisions/g9-two-slices-that-belong-to-other-lanes.md`.

**The reference is bound to the release record (lane g71).** `releaseGateReference`
was once any nonempty string. Now it has to name a row of `release_records` (migration
0017), which `fss admin release-record put` stores from the rehearsal's
`release-record.json`. The rule is checked twice, and each process compares its own
half of the record:

* **Saving** `sending_enabled` with `enabled: true` (`updateSetting`, in the command's
  transaction) is refused unless the record exists, its suite is `pass`, and its
  `artifacts.api` is the digest of the API image taking the write. Each failure has its
  own settings refusal code: `release_record_unknown`, `release_record_not_passing`,
  `release_record_digest_mismatch`, and `release_record_identity_unknown` when the API
  could not read its own digest from the ECS task metadata. That last one fails closed.
  `enabled: false` is always accepted.
* **Sending**: the worker's gate requires the record's `artifacts.worker` to be its own
  running digest (`docs/greenfield/sending.md`).

`GET /settings`'s `effectiveSendingEnabled` and `GET /diagnostics`'s admin half are
true only while the attested record names this API's digest. After a deploy of other
digests the page says sending is off, which is also what the worker's gate says. See
`docs/archive/decisions/g71-sending-gate-is-bound-to-the-release-record.md`.

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
`docs/archive/decisions/g9-dashboard-visibility.md`; the short reason is that in a workspace
of two salespeople with one firm each, a workspace-wide count *is* the other person's
count.

Several of 13.4's figures read tables other lanes own. They sit behind
`DashboardSources`, an interface whose default answers
`{ available: false, owner, reason }` so that a figure nobody can compute says so
rather than rendering as zero. Zero is a measurement.

All three methods are now implemented against real tables:

* **sending** (G7-2) — sends, holds, `unknown_terminal` fences, 12.5's two admin
  resolutions, provider deferrals, unhealthy send days, the domain and ramp posture,
  and breakdowns by sequence, template version, weekday and local send hour. The last
  two are computed in the fence's own `source_zone`, so "nine in the morning" means
  nine in the morning where the firm is. Replies are matched by Gmail thread.
* **enrollments** (G8) — started and ended over the window; active, awaiting review
  and held *now*. The two kinds are named differently rather than blended: a state
  is a fact about this instant, and "fourteen holds" is something to go and clear
  while "fourteen holds at some point last month" is not.
* **classifier** (G7b) — model, effort, cap, prompt versions seen, calls attempted
  and sent, outcomes, tokens, latency, and drift as corrections against acceptances.
  **There is no money figure**: the table records tokens, nothing records a price,
  and a rate hard-coded into a dashboard query would go stale silently.

One figure is still unavailable and will stay so until somebody decides what it
means: `bySegment`. No migration from 0001 to 0013 records a segment anywhere, so it
answers `owner: 'unassigned'` — nobody has been asked to supply it — while every
figure beside it is a number. See `docs/archive/decisions/g9-dashboard-sources.md`.

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
nonterminal one (`stage_last_active`). `docs/archive/decisions/g9-terminal-stages-are-not-administrable.md`
has the reasoning and what it costs.

Positions stay contiguous from 1 with the terminal stages last after every command,
because `reopenOpportunity` takes "the first non-terminal, unretired stage" by
position. The reorder defers `pipeline_stages_position_unique` for its transaction and
writes the new order in one statement rather than shuffling through a temporary range
a concurrent reader could observe.

`POST /pipeline/board` is the board read that closes G6's gap; see
`docs/archive/decisions/g9-pipeline-board-read.md`.

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
