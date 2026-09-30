# Evidenced follow-up permissions, one prospecting contact per firm, and `cold_legacy`

*The design as built, 29 September 2026. Migration `0025_follow_up_permissions.sql`.*

David's decisions of 29 September 2026 (`.context/DECISION-20260929-send-path-decisions.md`,
items 1–3) are the source; `docs/greenfield/send-path-verification-20260929.md` is the read
of the code that produced them. **Sending stays paused.** Everything here is subtractive
with respect to what could leave: the three switches of that document's section 0 are
untouched, and every enrollment that exists is now excluded.

---

## 1. What David asked for, and the one sentence the whole design turns on

> "Record the enrollment origin alongside the supporting event, recipient, permitted
> follow-up, and timing. **The origin label alone must not authorize sending.**"

A column saying `follow_up` is a label. So is a row in a permissions table. The design
is therefore two things, not one: a permission that records *what was agreed*, and a
check that re-reads *the event it rests on* every single time a step is considered.

`followUpPermissionSource` (`packages/domain/sequences/eligibility.ts`) is placed
immediately after `suppressionSource` and asks, in this order: does the permission name
this firm and this recipient; is it unrevoked; **does its evidence row still exist and
still name the same firm and the same person**; is it unexpired; does its scope still
have room. The evidence is a `call_logs` row, or an inbound `mail_messages` row *through
its `mail_message_matches` row* — which is what makes a merge or a deletion withdraw the
permission without anybody having to remember to.

## 2. The scopes, and their windows

| scope | what it permits | window |
| --- | --- | --- |
| `single_email` | one e-mail, once. The dispatch claim spends it (`consumed_at`). | 14 days |
| `contextual_reply` | one reply step, never a sequence. | 14 days |
| `agreed_sequence` | its own named `sequence_id`, and no other. | the agreed sequence's own length |
| `booking_communications` | **reserved**; refused until a booking table exists. | 30 days |

The numbers are `FOLLOW_UP_PERMISSION_WINDOW_DAYS` in `packages/contracts/src/followUps.ts`
rather than a column default, because one of them is not a constant: `agreed_sequence`
expires one day after the last step of its sequence would have been due, chained through
the cadence rule itself (`agreedSequenceExpiry`), so the permission and the plan cannot
disagree about how long the plan is.

`expires_at` is `NOT NULL`. Timing is part of the permission, and a permission without an
end is the indefinite sequence David refused.

**"Call me Tuesday" grants nothing.** It is the existing `callback_requested` path and it
creates a callback task; `logCallOutcome` refuses a `followUpPermission` on any outcome
other than `interested`.

**`booking_communications` refuses, and says why.** The scope is in the vocabulary
because David named the origin, and Cal.com does not exist yet, so `booking_reference` is
a text nothing can verify. A scope whose evidence cannot be re-read cannot satisfy the
rule this design is for, so it refuses with
`follow_up_not_permitted:booking_scope_reserved` rather than waving a permission through
on an unverifiable string. When the booking table lands, one arm of `verifyEvidence`
closes it.

## 3. `cold_legacy`: the DEFAULT *is* the backfill

`sequence_enrollments.origin_kind text NOT NULL DEFAULT 'cold_legacy'`. There is no
`UPDATE` in migration 0025. Every row that exists becomes `cold_legacy` because the
column did not exist when the row was written, and nothing can honestly say more about it
than that — which is exactly David's "don't infer eligibility from dates, sequence names,
or template guesses".

It is also the fail-closed default for code: a path that forgets to say what it is
creating creates an excluded enrollment. `enrollContact` requires `originKind` and no
code path writes `cold_legacy` at all.

Two places state the exclusion, on purpose:

* `listStepWakes` excludes it, so a legacy enrollment is never woken, no job is
  materialized, no fence is prepared and nothing is held — which is why the
  read-before-lift queries in the verification document show **zero** due legacy steps
  rather than a pile of rows each refused one at a time;
* `followUpPermissionSource` refuses it, so any other path into `runDueStepExecution`,
  and any fence already prepared, is caught too.

Nothing clears the value. A later valid request is a **new** enrollment with a **new**
permission; the old row keeps its history and never sends again.

## 4. One active prospecting contact per firm

Two halves, both under the **firm row lock** (`SELECT … FROM firms … FOR UPDATE`), which
is the lock `enrollContact` already took:

* `enrollContact` refuses `firm_already_enrolled` when another live *prospecting*
  enrollment exists at the firm. Correct under concurrent commands because the firm row
  is locked before it is counted.
* `firmExclusivitySource` refuses the same thing at the step and again inside the
  dispatch claim, for the rows that already exist — the schema deliberately permitted two
  people at one firm until this migration. The winner is deterministic: the live
  prospecting enrollment with the earliest `(started_at, id)`, so two steps due in the
  same tick agree about which may go rather than each refusing the other.
  `packages/domain/test/outbound/firmExclusivityAtSend.test.ts` runs two real claims on
  two connections and asserts exactly one e-mail reaches Gmail.

**Follow-ups are exempt**, which is David's own exception in the same sentence:
"it must not prevent ordinary customer conversations involving multiple people".

It is **not** a partial unique index, and that is deliberate: such an index would fail to
build against a production database that already holds two live contacts at a firm, and
the rule is about *prospecting* rather than about enrollments.

Appendix G scenario 33 is rewritten accordingly
(`docs/greenfield/sequences.md`, `packages/domain/test/sequences/scenarios.test.ts`).

## 5. "Reply means manual for ever", resolved for follow-ups only

The wall the verification document found: a confirmed reply is both the origin that
permits a follow-up and the event that makes the opportunity `manual` for ever, and there
is no `manual → automated` path anywhere in the codebase.

`MANUAL_MODE_ORIGINS` already separated the two kinds of cause, but only in
`crm_domain_events.detail`:

| origin | what it is | blocks a follow-up? |
| --- | --- | --- |
| `human_reply` | a confirmed reply — a prospect **signal** | no |
| `engaged_call` | an engaged call outcome — a signal | no |
| `direct_send` | a salesperson's own Gmail send — a **takeover** | **yes** |
| `direct_send_keep_automation` | that salesperson choosing to keep following up | no |
| `salesperson_command` | `POST /opportunities/manual` — a **person's** takeover | **yes** |
| NULL | not recorded: every opportunity that went manual before 0025 | **yes** |

The eligibility gate reads the opportunity row, and the row could not say which it was.
So 0025 adds `opportunities.control_mode_origin`, written by `setManualControlMode`, and
`controlModeSource` refuses a `follow_up` step only when the origin is a person's
takeover or unrecorded. **Prospecting and legacy steps are unchanged**: manual is manual,
whatever put it there. Nothing reverses manual mode — the opportunity stays `manual`, the
card still says so, and the only thing that changes is whether one evidenced follow-up
step may run beside it.

One addition beyond "record the column": `setManualControlMode` returns early when the
opportunity is already manual, so a person taking over a firm that went manual on a reply
would not have been recorded. It now **escalates** the stored origin to
`salesperson_command` in that case, and a signal never overwrites a recorded takeover.
Suppression, every pause switch and the terminal stop are untouched and still win.

**After the review (P1-1).** Three things changed, and the first is a product decision the
coordinator took on 29 September 2026 and flagged to David:

* **A direct Gmail send is a takeover.** It is the salesperson deliberately writing to
  this prospect by hand, not the prospect signalling anything, so it blocks the follow-up
  automation. The exception is a *choice*, not an inference:
  `POST /opportunities/keep-following-up` (`keepFollowingUpAfterDirectSend`) moves the
  stored origin to `direct_send_keep_automation`, and its UPDATE is conditional on the
  origin still being `direct_send`, so it can never relabel a takeover.
* **The takeover is reachable.** `POST /opportunities/manual` (`takeOverOpportunity`) is
  back, with a minimal control on the Firm page — "I will handle this myself", offered
  only while the opportunity is open and automated. Before it, no production caller wrote
  `salesperson_command` at all.
* **A NULL origin is classified one row at a time.** `POST /opportunities/control-mode-origin`
  (`classifyControlModeOrigin`) is admin-only in the domain, takes a reason, is conditional
  on the origin still being NULL, and writes an audit row carrying the reason and the
  facts the administrator was shown. There is no blanket backfill and there will not be
  one.

## 6. Where a permission comes from

* **A confirmed reply** with disposition `interested` or `follow_up_later` →
  kind `request`, scope `contextual_reply`, evidence the inbound `mail_messages.id`,
  granted by the confirming person. Granted **by default**, because David's rule is that
  an inbound question permits a contextual reply; the reply form's select is how a person
  declines (`grantFollowUp: false`).
* **A call outcome `interested`** → the salesperson chooses `single_email`,
  `agreed_sequence` (with its sequence) or none; evidence the `call_logs.id` just
  written, inside the same savepoint as every other effect of the call.
* **`callback_requested`** → the callback task only. No e-mail permission.
* **A booking** → reserved.
* **By hand**: `POST /follow-up-permissions`, `POST /follow-up-permissions/list`,
  `POST /follow-up-permissions/revoke`, authorized like the other CRM writes: identity at
  the route, `decideFirmMutation` in the domain **under the firm's row lock, inside the
  command's transaction**. The route asks nothing of an unlocked `readFirm` before a
  mutation (P1-5), and the grant takes evidence only — the server derives the kind and the
  scope from the evidence row it reads (P0-1). A list with no firm id answers only about
  the caller's assigned firms.

## 6a. One lock order, written down (P1-4)

The review's deadlock is a claim waiting for a firm row while a call outcome waits for the
send gate. It cannot form, and this is the argument, which every path here now obeys:

1. **The send gate first, always.** Every stop-fact writer takes it EXCLUSIVE
   (`lockSendGateForStopFact`) before it touches any row: `setManualControlMode`,
   `applyManualModeStop`, `logCallOutcome`, `enrollContact`, `revokeFollowUpPermission`,
   the terminal stops. `logCallOutcome` did **not**, until the second review of PR 332
   found it: it locked the firm and reached the gate only when it set manual mode, which
   is the one order that could deadlock with a claim. It now takes the gate as its first
   statement. Every dispatch claim takes it SHARED (`lockSendGateForDispatch`)
   before it touches any row. Nothing in either family locks a row before the gate.
2. **Therefore the two families never hold a row the other needs.** A writer that holds
   the gate EXCLUSIVE excludes every claim from starting; a claim in flight holds it
   SHARED, so a writer waits at the gate before it has taken anything. A cycle needs each
   side to hold something the other wants, and the gate is taken first by both.
3. **Inside a family the order is fixed.** The claim:
   send gate → fence → enrollment → permission → firm. Enrollment: send gate → firm →
   opportunity → contact. A terminal stop: send gate → enrollment → step. Preparation asks
   `firmExclusivitySource` for the firm while holding its enrollment and step, and it is
   the only path that does; it is a reader of one row in a family whose writers all sit
   behind the gate.
4. **The winner is total.** `firmExclusivitySource` orders by `(started_at, id)` and reads
   the comparison instant in SQL rather than through the driver, because a JavaScript
   `Date` rounds microseconds down and a competitor started in the same millisecond would
   otherwise compare as later than itself.

5. **A stop owes what was committed before it took the gate** (send-path v2, migration
   0026, 30 September 2026). A terminal-stop event records the enrollments it owes
   (`crm_domain_events.owed_enrollment_ids`) and the drain stops only those. The set is
   computed inside `emitCrmDomainEvent` **under the exclusive send gate**, which
   `enrollContact` also takes first, so every enrollment is on exactly one side: it
   committed before the emitter took the gate (visible to the sub-select, so owed), or it
   waited for the emitter to commit (a deliberate later enrollment, not owed).
   `emitCrmDomainEvent` takes the gate itself for the two stop kinds, which is a no-op
   when the caller already holds it. Every emitter, checked:
   * `changeStage` (the close, `opportunity.terminal_stop`) — gate is its first statement.
   * `setManualControlMode` (`opportunity.manual_mode`) — gate is its first statement.
     Its callers: `logCallOutcome` (gate first); `confirmReplyDisposition`, the confirmed
     human reply (reads only before it); `takeOverOpportunity` (delegates);
     `applyDirectSendEffects` via the mail import (only reads and inserts of new rows
     before it — the fence lookup is a plain SELECT); and `resolveAmbiguity`, which
     wrote `mail_message_matches` rows **before** reaching the gate and now takes it
     before its first write.
   * `applyClassificationEffects` (`mail/effects.ts`) takes the gate first and emits no
     stop event itself; the human-reply manual mode is set by the two paths above.

The tests are in `packages/domain/test/outbound/firmExclusivityAtSend.test.ts`: a barrier
case that proves both claim transactions are open at once through `pg_locks` before the
barrier is released, a tied-`started_at` case, and the review's deadlock shape run as a
real claim against a real `logCallOutcome`, with SQLSTATE `40P01` asserted absent on both.

## 6b. What the second review changed (30 September 2026)

* **Only a selected match is consent.** A sole unselected `mail_message_matches` row no
  longer qualifies; `confirmReplyDisposition` resolves the one match it acts on, in the
  same transaction, because the person confirming the reply is choosing it.
* **The fence's template must be its step's**, for every scope — an `agreed_sequence`
  agrees to *the published version's steps*, so a fence frozen on another approved
  template is refused at the claim (`template_not_the_step’s`).
* **Liveness is checked for every scope at the claim.** The scopes that spend nothing get
  `permissionStillLive` immediately before the commit, against `clock_timestamp()`.
* **A later direct send takes the conversation back**, escalating
  `direct_send_keep_automation` to `direct_send`; the choice can be made again. Only
  `keepFollowingUpAfterDirectSend` may write the keep origin — `setManualControlMode`'s
  input type excludes it.
* **The call-outcome grant path works end to end.** The command carries the approved
  template version, the route forwards it, and the Today form offers the approved
  templates (one extra read, `POST /templates`). An agreed *sequence* is still granted
  from the firm page.
* **`enrollContact` reads `clock_timestamp()` after the gate**, so a permission that
  expired while the command waited cannot supersede a legacy enrollment.
* **The agreed-sequence bound is the real cadence**: start-anchored per 11.1 and computed
  on the workspace's holiday calendar.
* **The call-log agreement CHECK is explicitly Boolean**, because a CHECK admits an
  unknown expression and a null agreement with a populated version id was getting in.
* **The Mac matches the permission to the plan** and requires it unbound
  (`livePermissionFor`).

## 6c. What the third review changed (30 September 2026)

* **An agreement needs a person, and it is checked before the call log is written.** The
  contact check sat inside the savepoint that carries the engaged-call stop, so an
  `interested` call with an agreement and no contact recorded the conversation, rolled the
  stop back and still answered accepted — sequences kept running against a firm that had
  just had a conversation. The grant now has a savepoint of its **own**, after the effects:
  a grant that fails costs the permission and says so (`follow_up_not_granted`), and
  nothing else.
* **The permission list makes no read the query could disagree with.** The route's
  `readFirm` is gone: one statement, with the assignment rule inside it. A salesperson who
  names a firm that is not theirs gets an empty list rather than `not_found`.
* **The bind is conditional on liveness**, not only on being unbound, and zero rows takes
  the whole enrollment — supersession included — with it.
* **An agreed sequence's bound is rebound at enrollment** from the start the run actually
  took and the calendar it froze; the grant's bound was a guess made at grant time.
* **The Mac counts steps, not templates**: "one e-mail" is a plan of one step, and an
  e-mail followed by a call task is not it.
* Three proofs were rewritten to be proofs: the deadlock case uses an engaged outcome and
  a barrier on the fence row (it fails with `40P01` if the gate-first line is reverted),
  and the zero-row consume case expires a live, unspent permission mid-claim (it sends if
  the abort is removed).

## 6d. Edits create versions; migration by supersede (30 September 2026, send-path v2 S2)

David, 30 September 2026: *"Existing enrollments keep their original steps, template
versions, and cadence. Edits affect new enrollments by default. Explicitly migrating an
enrollment must preserve completed steps and the agreed follow-up scope."* The plan review
found the first sentence false: `saveSteps` updated a published version's steps in place
and `updateTemplateVersion` rewrote an approved template's text in place, so a live
`agreed_sequence` run could read steps and text its agreement never covered.

* **An edit is a new version.** Steps saved against a published version become a new
  draft version (copy + change), and the answer names it. While the sequence already has
  a draft, such a save is refused `draft_exists`, naming the draft (the route answers
  `draft_exists:<version>:<id>`), rather than overwriting unpublished work; the Mac turns
  the published Save off and offers the draft. An approved template's edit is its next version,
  pending approval unless the same command approves it. Nothing published or approved is
  written to, and migration 0026's triggers (`sequence_steps_published_immutable`,
  `template_versions_approved_immutable`) say so in the database; a command that reaches
  one answers a refusal (`version_not_draft`, `template_already_approved`) through a
  savepoint rather than a 500. **Publishing retires the version it replaces** (David, 30
  September 2026): one current version per sequence, so new enrollments — and the Firm
  page's list — have one choice; a retired version keeps running for the enrollments
  already on it, its steps frozen by 0026's trigger, and a migration's target is always
  the current version.
* **`POST /enrollments/migrate`** moves one live enrollment to a published version of the
  same sequence by **supersede**: the old enrollment ends `migration_superseded` (its
  unfinished step cancelled, its history kept) and a new one is inserted after it — never
  before, so `sequence_enrollments_one_active_per_contact` and §4's one-prospecting rule
  never see two live rows — with the same origin, contact, opportunity, assignee, the
  **original** `started_at` (copied in SQL), zone and frozen calendar, and
  `migrated_from_enrollment_id` naming the old row. The old enrollment's completed steps
  must be exactly ordinals 1..k (none cancelled, none skipped, nothing unfinished but
  k + 1), else `completed_prefix_required`; the new enrollment gets **one** execution,
  ordinal k + 1 of the target, due at the target's delay for that step from the original
  anchor, and completes at once (`sequence_complete`) when the target has no step k + 1.
* **The agreed scope.** A `follow_up` run moves only on a **fresh** permission for the
  target version, re-verified with `verifyFollowUpPermission` (the target version, its
  step count, the template of step k + 1) and bound to the new enrollment with
  `bindFollowUpPermission`, whose conditional write throws the whole transaction back if it
  loses. The grant's own expiry is kept (the grant computed it for this version's plan); it
  is not recomputed from the original anchor, which could put it in the past. An
  `agreed_sequence` run offered no permission refuses `agreed_scope_bound`; the other
  follow-up scopes refuse `follow_up_not_permitted`. **The old permission** stays bound to
  the old, now ended, enrollment: bound means it can never buy another run (the bind
  requires `enrollment_id IS NULL`, and verification refuses `another_enrollment`), and an
  ended enrollment sends nothing. It is neither revoked (nobody withdrew it) nor consumed
  (`consumed_reason` is about a message leaving, and none did). `cold_legacy` never moves
  (`cold_legacy_never_revived`); `prospecting` moves without a permission.
* **Lock order**, extending §6a: send gate EXCLUSIVE → the old enrollment → the fresh
  permission → the firm → opportunity → contact. The gate first because ending an
  enrollment is a stop fact: a dispatch claim holding the gate SHARED makes the migration
  wait, and a migration in flight makes a claim wait and then find the enrollment ended.
  The step runner does not take the gate; it locks the enrollment first
  (`lockStepWithEnrollment`), as the migration does, so the two serialize on that row. After
  the locks the migration refuses `enrollment_dispatching` when any execution of the old
  enrollment is `dispatched`, has a fence while unfinished, or has a fence `dispatching` or
  `reconciling`. `packages/domain/test/sequences/migrateEnrollment.test.ts` pins both
  orders with a held transaction and races them six times: exactly one proceeds.
* **After the PR 335 review.** (P1-5) A one-message scope is a promise of an e-mail:
  `verifyFollowUpPermission` takes the step a run would pay for next (`nextStep`), and a
  `single_email` needs an e-mail step whose template is exactly the permitted one, a
  `contextual_reply` an e-mail step, and neither buys a run with no next step. Both
  `enrollContact` (its first step) and the migration (step k + 1) pass it. (P1-6) When
  step k + 1's planned instant has already passed (k > 0), it is placed at the target's
  delay for that step counted from now, never the next tick, and the answer carries
  `rescheduledTo`; a run that has done nothing (k = 0) keeps its plan. (Round 2) "Now"
  is `clock_timestamp()`, read after every lock is held, so a plan that passes while the
  command waits at the gate still counts as late; an e-mail's instant is placed in the
  window with `placeEmailSend` on the frozen zone and calendar, and that placed instant is
  both `rescheduledTo` and the instant compared with the fresh permission's `expires_at` —
  a permission that would expire first refuses `permission_expires_before_step` before
  the old run is touched, and stays unbound. (Round 3) Step k + 1 is compared whatever
  its channel (a call task at its due instant), and so is the **first e-mail** of the
  remainder, projected with `successorDue` from each predecessor's projected instant and
  placed with `placeEmailSend` — so a call now and an e-mail after the expiry refuses too. (P2-a) The target
  version is held `FOR SHARE` from its check to the commit, so a publication cannot
  retire it in between; the publication waits, and one that commits first makes the
  migration refuse `version_retired`.
* **Who may.** An administrator, or the firm's assigned salesperson, decided in the
  domain under the firm's row lock; one audit event (`enrollment.migrated`) names both
  enrollments, both versions, the carried ordinals, the permissions and the person's
  `changeNote`.

## 7. Deviations from the brief, each with its reason

1. **`granted_by` is two columns**, `granted_by_user_id` (FK onto
   `workspace_memberships`) and `granted_by_rule` (a name matching
   `^[a-z][a-z0-9_.]{1,63}$`), with a CHECK that exactly one is present. A single text
   column cannot carry the foreign key every other actor column in this schema carries,
   and losing that check to save a column is the wrong trade.
2. **`single_email` is consumed by the dispatch claim, not after `recordSent`.** The
   brief says "when its one send leaves". Appendix B is explicit that a claimed fence may
   have reached Gmail even when the provider call reports nothing, and a fence in doubt is
   re-decided later. Consuming at the claim can cost a permission whose e-mail never
   arrived; consuming after the provider answered could let a second e-mail leave on a
   permission that buys one. It errs in the direction a send that cannot be taken back
   should err in, and it is the same committed chunk the day's send counter is reserved in.
3. **The read is `POST /follow-up-permissions/list`**, not
   `GET /firms/:id/follow-up-permissions`. Every firm read in this API is a POST with the
   firm id in the body; a `GET /firms/:id/...` would need the route registry to claim a
   prefix of `/firms`, which `routes/modules.ts` explicitly does not do for new endpoints.
4. **The recipient is compared with the enrollment's own `contact_id`** — and, since the
   review (P0-2), with the fence's, the execution's, the frozen route's owner and the
   route's address as well. All five must agree at the claim
   (`outbound/stepPermission.ts`), which closes the note this deviation used to carry.
5. **The call-outcome form offers `single_email` or none, not `agreed_sequence`.** An
   agreed sequence needs a sequence picker, and Today's state does not carry the sequence
   list; adding that read is more than "the minimum that lets David grant a permission
   from the flows he already uses". An agreed sequence is granted through
   `POST /follow-up-permissions`. **Note for David:** say if you want the picker on the
   call card in the next slice.
6. **A `single_email` permission carries the template version it permits** — this
   deviation is withdrawn. The review was right (P0-2): a scope that permitted "whichever
   approved one-step template the operator picks" was not bound to what leaves. The call
   log now records *what was agreed* (`call_logs.agreed_follow_up` with
   `agreed_template_version_id` or `agreed_sequence_version_id`, a 0025 change), the
   permission carries the same binding, and the claim requires the fence's template version
   to be the permitted one. An `agreed_sequence` is bound to one immutable published
   version, to the one enrollment that runs it (`follow_up_permissions_one_enrollment`),
   and to an explicit step and time limit.
7. **`follow_up_permissions` is `deletion_removes`, and a firm deletion stops the
   enrollments before it clears `sequence_enrollments.permission_id`.** The permission's
   foreign keys onto `call_logs` and `mail_messages` are what make its evidence undeletable
   while a permission rests on it — so the deletion path removes the permissions before the
   correspondence, and the enrollment (which is *stopped*, not deleted) lets go of its
   pointer. The order matters (P1-3): a live `follow_up` enrollment may not have a null
   pointer, so the stop comes first, and the CHECK's one exemption is `ended_at IS NOT
   NULL`. `origin_kind` still says `follow_up`, so nothing can send on the cleared column.
   `packages/domain/test/retention/followUpDeletion.test.ts` covers an active follow-up
   and a completed one in the same commit.

## 8. What this does not do

* It does not lift the pause, and cannot.
* It creates no booking table and no Cal.com integration.
* It does not change what a `prospecting` or a legacy step may do, except to refuse more.
* It adds no partial unique index, so no production row makes the migration fail to apply.
