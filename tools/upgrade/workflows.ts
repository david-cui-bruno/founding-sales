import { randomUUID } from 'node:crypto';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { businessDateOf } from '@fss/domain/today/snapshots.ts';
import { buildTodaySnapshot, defaultTodaySources } from '@fss/domain/today/build.ts';
import { readTodayFirm, readTodayList } from '@fss/domain/today/dto.ts';
import { readFirmPage } from '@fss/domain/crm/firmPage.ts';
import { readPipelineBoardForActor } from '@fss/domain/crm/board.ts';
import { CHANNEL_ACTION_KINDS, composeEligibility } from '@fss/domain/sequences/eligibility.ts';
import { readEnrollment, nextUnfinishedExecution } from '@fss/domain/sequences/rows.ts';
import { listFencesToReconcile, listMailboxesToReconcile } from '@fss/domain/outbound/reconcile.ts';
import { claimJobs, completeJob, enqueueJob, writeProgress } from '@fss/domain/jobs/jobStore.ts';
import { recordFunnelFact } from '@fss/domain/funnel/facts.ts';
import { commitDeletion, previewDeletion } from '@fss/domain/retention/deletion.ts';
import { isSuppressed, listEffectiveSuppressions } from '@fss/domain/suppression/effective.ts';
import { recordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
import { readDashboard } from '@fss/domain/dashboard/aggregate.ts';
import { liveDashboardSources } from '@fss/domain/dashboard/sendingSource.ts';
import type { FixtureHandles } from './fixture.ts';

/**
 * The workflows, run on the upgraded database as the application's own role.
 *
 * "The migration applied" is not the question a release asks; "does the product still
 * work on the data that was already there" is. Each of these is a call into the domain
 * on the fixture the upgrade was performed on — no HTTP, no provider, no clock of this
 * process's own: every instant comes from the database.
 *
 * Every one runs as `app_runtime`, so a migration that added a table and forgot its
 * grant fails here with `42501` rather than in production at nine in the morning.
 *
 * ## What this does *not* cover, said plainly
 *
 * These are domain calls as the runtime role. They construct the actor context
 * directly, so the API's sign-in, its command receipts and its HTTP routes are **not**
 * exercised, and neither is the worker's job runner around a real handler (GPT-6
 * review, P1-3). `docs/greenfield/migrations.md` says so in the same words. What the
 * three tables `sessions`, `oidc_authorization_requests` and `command_receipts` hold
 * is therefore outside this test, which is also why the fixture is excused for leaving
 * them empty.
 *
 * ## Every case asserts something specific
 *
 * A workflow that "did not throw" is not evidence, and neither is a workflow that ran
 * over an empty set. Today has to produce at least `MINIMUM_TODAY_CARDS` cards and two
 * named firms have to come back in the *exact* lanes the fixture's own data forces;
 * eligibility has to reach a named decision and a `skipped` is a failure; the
 * reconciliation sweep has to hand back the id of the fence the fixture left owed one,
 * and zero fences is a failure rather than a pass; `effective_suppressions` has to
 * carry the handle the fixture opted out and not the one it did not. The numbers and
 * names below are properties of the fixture, so a fixture that quietly stopped loading
 * a part fails here as well as in step 3.
 */

/**
 * The fixture enrols twenty firms and opens opportunities across the stages, so a
 * Today build that produced fewer cards than this has lost work rather than found
 * none. It is a floor, not an expectation: the exact number is a function of the
 * fixture and of the day of the week the test runs on.
 */
export const MINIMUM_TODAY_CARDS = 5;

/**
 * The decision the fixture's active enrolment must reach.
 *
 * **`cold_legacy` since migration 0025**, and this constant moving is the single most
 * informative line of that migration's upgrade evidence. The fixture is written by the
 * *deployed* checkout's own code, which has no `origin_kind` column to write, so every
 * enrollment it creates takes 0025's DEFAULT — which is the backfill, and which is
 * David's decision of 29 September 2026 that every enrollment existing before evidenced
 * follow-up permissions is excluded from automatic sending for ever. The step is
 * refused by `followUpPermissionSource`, the first source after suppression, before the
 * workspace pause this case used to observe (`scoped_pause`) is ever reached.
 *
 * So the change of value here is the property under test, seen from the outside: run
 * the deployed code's data through the new gate and nothing legacy can send. A future
 * lane that wants this case to observe the pause again has to give the fixture an
 * enrollment with a real origin, which the base checkout cannot write — and that is the
 * honest state of affairs rather than a limitation of this file.
 *
 * Naming the code rather than accepting "some refusal" is the point (GPT-6 review,
 * P1-3): an eligibility gate that passed on any answer would pass on the wrong one. If
 * a later change to the fixture makes a different source win, this fails loudly and
 * somebody decides which decision the fixture is supposed to produce, rather than the
 * assertion quietly becoming vacuous.
 *
 * **`scoped_pause` again since the deployed base is schema 25** (send-path v2, 25 → 26,
 * 30 September 2026). The paragraph above describes a base that predates 0025. A
 * schema-25 base *does* write an origin, so the legacy refusal no longer applies, and
 * the first source that refuses the candidate row is the workspace pause. The property
 * under test is unchanged: the upgrade must not change the gate's decision about this
 * row. A run from a base older than 25 would see `cold_legacy` here and fail loudly,
 * which is the intended reading of an unexpected base.
 *
 * **Which row that is, observed on the 25 → 26 run of slice S4 (30 September 2026).**
 * The candidate query below prefers the fixture's `activeEnrollmentId`, but that
 * enrollment (a `prospecting` one, written by `enrollContact`) has no `pending` or `held`
 * step left by the time this runs, so the query takes another active enrollment: a
 * **`follow_up`** one written by the base checkout's step-execution fixture, whose next
 * step is a pending e-mail. That is why send-path v2's cold-outreach rule does not move
 * this constant — a follow-up is not prospecting — while it does move
 * `EXPECTED_PROSPECTING_DECISION` below. If a later fixture makes a prospecting e-mail
 * step the candidate, this answer becomes `cold_outreach_mailbox_required` and fails
 * loudly, which is the intended reading.
 */
export const EXPECTED_ELIGIBILITY_DECISION = 'scoped_pause';

/**
 * The decision a *post-upgrade* prospecting enrollment must reach.
 *
 * The legacy enrollment above is refused for being legacy, which is the property 0025
 * adds and also the reason it can no longer show that the pause still holds. So the same
 * step writes one enrollment of its own with a real origin, `prospecting`, asks the gate
 * about it, and names the answer (P2-2 of the GPT-6 review of PR 332).
 *
 * **`cold_outreach_mailbox_required` since send-path v2, slice S4 (30 September 2026).**
 * Until then the answer was the workspace pause (`scoped_pause`). David, 30 September
 * 2026: "creating an enrollment must not enable cold Gmail outreach" — so
 * `coldOutreachTransportSource` now refuses a prospecting e-mail step before the holds
 * source, and the gate's decision about a prospecting row changes **on purpose**. That
 * change is exactly what this probe must witness: an upgrade to this code that still
 * answered `scoped_pause` here would mean a prospecting e-mail was one switch away from
 * leaving through Gmail. The pause itself is still witnessed, by the follow-up row
 * `EXPECTED_ELIGIBILITY_DECISION` asks about.
 *
 * **Assumption: the probe's step is an e-mail step.** It copies the first step of the
 * candidate's sequence version, which in the fixture is an e-mail (`fixture.ts`, ordinal
 * 1). A call-task first step would pass the cold-outreach source and reach
 * `scoped_pause` instead, and this would fail loudly.
 */
export const EXPECTED_PROSPECTING_DECISION = 'cold_outreach_mailbox_required';

/**
 * The lane the fixture's primary firm's card must be in.
 *
 * Only two Today sources have a table to read today — callbacks and new firms — and
 * the primary firm produces a task from both. `confirmReplyDisposition` in the
 * fixture's classification part commits a callback on that firm for 2026-09-23 10:00
 * in the workspace zone, an instant now permanently in the past, and every open
 * callback due on or before the date being built is enumerated. The firm's own
 * opportunity is still at the first pipeline stage, so the new-firm source produces a
 * task for it too — and lane precedence (8.2: replies, callbacks, due work, new
 * firms) makes the card's lane the callback's, because that is the highest-priority
 * unfinished item.
 *
 * Pinned rather than merely required to be non-empty (GPT-6 review of PR 314, P1-3):
 * a migration that mislaned every firm passed the old assertion. If a legitimate
 * change moves this, the failure names both lanes and somebody decides which is
 * right — that is the point, not a nuisance.
 */
export const EXPECTED_PRIMARY_FIRM_LANE = 'callback';

/**
 * The lane the fixture's opportunity-free firm's card must be in.
 *
 * The second pin, and the less accidental of the two: `newFirmLaneFirmId` is the one
 * firm the fixture leaves with no opportunity of any kind, no callback and no call
 * log, so the new-firm source is the only source in the build that can speak for it
 * at all. Its card therefore has exactly one task and the lane is forced. A
 * suppression would take it off the list entirely — the fixture's one suppression is
 * `handle`-scoped for that reason — so a card in any other lane means the lane rule
 * itself moved.
 */
export const EXPECTED_NEW_FIRM_LANE = 'new_firm';

/**
 * Read Today for one actor and assert it is about the fixture, not merely non-throwing.
 *
 * The salesperson's list is filtered to their own firms and the admin's is not, so the
 * two are asserted to the same floor and only the admin is required to see the
 * fixture's primary firm — a salesperson who is not that firm's assignee correctly
 * sees nothing of it.
 */
async function readTodayFor(
  context: RepositoryContext,
  who: 'admin' | 'salesperson',
  now: string,
  businessDate: string,
  handles: FixtureHandles,
): Promise<string> {
  const list = await readTodayList(context, { now });
  if (list.snapshotDate !== businessDate) {
    throw new Error(`read ${list.snapshotDate}, built ${businessDate}`);
  }
  if (list.cards.length < MINIMUM_TODAY_CARDS) {
    throw new Error(`${String(list.cards.length)} card(s); at least ${String(MINIMUM_TODAY_CARDS)} were built`);
  }
  if (list.businessTimeZone.trim().length === 0) throw new Error('the list carries no business time zone');
  const card = list.cards.find(candidate => candidate.firmId === handles.primaryFirmId);
  if (who !== 'admin') {
    // A salesperson's list is filtered to their own firms, so the fixture's firm may
    // legitimately be absent. What is asserted of them is the floor and the date.
    return `${String(list.cards.length)} card(s) for ${list.snapshotDate}; the fixture firm is ${card === undefined ? 'not visible to this salesperson' : 'visible'}`;
  }
  if (card === undefined) throw new Error("the admin's list does not carry the fixture's primary firm");
  if (card.firmName.trim().length === 0) throw new Error("the fixture firm's card carries no name");
  if (card.lane !== EXPECTED_PRIMARY_FIRM_LANE) {
    throw new Error(`the fixture firm's card is in lane ${card.lane}, and the fixture puts it in ${EXPECTED_PRIMARY_FIRM_LANE}`);
  }
  if (card.dueAt.trim().length === 0) throw new Error("the fixture firm's card carries no due instant");
  // The expanded card is the second read, and the one that carries the tasks the lane
  // is a summary of. A card with a lane and no task behind it is a card about nothing.
  const page = await readTodayFirm(context, { firmId: handles.primaryFirmId, now });
  if (page === null) throw new Error("the fixture firm's expanded card is not visible to the admin");
  if (page.snapshotDate !== businessDate) throw new Error(`the expanded card is for ${page.snapshotDate}`);
  if (page.tasks.length === 0) throw new Error("the fixture firm's card carries no task");
  const lanes = [...new Set(page.tasks.map(task => task.lane))].sort();
  // The second pinned lane. A firm with nothing but its own existence to recommend it
  // can only be in lane 4, so this is the assertion that a mislaning migration cannot
  // satisfy by accident.
  const newFirmId = handles.newFirmLaneFirmId;
  if (newFirmId === null) throw new Error('the fixture named no opportunity-free firm, so no lane can be pinned on one');
  const newFirmCard = list.cards.find(candidate => candidate.firmId === newFirmId);
  if (newFirmCard === undefined) {
    throw new Error("the admin's list does not carry the fixture's opportunity-free firm, which the new-firm lane always produces");
  }
  if (newFirmCard.lane !== EXPECTED_NEW_FIRM_LANE) {
    throw new Error(`the opportunity-free firm's card is in lane ${newFirmCard.lane}, and only ${EXPECTED_NEW_FIRM_LANE} can produce it`);
  }
  return `${String(list.cards.length)} card(s) for ${list.snapshotDate}; the fixture firm is in lane ${card.lane} with ${String(page.tasks.length)} task(s) in lane(s) ${lanes.join(', ')}; the opportunity-free firm is in lane ${newFirmCard.lane}`;
}

export interface WorkflowOutcome {
  readonly name: string;
  readonly ok: boolean;
  /** What the call decided, in one line. The evidence, not just a tick. */
  readonly detail: string;
  readonly ms: number;
}

/**
 * The instant every workflow below is given. It is the database's, formatted by the
 * database: nothing here reads the host clock, and nothing here parses a timestamp
 * whose text shape depends on the server's `DateStyle`.
 */
async function databaseNow(session: SessionQueryable): Promise<string> {
  const { rows } = await session.query<{ now: string }>(
    `SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`,
  );
  const now = rows[0]?.now;
  if (now === undefined) throw new Error('the database did not answer now()');
  return now;
}

type Step = { readonly name: string; run(): Promise<string> };

/** Run every workflow, never stopping early: one failure should not hide the next. */
export async function runWorkflows(
  session: SessionQueryable,
  handles: FixtureHandles,
): Promise<readonly WorkflowOutcome[]> {
  const now = await databaseNow(session);
  const adminScope = workspaceScope(handles.workspaceId, {
    kind: 'user',
    userId: handles.adminUserId,
    role: 'admin',
  });
  const salespersonScope = workspaceScope(handles.workspaceId, {
    kind: 'user',
    userId: handles.salespersonUserId,
    role: 'salesperson',
  });
  const admin = repositoryContext(adminScope, session);
  const salesperson = repositoryContext(salespersonScope, session);
  const businessDate = await businessDateOf(admin, now);

  const steps: readonly Step[] = [
    {
      name: 'today.build',
      run: async () => {
        const report = await buildTodaySnapshot(admin, { businessDate, now, sources: defaultTodaySources() });
        if (report.businessDate !== businessDate) {
          throw new Error(`built ${report.businessDate}, asked for ${businessDate}`);
        }
        if (report.written < MINIMUM_TODAY_CARDS) {
          throw new Error(
            `wrote ${String(report.written)} item(s); the fixture's firms should produce at least ${String(MINIMUM_TODAY_CARDS)}`,
          );
        }
        if (report.algorithmVersion.trim().length === 0) throw new Error('the build reported no algorithm version');
        return `business date ${report.businessDate}, algorithm ${report.algorithmVersion}, written ${String(report.written)}, cancelled ${String(report.cancelled)}`;
      },
    },
    {
      name: 'today.read (admin)',
      run: async () => await readTodayFor(admin, 'admin', now, businessDate, handles),
    },
    {
      name: 'today.read (salesperson)',
      run: async () => await readTodayFor(salesperson, 'salesperson', now, businessDate, handles),
    },
    {
      name: 'crm.firmPage',
      run: async () => {
        const page = await readFirmPage(admin, { firmId: handles.primaryFirmId });
        if (!page.ok) throw new Error(`refused: ${page.reason}`);
        if (page.value.visibility !== 'assigned_or_admin') {
          throw new Error(`an admin reads a firm at assigned_or_admin, not ${page.value.visibility}`);
        }
        const firm = page.value.read.firm;
        if (firm.id !== handles.primaryFirmId) throw new Error('the page is about another firm');
        if (firm.name.trim().length === 0) throw new Error('the firm has no name');
        if (firm.timeZone === null) throw new Error('the firm has no resolved time zone, so nothing can be scheduled for it');
        if (page.value.stageHistory.length === 0) throw new Error('the firm has no stage history');
        return `visibility ${page.value.visibility}, firm ${firm.name}, zone ${firm.timeZone}, ${String(page.value.stageHistory.length)} stage event(s)`;
      },
    },
    {
      name: 'crm.pipeline',
      run: async () => {
        const board = await readPipelineBoardForActor(admin);
        const placed = board.columns.reduce((total, column) => total + column.firms.length, 0);
        if (board.columns.length < 7) throw new Error(`${String(board.columns.length)} stage column(s); 0004 seeds seven`);
        if (placed === 0) throw new Error('no firm is placed on the board, though the fixture opens opportunities');
        if (board.opportunityIdByFirmId[handles.primaryFirmId] === undefined) {
          throw new Error('the fixture firm has no opportunity an admin may change');
        }
        return `${String(board.columns.length)} column(s), ${String(placed)} placed firm(s), ${String(board.unplacedFirms.length)} unplaced`;
      },
    },
    {
      name: 'sequences.eligibility',
      run: async () => {
        // Any active enrollment with a step still to do, the fixture's own preferred.
        // A step with nothing pending would make this case assert nothing at all, so it
        // is looked for across the fixture rather than only in the bootstrapped
        // workspace — the shared two-workspace fixture has enrolments too.
        const candidates = await session.query<{ id: string; workspace_id: string }>(
          `SELECT e.id, e.workspace_id
             FROM sequence_enrollments e
             JOIN step_executions s ON s.enrollment_id = e.id AND s.state IN ('pending', 'held')
            WHERE e.state = 'active'
            ORDER BY (e.workspace_id = $1) DESC, (e.id = $2) DESC
            LIMIT 1`,
          [handles.workspaceId, handles.activeEnrollmentId],
        );
        const candidate = candidates.rows[0];
        if (candidate === undefined) {
          // A skip is a failure here (P1-3): an eligibility gate with nothing to decide
          // about asserts nothing, and the fixture is supposed to leave it work.
          throw new Error('no active enrolment has an unfinished step; the fixture should leave one');
        }
        // The scope the worker itself uses for a sequence job (`scopeForJob`): the
        // eligibility gate is evaluated by the worker, never by a person, and an
        // assignment source asked under the wrong actor would answer a different
        // question.
        const worker = repositoryContext(
          workspaceScope(candidate.workspace_id, { kind: 'system', component: 'worker' }),
          session,
        );
        const enrollment = await readEnrollment(worker, { enrollmentId: candidate.id });
        if (enrollment === null) throw new Error('the active enrollment disappeared');
        const execution = await nextUnfinishedExecution(worker, candidate.id);
        if (execution === null) throw new Error('the step that was there a statement ago is gone');
        // The decision itself is not asserted: what this step proves is that the gate
        // still evaluates on upgraded data rather than throwing. A refusal is a
        // decision, and it is printed.
        const outcome = await composeEligibility().evaluate(worker, {
          execution,
          opportunityId: enrollment.opportunityId,
          firmId: enrollment.firmId,
          contactId: enrollment.contactId,
          ownerUserId: enrollment.assignedUserId,
          channel: execution.channel,
          actionKind: CHANNEL_ACTION_KINDS[execution.channel],
          now,
        });
        // The expected decision, named. The fixture's active enrolment was written by
        // the deployed checkout, which has no `origin_kind` to write, so migration
        // 0025's DEFAULT makes it `cold_legacy` and `followUpPermissionSource` — the
        // first source after suppression — refuses it. A different answer means the gate
        // now decides something else about the same rows, which is exactly what an
        // upgrade could break.
        if (outcome.ok) {
          throw new Error(`expected the hold ${EXPECTED_ELIGIBILITY_DECISION}, and the step was eligible`);
        }
        if (outcome.reasonCode !== EXPECTED_ELIGIBILITY_DECISION) {
          throw new Error(
            `expected the hold ${EXPECTED_ELIGIBILITY_DECISION}, got ${outcome.reasonCode}${outcome.detail === undefined ? '' : ` (${outcome.detail})`}`,
          );
        }
        // And a row with a real origin written after the upgrade (P2-2 of the GPT-6 review
        // of PR 332). Since send-path v2 (slice S4) its answer is the cold-outreach rule,
        // not the pause: see `EXPECTED_PROSPECTING_DECISION`. `cold_legacy` is refused before every other
        // source, so the legacy enrollment above no longer proves that the workspace
        // switch still holds an otherwise-sendable step. This fixture is written *after*
        // the upgrade, by the new code, with an origin the deployed checkout could not
        // write: the same firm, the same person, an enrollment of its own that is
        // `prospecting` rather than legacy, and a step that is due.
        // Its own person, so the one-live-enrollment-per-contact rule is not the thing
        // this probe runs into, and its own usable address, because a step with no route
        // is refused for that instead.
        const probeContact = await session.query<{ id: string }>(
          `WITH person AS (
             INSERT INTO contacts (workspace_id, firm_id, full_name)
             SELECT e.workspace_id, e.firm_id, 'Upgrade Probe'
               FROM sequence_enrollments e WHERE e.workspace_id = $1 AND e.id = $2
             RETURNING id, workspace_id, firm_id
           ), route AS (
             INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                          association_confidence, technical_validation, eligibility,
                                          eligibility_policy_version)
             SELECT p.workspace_id, p.firm_id, p.id, 'upgrade.probe@example.test', 'research_provider', now(),
                    0.900, 'passed', 'usable', 'route-policy.1'
               FROM person p
             RETURNING contact_id
           )
           SELECT id FROM person`,
          [candidate.workspace_id, candidate.id],
        );
        const probeContactId = probeContact.rows[0]?.id;
        if (probeContactId === undefined) throw new Error('the post-upgrade probe contact was not written');
        const probe = await session.query<{ id: string }>(
          `WITH enrolled AS (
             INSERT INTO sequence_enrollments
               (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
                started_at, firm_time_zone, holiday_calendar_version, origin_kind)
             SELECT e.workspace_id, e.sequence_version_id, e.opportunity_id, e.firm_id, $3::uuid,
                    e.assigned_user_id, now(), e.firm_time_zone, e.holiday_calendar_version, 'prospecting'
               FROM sequence_enrollments e
              WHERE e.workspace_id = $1 AND e.id = $2
              RETURNING id, workspace_id, firm_id, contact_id, sequence_version_id
           )
           INSERT INTO step_executions
             (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
              due_at, not_before, original_due_at, source_zone, rule_version)
           SELECT n.workspace_id, n.id, s.id, n.firm_id, n.contact_id, s.channel, s.ordinal,
                  now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour',
                  'America/New_York', 'elapsed.1'
             FROM enrolled n
             JOIN sequence_steps s
               ON s.workspace_id = n.workspace_id AND s.sequence_version_id = n.sequence_version_id
            ORDER BY s.ordinal
            LIMIT 1
           RETURNING enrollment_id AS id`,
          [candidate.workspace_id, candidate.id, probeContactId],
        );
        const probeEnrollmentId = probe.rows[0]?.id;
        if (probeEnrollmentId === undefined) throw new Error('the post-upgrade probe enrolment was not written');
        const probeEnrollment = await readEnrollment(worker, { enrollmentId: probeEnrollmentId });
        const probeExecution = await nextUnfinishedExecution(worker, probeEnrollmentId);
        if (probeEnrollment === null || probeExecution === null) {
          throw new Error('the post-upgrade probe enrolment has no step');
        }
        const probeOutcome = await composeEligibility().evaluate(worker, {
          execution: probeExecution,
          opportunityId: probeEnrollment.opportunityId,
          firmId: probeEnrollment.firmId,
          contactId: probeEnrollment.contactId,
          ownerUserId: probeEnrollment.assignedUserId,
          channel: probeExecution.channel,
          actionKind: CHANNEL_ACTION_KINDS[probeExecution.channel],
          now,
        });
        if (probeOutcome.ok) {
          throw new Error(`expected ${EXPECTED_PROSPECTING_DECISION} on the post-upgrade probe, and it was eligible`);
        }
        if (probeOutcome.reasonCode !== EXPECTED_PROSPECTING_DECISION) {
          throw new Error(
            `expected ${EXPECTED_PROSPECTING_DECISION} on the post-upgrade probe, got ${probeOutcome.reasonCode}`,
          );
        }
        // The probe is a fixture, not a row the upgraded deployment should keep.
        await session.query(
          'DELETE FROM step_executions WHERE workspace_id = $1 AND enrollment_id = $2',
          [candidate.workspace_id, probeEnrollmentId],
        );
        await session.query('DELETE FROM sequence_enrollments WHERE workspace_id = $1 AND id = $2', [
          candidate.workspace_id,
          probeEnrollmentId,
        ]);
        await session.query('DELETE FROM email_addresses WHERE workspace_id = $1 AND contact_id = $2', [
          candidate.workspace_id,
          probeContactId,
        ]);
        await session.query('DELETE FROM contacts WHERE workspace_id = $1 AND id = $2', [
          candidate.workspace_id,
          probeContactId,
        ]);

        return `held: ${outcome.reasonCode}${outcome.detail === undefined ? '' : ` (${outcome.detail})`}; post-upgrade prospecting probe: ${probeOutcome.reasonCode}`;
      },
    },
    {
      name: 'mail.reconcile (no provider)',
      run: async () => {
        // The provider-free half of the pass. `reconcileMailbox` takes a Gmail client,
        // an OAuth configuration and an envelope cipher this process deliberately has
        // none of; what can be run without them is the enumeration that decides what is
        // owed, which is the part an upgrade can break.
        const fences = await listFencesToReconcile(session, { limit: 50 });
        const mailboxes = await listMailboxesToReconcile(session);
        // An empty set is not a pass (GPT-6 review of PR 314, P1-3). Until the fixture
        // seeded one, this workflow enumerated nothing and reported success, which it
        // would have done just as happily on a schema whose `outbound_messages` the
        // migration had broken.
        if (fences.length === 0) {
          throw new Error('no fence is owed reconciliation; the fixture seeded none, so the enumeration proves nothing');
        }
        if (mailboxes.length === 0) {
          throw new Error('no mailbox is owed reconciliation; the fixture seeded none, so the enumeration proves nothing');
        }
        const owed = handles.reconcilingFenceId;
        if (owed === null) {
          throw new Error("the fixture's reconciling fence part left no fence id, so there is nothing specific to require back");
        }
        const found = fences.find(fence => fence.outboundMessageId === owed);
        if (found === undefined) {
          throw new Error(`the enumeration did not return ${owed}, the fence the fixture left in reconciling with no attempt yet`);
        }
        // And the mailbox sweep has to name that fence's mailbox: the two enumerations
        // are one pass in the worker, and a schema that broke the join in the second
        // would leave the fence enumerated and never visited.
        if (!mailboxes.some(mailbox => mailbox.mailboxId === found.mailboxId)) {
          throw new Error(`the mailbox sweep does not name ${found.mailboxId}, which owns the fence owed an observation`);
        }
        return `${String(fences.length)} fence(s) and ${String(mailboxes.length)} mailbox(es) owed reconciliation, including the fixture's fence ${owed} on mailbox ${found.mailboxId}; no provider call made`;
      },
    },
    {
      name: 'jobs.claim → progress → complete',
      run: async () => {
        const key = `upgrade-test:${randomUUID()}`;
        const enqueued = await enqueueJob(session, {
          workspaceId: handles.workspaceId,
          kind: 'canary.ping',
          idempotencyKey: key,
          payload: { source: 'upgrade_test' },
        });
        const claimed = await claimJobs(session, {
          owner: `upgrade-test:${randomUUID()}`,
          kinds: ['canary.ping'],
          limit: 5,
          leaseSeconds: 60,
        });
        const job = claimed.find(candidate => candidate.id === enqueued.jobId);
        if (job === undefined) throw new Error('the job just enqueued was not claimed');
        const progress = await writeProgress(session, {
          jobId: job.id,
          workspaceId: job.workspaceId,
          fencingToken: job.fencingToken,
          progress: { cursor: 1 },
        });
        if (progress.outcome !== 'written') throw new Error(`progress: ${progress.outcome}`);
        // The fencing token is the whole point: a stale token must not be able to
        // complete the job the live claim holds.
        const stale = await writeProgress(session, {
          jobId: job.id,
          workspaceId: job.workspaceId,
          fencingToken: String(Number(job.fencingToken) - 1),
          progress: { cursor: 99 },
        });
        if (stale.outcome !== 'lease_lost') throw new Error(`a stale fencing token was accepted: ${stale.outcome}`);
        const completed = await completeJob(session, job);
        if (completed !== 'completed') throw new Error(`complete: ${completed}`);
        return `token ${job.fencingToken} completed; token ${String(Number(job.fencingToken) - 1)} refused as lease_lost`;
      },
    },
    {
      name: 'funnel.fact',
      run: async () => {
        const outcome = await recordFunnelFact(admin, {
          kind: 'demo.started',
          source: 'demo',
          dedupeKey: `upgrade-test-${randomUUID()}`,
          firmId: handles.primaryFirmId,
          detail: { step: 'upgrade_test' },
        });
        if (!outcome.recorded) throw new Error(`refused: ${outcome.reason}`);
        return `fact ${outcome.id} recorded`;
      },
    },
    {
      name: 'retention.deleteContact',
      run: async () => {
        const journal = recordingSuppressionJournal();
        const preview = await previewDeletion(admin, {
          targetKind: 'contact',
          firmId: handles.deletableFirmId,
          contactId: handles.deletableContactId,
        });
        if (!preview.ok) throw new Error(`preview refused: ${preview.reason}`);
        const committed = await commitDeletion(admin, {
          requestId: preview.value.requestId,
          previewHash: preview.value.previewHash,
          commandId: randomUUID(),
          journal,
        });
        if (!committed.ok) throw new Error(`commit refused: ${committed.reason}`);
        const removed = Object.entries(committed.value.removed).filter(([, count]) => count > 0);
        const redacted = Object.entries(committed.value.redacted).filter(([, count]) => count > 0);
        if (removed.length === 0 && redacted.length === 0) throw new Error('the deletion removed and redacted nothing');
        if (committed.value.tombstoneEventIds.length === 0) {
          throw new Error('the deletion left no suppression tombstone, which is what stops the handle being contacted again');
        }
        return `removed ${removed.map(([table, count]) => `${table}=${String(count)}`).join(' ') || 'nothing'}; redacted ${redacted.map(([table, count]) => `${table}=${String(count)}`).join(' ') || 'nothing'}; ${String(committed.value.tombstoneEventIds.length)} tombstone(s)`;
      },
    },
    {
      name: 'dashboard.read',
      run: async () => {
        const to = new Date(now);
        const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
        // The live sources, not the `unavailable` default: a dashboard that reports
        // four blocks as unavailable would pass this step on a database whose sending,
        // enrolment, classifier and funnel reads the migration had broken.
        const dashboard = await readDashboard(admin, {
          window: { from: from.toISOString(), to: to.toISOString() },
          sources: liveDashboardSources(),
        });
        if (dashboard.audience !== 'workspace') throw new Error(`an admin's dashboard is the workspace, not ${dashboard.audience}`);
        if (dashboard.firmsInScope < 20) {
          throw new Error(`${String(dashboard.firmsInScope)} firm(s) in scope; the fixture creates at least twenty`);
        }
        if (dashboard.sending.available !== true) throw new Error('the sending source reported unavailable');
        if (dashboard.enrollments.available !== true) throw new Error('the enrolment source reported unavailable');
        return `audience ${dashboard.audience}, ${String(dashboard.firmsInScope)} firm(s) in scope, ${String(dashboard.messages.incomingMatched)} matched message(s), ${String(dashboard.holds.open)} open hold(s)`;
      },
    },
    {
      name: 'suppression.effective (the view)',
      run: async () => {
        // The one read of `effective_suppressions`, the view 10.2 makes authoritative
        // for email and dialing (GPT-6 review of PR 314, P0-4). A view carries no rows
        // of its own, so neither the content hash nor the table-shape comparison in
        // step 4 can see one being replaced; only asking it a question can. Until this
        // existed, a migration that replaced the view with one returning nothing
        // passed the whole run.
        const suppressed = handles.suppressedHandleKey;
        if (suppressed === null) {
          throw new Error('the fixture seeded no suppression, so the view has nothing it must answer about');
        }
        // On the specific row, not on a count: a view returning somebody else's
        // suppression is as wrong as one returning nothing.
        const effective = await isSuppressed(admin, { scope: 'handle', canonicalKey: suppressed });
        if (effective === null) {
          throw new Error(`effective_suppressions does not carry ${suppressed}, the handle the fixture opted out before the upgrade`);
        }
        if (effective.canonicalKey !== suppressed) {
          throw new Error(`the view answered about ${effective.canonicalKey}, not ${suppressed}`);
        }
        if (effective.source !== 'prospect_opt_out') {
          throw new Error(`the opted-out handle is recorded as ${effective.source}, and the fixture wrote prospect_opt_out`);
        }
        if (!effective.canonicalizerVersionSupported) {
          throw new Error(`the stored canonicaliser version ${effective.canonicalizerVersion} is not one this build understands`);
        }
        // The set read as well as the point read: they are different statements over
        // the same view and a migration can break one without the other.
        const listed = await listEffectiveSuppressions(admin, { scope: 'handle', limit: 200 });
        if (!listed.some(entry => entry.canonicalKey === suppressed)) {
          throw new Error(`the listing of ${String(listed.length)} effective handle suppression(s) does not include ${suppressed}`);
        }
        // The negative, which is cheap and deterministic here: the primary contact's
        // address was never suppressed by anything the fixture or the steps above did,
        // so a view that returned it would be over-suppressing rather than under-.
        const clean = handles.unsuppressedHandleKey;
        if (clean === null) throw new Error('the fixture named no unsuppressed handle, so the negative cannot be asserted');
        const wrongly = await isSuppressed(admin, { scope: 'handle', canonicalKey: clean });
        if (wrongly !== null) {
          throw new Error(`${clean} reads as suppressed by ${wrongly.source}, and nothing ever suppressed it`);
        }
        return `${suppressed} is suppressed (${effective.source}, canonicaliser ${effective.canonicalizerVersion}) among ${String(listed.length)} effective handle suppression(s); ${clean} is not`;
      },
    },
  ];

  const outcomes: WorkflowOutcome[] = [];
  for (const step of steps) {
    const started = process.hrtime.bigint();
    try {
      const detail = await step.run();
      outcomes.push({ name: step.name, ok: true, detail, ms: elapsed(started) });
    } catch (error) {
      outcomes.push({
        name: step.name,
        ok: false,
        detail: error instanceof Error ? `${error.name}: ${error.message}` : 'failed',
        ms: elapsed(started),
      });
    }
  }
  return outcomes;
}

function elapsed(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1e6;
}
