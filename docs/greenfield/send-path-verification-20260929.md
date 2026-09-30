# The final send path, verified before the sending pause is lifted (29 September 2026)

David, 29 September 2026 (`.context/DECISION-20260929-sending-pause-and-access.md`):

> Before lifting the pause, verify the final send path enforces follow-up eligibility,
> suppression, firm-wide coordination, and exclusion of old cold-e-mail enrollments.
> Once that works, eligible sending can run automatically without approval for every
> message.

This document is the trace. It is a read of the code at `23ec4338`, plus two tests
added for the one property that had enforcement but no test of its own. Nothing here
was run against production, and nothing here changes what the system sends today.

**Verdict in one line, as first written (29 September, at `23ec4338`): two of the four
properties are enforced and now pinned by tests; two are not enforced at all and cannot
be without a decision from David.** The pause should stay.

---

## Update, 29 September 2026 evening — after David's decisions and migration 0025

David answered the three questions this document stopped on
(`.context/DECISION-20260929-send-path-decisions.md`, items 1–3), and lane FU built them:
migration `0025_follow_up_permissions.sql`, and
`docs/greenfield/decisions/follow-up-eligibility-20260929.md` for the design as built.

**The four verdicts now:**

| property | was | is | where | test |
| --- | --- | --- | --- | --- |
| 1. Follow-up eligibility | OPEN | **CLOSED** | `sequences/eligibility.ts` `followUpPermissionSource`, second source after suppression, asked at preparation and again inside the dispatch claim; `sequences/followUpPermissions.ts` `verifyFollowUpPermission` re-reads the evidence row | `test/sequences/followUpEligibility.test.ts` (19 cases), `test/outbound/firmExclusivityAtSend.test.ts` |
| 2. Suppression | PROVEN | **PROVEN, unchanged** | `suppressionSource` is still first, and nothing in 0025 touches it | `test/sequences/suppressionOutlivesReenrollment.test.ts`, unchanged and still passing |
| 3. Firm-wide coordination | partly PROVEN, one clause OPEN | **CLOSED** | `enrollContact` refuses `firm_already_enrolled` under the firm row lock; `firmExclusivitySource` refuses the pre-existing rows at the step and in the claim | `test/sequences/scenarios.test.ts` scenario 33 (rewritten), `test/outbound/firmExclusivityAtSend.test.ts` — two real claims on two connections, exactly one e-mail |
| 4. Exclusion of old cold-e-mail enrollments | OPEN | **CLOSED** | `sequence_enrollments.origin_kind NOT NULL DEFAULT 'cold_legacy'` — the DEFAULT *is* the backfill, with no `UPDATE`; `listStepWakes` excludes it and `followUpPermissionSource` refuses it | `test/sequences/followUpEligibility.test.ts`, "cold_legacy" — the pre-0025 insert shape, no wake, refused at the step, and a resume cannot revive it |

**The manual-mode wall of section 1 is resolved for follow-ups only.**
`opportunities.control_mode_origin` records which of `MANUAL_MODE_ORIGINS` set manual
mode; a prospect *signal* (`human_reply`, `engaged_call`, `direct_send`) no longer blocks
an evidenced follow-up step, while a person's `salesperson_command` takeover — and an
unrecorded origin, which is every opportunity that went manual before 0025 — still does.
Nothing reverses manual mode, and prospecting and legacy steps are unchanged.

**What did not change.** The three switches of section 0 are untouched: nothing here
lifts the pause, and `sending_enabled` is still `{"enabled": false}`. The read list at
the bottom of this document still applies, and read 2 should now answer **zero** — every
live enrollment is `cold_legacy` and `listStepWakes` will not wake one. The sole
remaining gap named in this document and *not* closed by 0025 is the last paragraph of
section 2: `enrollContact` still accepts a re-enrollment of a suppressed contact, which
is a hygiene problem and not a sending one.

One thing to note rather than to discover later: the send path does not compare a fence's
own `contact_id` with its enrollment's, and did not before 0025 either. In the product
they are always the same person — `runEmailStep` addresses the enrollment's contact — so
the permission check reads the enrollment's column, and a fence's recipient address is
covered by suppression and by the frozen-route check. Closing it would be a one-line
refusal in `outbound/stepPermission.ts`; lane FU's brief did not ask for it.

---

## 0. The path, end to end

| Stage | Where |
|---|---|
| A step becomes due | `packages/domain/sequences/wake.ts:160` `listStepWakes` |
| … materialized as a job | `apps/worker/src/handlers/sequenceAction.ts:133` `sequenceActionSource` |
| The job's claiming transaction | `apps/worker/src/handlers/sequenceAction.ts:92` |
| Eligibility, first asking | `packages/domain/sequences/executions.ts:255` (`input.eligibility.evaluate`) |
| The eleven questions | `packages/domain/sequences/eligibility.ts:441` `composeEligibility` |
| Bytes rendered, fence prepared | `packages/domain/sequences/executions.ts` `runEmailStep` → `sendHandoff.prepare` |
| Commit, then dispatch | `apps/worker/src/handlers/sequenceAction.ts:111` `dispatchPreparedStep` |
| The send gate, whole | `packages/domain/outbound/gate.ts:115` `decideSend` |
| Eligibility, second asking (frozen envelope) | `packages/domain/outbound/stepPermission.ts:69` |
| The workspace pause switch | `packages/domain/outbound/gate.ts:171-201` |
| The claim and the one Gmail call | `packages/domain/outbound/send.ts` |

**There is no per-message approval step anywhere on this path.** A grep for
`requiresApproval`, `approval_required`, `send_approval` and `per-message` over
`packages/` and `apps/` returns nothing. What stands between "due and eligible" and
"sent" is exactly three switches, ANDed:

1. `workspace_settings.sending_enabled` — the admin's attestation
   (`gate.ts:171`, via `settings/effective.ts` `effectiveSendingEnabled`);
2. the deployment's own flag `deploymentSendingEnabled`, plus the release-record
   binding to this worker's image digest (`gate.ts:196`);
3. `sending_domains.automated_sending_enabled` together with SPF/DKIM/DMARC
   (`gate.ts:204-208`).

Turning any one of the three off holds every automated email with
`workspace_sending_not_attested` or `automated_sending_disabled`; nothing is sent and
nothing is lost. That is what "the pause" is, and it is honest: there is no fourth,
quieter path to Gmail for a sequence step. (`packages/domain/test/outbound/attestation.test.ts`
proves each half separately.)

---

## 1. Follow-up eligibility — **CLOSED by migration 0025** (read as written on 29 Sep, at `23ec4338`)

**The property David asked for:** every message that can leave belongs to an
enrollment created by a permitted origin — a recorded conversation, an explicit
request from the person, or a booking confirmation.

**What the code carries:** nothing of the kind. `sequence_enrollments` (migration
0012) has columns for the version, the opportunity, the firm, the contact, the
assignee, the state, the frozen zone and calendar. There is **no origin, no basis, no
source and no kind**. `enrollContact`
(`packages/domain/sequences/enrollments.ts:72`) checks the version is published, the
firm is active/assigned/zoned, the opportunity is open, the contact is active, and the
contact has no live enrollment. It never asks why.

**Every path that can create or resume an enrollment:**

| Path | Site | Carries an origin? |
|---|---|---|
| `POST /enrollments/enroll` | `apps/api/src/routes/enrollments.ts:106` → `enrollContact` | No |
| Desktop "enrol" | `apps/desktop/src/main/crmBridge.ts` → the same route | No |
| Worker jobs | none — no handler under `apps/worker/src/handlers/` inserts an enrollment | — |
| Import | `packages/domain/crm/import.ts` creates firms/contacts only | — |
| Merges | `packages/domain/crm/merges.ts` re-points rows; creates none | — |
| Deletion / retention | `packages/domain/retention/deletion.ts:734` only *stops* | — |
| Restore | `packages/domain/restore/missingFences.ts` inserts sent tombstones; revives nothing | — |
| Resume | `packages/domain/sequences/resume.ts:300` shifts due instants; `ended_at` is never cleared | — |
| Successor steps | `packages/domain/sequences/successor.ts` — inside an existing enrollment | inherits nothing |

`INSERT INTO sequence_enrollments` appears exactly once in the repository
(`enrollments.ts:138`), and nothing anywhere clears `ended_at`. So the surface is
narrow — one authenticated human command — but it is unconditioned.

**A surprising consequence, and it points the other way.** `controlModeSource`
(`eligibility.ts:165`) refuses any step whose opportunity is not `control_mode =
'automated'`. A confirmed human reply, an engaged call outcome and a direct Gmail send
all set the opportunity `manual` (`crm/pipeline.ts:238` `setManualControlMode`), and
**there is no `manual → automated` path in the codebase** — `pipeline.ts:229` says so
outright, and a grep for a write of `control_mode = 'automated'` finds only the table
default. A reopened opportunity also starts manual (`pipeline.ts:308`).

So today the set of enrollments that can send automatically is precisely the set whose
firm has *not* had a recorded conversation or reply — the opposite of the property.
Enforcing follow-up eligibility is not a matter of adding one check; it needs the
manual/automated model settled first.

**Failure mode if the (absent) check were removed:** not applicable; there is nothing
to remove.

**The smallest data-backed rule I can propose without a schema change.** The database
already records the two origins David named:

* a conversation — `call_logs` with `outcome IN ('interested','callback_requested','referral_or_wrong_person')`
  for the enrollment's `firm_id` (and `contact_id` where recorded), `occurred_at` before
  the enrollment started;
* an explicit request — a `mail_messages` row with `direction = 'inbound'` matched to
  the firm through `mail_message_matches`, or a `mail_reply_confirmations` row for the
  opportunity with `disposition IN ('interested','follow_up_later')`.

A booking has no table yet (Cal.com is not built), so the third origin cannot be
expressed at all.

The rule would be a new `followUpOriginSource` in `eligibility.ts`, placed after
suppression, refusing with a section-15 hold code when no such row exists. It needs
three decisions only David can make:

1. **Which signals count**, exactly, from the lists above.
2. **What happens to the enrollments that exist now**, which will all fail it.
3. **How the manual-mode wall is resolved** — a reply is both the origin that permits a
   follow-up and the event that makes the opportunity manual for ever. Either a
   permitted follow-up needs a way back to `automated`, or follow-ups after a reply
   must run under a different control mode than cold steps do. Until this is answered
   any origin rule is either vacuous or blocks everything.

**STOP: this needs David.** (No schema change is strictly required for the rule
itself; recording the origin *on the enrollment* rather than inferring it would need
one, and would be the better design.)

*Answered: David chose exactly that — the origin on the enrollment, with its supporting
event, its recipient, the permitted follow-up and its timing. See the update at the top.*

---

## 2. Suppression — **PROVEN** (with one test added)

| Sub-property | Enforcement site | Test | If removed |
|---|---|---|---|
| Firm and handle suppression, at preparation **and** at the dispatch claim | `packages/domain/sequences/eligibility.ts:240` `suppressionSource`, first in `defaultEligibilitySources` (`:419`); asked again through `outbound/stepPermission.ts:69` inside the claim | `packages/domain/test/sequences/suppressionOutlivesReenrollment.test.ts` — both cases | Both new tests fail (verified by commenting out `suppressionSource()` at `eligibility.ts:421`) |
| A second, independent check at the gate, on the fence's own recipient address | `packages/domain/outbound/gate.ts:137` `firstSuppressed` | `packages/domain/test/outbound/scenarios.test.ts:390` "Appendix G 6: an opt-out that commits before dispatch stops the send" | the send goes out after the opt-out commits |
| Suppression outlives a re-enrollment | same source; `enrollContact` does **not** refuse a re-enrollment, so the guarantee is entirely at the step | `.../suppressionOutlivesReenrollment.test.ts` > "holds the first step of a re-enrollment made after the opt-out, and hands nothing to the send" | the re-enrolled step is prepared and handed to the sending lane |
| A stop request reaches the whole contact, not one address | the `handle` arm unions every `email_addresses` row and every `phone_routes` row of the contact (`eligibility.ts:250-256`) | same file, first case | a second address of the same person keeps receiving |
| A merged firm's suppressions follow the merge | `packages/domain/crm/merges.ts:426` re-asserts, insert-only | `packages/domain/test/crm/commands.test.ts:693` "preserves suppressions, evidence, stage events, aliases and external ids" | the target firm loses the source's suppression |
| A deleted firm/contact stops | `packages/domain/retention/deletion.ts:725,733` cancels executions and stops enrollments; a `deletion_tombstone` suppression is terminal at once (`suppression/events.ts:133`) | `packages/domain/test/retention/deletion.test.ts` | deleted people keep receiving |
| A route marked invalid stops the send, at the frozen version | `eligibility.ts:327` `frozenRouteOutcome` | `packages/domain/test/outbound/dispatchRecheck.test.ts:101,129` | a fence addressed to a bounced route goes out |
| The two writers cannot interleave | `packages/domain/policy/sendGate.ts` — every stop fact takes the workspace advisory lock exclusively; the claim takes it shared | `packages/domain/test/outbound/replyAfterEligibility.test.ts:60` | a suppression committing during a claim is missed |

The gap that remains is deliberate and small: **`enrollContact` does not refuse a
re-enrollment of a suppressed contact.** The command succeeds and the enrollment sits
there holding for ever. That is a display and hygiene problem, not a sending one, and
fixing it at the command is a product choice (it would also need a refusal code and a
desktop string). Noted, not changed.

---

## 3. Firm-wide coordination — **CLOSED by migration 0025** (read as written on 29 Sep, at `23ec4338`)

| Clause | State | Site / test |
|---|---|---|
| A reply, call outcome or stage close from anyone at the firm ends the **others'** enrollments | **PROVEN** | `packages/domain/sequences/terminalStops.ts:177-186` — an `opportunity.manual_mode` event stops by `firm_id`, a `terminal_stop` by opportunity; `packages/domain/sequences/enrollments.ts:236` `stopEnrollments` cancels every `pending`/`held` execution in the same statement pair. Tests: `packages/domain/test/sequences/scenarios.test.ts:181` and `:465` ("one reply stops all three"). Remove the `firmId` arm at `terminalStops.ts:183` and `:465` fails. |
| The confirmed reply does this inside its own command transaction, not only in a drain | **PROVEN** | `classification/confirmations.ts` → `applyManualModeStop` (`terminalStops.ts:232`); the drain is idempotent because `stopEnrollments` matches `ended_at IS NULL` |
| The serialisation point for two due steps of one firm in the same tick | **PROVEN, but it is not a firm lock** | Each step serialises on its own row (`step_executions_one_per_step`, the wake key `step-execution:{id}:{wake}`, `lockStepWithEnrollment`), and every send serialises on the workspace send gate (`policy/sendGate.ts`) plus the per-mailbox day counter taken by `UPDATE ... WHERE automated_sent < cap` in the claim's transaction (`outbound/ramp.ts`). Test: `packages/domain/test/outbound/scenarios.test.ts:313` "the mailbox cap holds the excess rather than sending it". **There is no per-firm serialisation and no per-firm cap.** |
| The per-day cap | **PROVEN, per mailbox** | `gate.ts:228-234`; `dispatchRecheck.test.ts:281` proves it counts on the business date of the claim |
| The per-firm cap | **OPEN — does not exist** | no column, no code, no test |
| No two people at the same firm receive parallel automated threads | **OPEN — the code deliberately allows it** | `sequence_enrollments_one_active_per_contact` is a partial unique on `(workspace_id, contact_id)`. `docs/greenfield/sequences.md:115-118`: *"There is deliberately no index on `(workspace_id, firm_id)`: 11.2 permits unlimited contacts at one firm to be enrolled and to receive mail on the same day."* |

**Why I did not close the last clause.** David's engineering directive of 29 September
(`.context/DECISION-20260929-crm-directive.md`, item 5) says *"Enforce one active
prospecting contact per firm."* The repository says the opposite, on purpose, and it
is not an oversight: **Appendix G scenario 33 of specification revision 3 is "many
contacts at one firm, due on the same day"**, and it is a mandatory scenario with its
own test (`packages/domain/test/sequences/scenarios.test.ts:464`). Adding a firm-level
refusal to `enrollContact` would delete a specified acceptance scenario.

That is a product decision between the directive and the specification, not a missing
check, so this lane stopped rather than picking one. **STOP: this needs David.**

*Answered: "the directive wins." Both halves below were built, and scenario 33 is
rewritten. The exception David added in the same sentence is that follow-up permissions
to several people at one firm are not limited by the rule.*

If he confirms the directive wins, the change is small and has two halves worth doing
together:

* `enrollContact`: after the firm lock (already `FOR UPDATE`, so it serialises), refuse
  when another contact at the firm has a live enrollment — a new
  `firm_already_enrolled` refusal code, a desktop string, and scenario 33's test
  rewritten to assert the refusal;
* a send-time guard for the rows that already exist, because an enrollment-time
  refusal does nothing about parallel threads created before it landed.

---

## 4. Exclusion of old cold-e-mail enrollments — **CLOSED by migration 0025** (read as written on 29 Sep, at `23ec4338`)

**Nothing in the data distinguishes them.** I looked for every discriminator the brief
names:

* **enrollment source** — the column does not exist (section 1 above);
* **sequence kind** — `sequences` has `id, name, description, created_by_user_id,
  archived_at, created_at, updated_at`. No kind, no classification. The only signal is
  the free-text `name`, which is whatever the founder typed;
* **creation date** — `sequence_enrollments.started_at` exists and is reliable, but
  there is no recorded instant that separates "the cold-outreach shape" from "the CRM
  redesign". The redesign is a set of decision records, not a migration;
* **template lineage** — `template_versions` carries `template_id`, `version`,
  `approved_at`, `personalization_strategy` (constrained to `deterministic`) and the
  0024 presentation columns. No lineage back to an outreach programme.

**Where "due" is decided, and what it excludes:** `listStepWakes`
(`sequences/wake.ts:169-191`) takes every `step_executions` row whose enrollment has
`ended_at IS NULL AND state = 'active'`, that is `pending`/`held` and due, with no open
blocking hold. Sequence, template, age and provenance are not in the predicate. When
the three switches in section 0 flip on, **every live enrollment with a due step sends,
whatever it was created for.**

**Can a restore or resume revive an excluded one?** Within the application, no — and
this is worth saying precisely, because it is the one good news in this section:

* `ended_at` is never cleared. The only writes to `sequence_enrollments` are
  `enrollments.ts:285` (stop), `:304` (complete), `retention/deletion.ts:734` (stop) and
  `resume.ts:300` (`SET updated_at = now()` only);
* `resumeEnrollment` operates on live enrollments and shifts due instants; it cannot
  un-end one;
* `packages/domain/restore` inserts `sent` tombstones for fences lost in a restore. It
  writes no enrollment and no execution.

The revival vector that does exist is outside the application: a point-in-time database
restore to before the stops. That is an operator action, and the read list below is how
to see it.

**The smallest data-backed rule, for David's decision.** Pick one cut and apply it as a
refusal in `listStepWakes` plus a matching source in `composeEligibility` (so the
already-prepared fences are caught too):

> An enrollment whose `started_at` is before `T` does not become due, where `T` is the
> instant David names as the start of the CRM shape.

`started_at` is trustworthy, needs no schema change, and the rule is one predicate in
one query plus one eligibility source. The alternative — a named allow-list of
`sequences.id` values that are the new shape — is equally cheap and more explicit, and
I would prefer it if the number of sequences is small (the production read list asks
for that count).

Anything better than either of those — an `origin` or `programme` column on
`sequence_enrollments` — is a schema change (0025) and the brief says stop rather than
write one. **STOP: this needs David to name `T`, or the allow-list, or to approve a
migration.**

*Answered: neither `T` nor an allow-list. David refused to infer anything from dates,
sequence names or templates, and approved the migration: `origin_kind` defaults to
`cold_legacy`, so the excluded set is exactly the set of rows that existed, with no
`UPDATE` and no cut-off date anybody had to choose.*

---

## What this lane changed

* `packages/domain/test/sequences/suppressionOutlivesReenrollment.test.ts` — new, two
  cases, the only property that was enforced without a test naming it.
* This document.

Nothing in `packages/domain/db/migrations/` changed. Nothing in the desktop changed:
the Settings page reads `sending_enabled` from the API (`apps/api/src/routes/settings.ts:67`)
and says On/Off from the same value the gate reads (`settingsView.ts:748`), so the
display does not lie about the pause.

---

## What the operator should read on production before lifting the pause

Run these as the read-only reporting role against the production database. Do not run
them from a lane. They are ordered so that a bad answer to an early one makes the later
ones unnecessary.

**1. The three switches, as they actually stand.**

```sql
SELECT setting_key, value
  FROM workspace_settings
 WHERE setting_key IN ('sending_enabled', 'business_time_zone', 'postal_address');

SELECT domain, is_primary, automated_sending_enabled,
       spf_pass, dkim_pass, dmarc_pass
  FROM sending_domains
 ORDER BY is_primary DESC, domain;
```

*Expect:* `sending_enabled` `{"enabled": false}` today. Note the
`releaseGateReference` it carries when it is turned on; the worker's image digest must
match that record.

**2. How much would leave on the first tick.** This is the number that matters most.

```sql
SELECT count(*) AS due_now,
       count(*) FILTER (WHERE e.channel = 'email') AS due_email
  FROM step_executions e
  JOIN sequence_enrollments n
    ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
 WHERE n.ended_at IS NULL
   AND n.state = 'active'
   AND e.state IN ('pending', 'held')
   AND e.due_at <= now()
   AND e.not_before <= now();
```

*Expect:* if this is not zero, every one of those rows is a message that leaves within
a minute of the switch. Read list 3 before deciding.

**3. What those enrollments are, and how old.**

```sql
SELECT s.name AS sequence_name,
       sv.version,
       date_trunc('day', n.started_at) AS started_day,
       count(*) AS enrollments,
       min(n.started_at) AS oldest,
       max(n.started_at) AS newest
  FROM sequence_enrollments n
  JOIN sequence_versions sv ON sv.workspace_id = n.workspace_id AND sv.id = n.sequence_version_id
  JOIN sequences s ON s.workspace_id = sv.workspace_id AND s.id = sv.sequence_id
 WHERE n.ended_at IS NULL
 GROUP BY 1, 2, 3
 ORDER BY oldest;
```

*Expect:* this is the whole of section 4's evidence. Every distinct `sequence_name`
here is a candidate for the allow-list; every `started_day` before the cut is a
candidate for stopping. If any row predates the CRM redesign, **do not lift the
pause** until David names the rule.

**4. The origin each live enrollment does or does not have** (section 1's proxy, read
only — it is not enforced anywhere).

```sql
SELECT n.id AS enrollment_id,
       f.name AS firm,
       n.started_at,
       o.control_mode,
       EXISTS (SELECT 1 FROM call_logs c
                WHERE c.workspace_id = n.workspace_id AND c.firm_id = n.firm_id
                  AND c.outcome IN ('interested', 'callback_requested', 'referral_or_wrong_person')
                  AND c.occurred_at < n.started_at) AS had_conversation,
       EXISTS (SELECT 1 FROM mail_message_matches m
                JOIN mail_messages mm ON mm.workspace_id = m.workspace_id AND mm.id = m.mail_message_id
                WHERE m.workspace_id = n.workspace_id AND m.firm_id = n.firm_id
                  AND mm.direction = 'inbound'
                  AND mm.internal_date < n.started_at) AS had_inbound
  FROM sequence_enrollments n
  JOIN firms f ON f.workspace_id = n.workspace_id AND f.id = n.firm_id
  JOIN opportunities o ON o.workspace_id = n.workspace_id AND o.id = n.opportunity_id
 WHERE n.ended_at IS NULL
 ORDER BY n.started_at;
```

*Expect:* rows with `had_conversation = false AND had_inbound = false` are enrollments
with no permitted origin under any reading of David's rule. Rows with
`control_mode = 'manual'` will never send at all (section 1) — if *every* row with an
origin is manual and every automated row has none, that is the wall described above,
in the live data.

**5. Parallel threads at one firm** (section 3's open clause).

```sql
SELECT n.firm_id, f.name, count(DISTINCT n.contact_id) AS live_contacts
  FROM sequence_enrollments n
  JOIN firms f ON f.workspace_id = n.workspace_id AND f.id = n.firm_id
 WHERE n.ended_at IS NULL
 GROUP BY 1, 2
HAVING count(DISTINCT n.contact_id) > 1
 ORDER BY live_contacts DESC;
```

*Expect:* empty. Any row is two people at one firm who would both be written to.

**6. Suppression is present and readable** (a sanity check on the view the gate uses).

```sql
SELECT scope, count(*) FROM effective_suppressions GROUP BY scope;

SELECT count(*) AS live_enrollments_of_suppressed_people
  FROM sequence_enrollments n
 WHERE n.ended_at IS NULL
   AND (EXISTS (SELECT 1 FROM effective_suppressions s
                 WHERE s.workspace_id = n.workspace_id
                   AND s.scope = 'firm' AND s.canonical_key = n.firm_id::text)
        OR EXISTS (SELECT 1 FROM effective_suppressions s
                    JOIN email_addresses a
                      ON a.workspace_id = s.workspace_id AND a.address = s.canonical_key
                   WHERE s.workspace_id = n.workspace_id
                     AND s.scope = 'handle' AND a.contact_id = n.contact_id));
```

*Expect:* the second number may be non-zero and that is safe — those steps hold. It is
the count of enrollments that should be stopped for tidiness, not a sending risk.

**7. The mailbox's cap and ramp, so the first day's volume is known.**

```sql
SELECT m.email_address, r.healthy_sending_days, r.admin_daily_cap, r.raised_daily_cap,
       r.last_advanced_on, r.last_health_failure
  FROM mailbox_send_ramp r
  JOIN mailboxes m ON m.workspace_id = r.workspace_id AND m.id = r.mailbox_id;

SELECT business_date, automated_sent, direct_sent, cap_granted, closed_at, healthy
  FROM mailbox_send_days
 ORDER BY business_date DESC
 LIMIT 10;
```

*Expect:* `healthy_sending_days` near zero and a cap of five a day, which bounds the
blast radius of a mistake on the first day to five messages.

**8. Any fence already prepared and waiting.** These do not go through `listStepWakes`
again; they are re-decided by the dispatch path and can go out as soon as the switches
allow.

```sql
SELECT state, count(*), min(created_at) AS oldest
  FROM outbound_messages
 WHERE state IN ('prepared', 'held')
 GROUP BY state;
```

*Expect:* whatever is here is immediate volume on top of read 2.
