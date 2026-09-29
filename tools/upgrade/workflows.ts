import { randomUUID } from 'node:crypto';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { businessDateOf } from '@fss/domain/today/snapshots.ts';
import { buildTodaySnapshot, defaultTodaySources } from '@fss/domain/today/build.ts';
import { readTodayList } from '@fss/domain/today/dto.ts';
import { readFirmPage } from '@fss/domain/crm/firmPage.ts';
import { readPipelineBoardForActor } from '@fss/domain/crm/board.ts';
import { CHANNEL_ACTION_KINDS, composeEligibility } from '@fss/domain/sequences/eligibility.ts';
import { readEnrollment, nextUnfinishedExecution } from '@fss/domain/sequences/rows.ts';
import { listFencesToReconcile, listMailboxesToReconcile } from '@fss/domain/outbound/reconcile.ts';
import { claimJobs, completeJob, enqueueJob, writeProgress } from '@fss/domain/jobs/jobStore.ts';
import { recordFunnelFact } from '@fss/domain/funnel/facts.ts';
import { commitDeletion, previewDeletion } from '@fss/domain/retention/deletion.ts';
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
 */

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
        return `business date ${report.businessDate}, algorithm ${report.algorithmVersion}, written ${String(report.written)}, cancelled ${String(report.cancelled)}`;
      },
    },
    {
      name: 'today.read (admin)',
      run: async () => {
        const list = await readTodayList(admin, { now });
        return `${String(list.cards.length)} card(s) for ${list.snapshotDate}`;
      },
    },
    {
      name: 'today.read (salesperson)',
      run: async () => {
        const list = await readTodayList(salesperson, { now });
        return `${String(list.cards.length)} card(s) for ${list.snapshotDate}`;
      },
    },
    {
      name: 'crm.firmPage',
      run: async () => {
        const page = await readFirmPage(admin, { firmId: handles.primaryFirmId });
        if (!page.ok) throw new Error(`refused: ${page.reason}`);
        return `visibility ${page.value.visibility}, firm ${page.value.read.firm.name}`;
      },
    },
    {
      name: 'crm.pipeline',
      run: async () => {
        const board = await readPipelineBoardForActor(admin);
        const placed = board.columns.reduce((total, column) => total + column.firms.length, 0);
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
        if (candidate === undefined) return 'skipped: no active enrollment has an unfinished step';
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
        return outcome.ok ? 'eligible' : `held: ${outcome.reasonCode}${outcome.detail === undefined ? '' : ` (${outcome.detail})`}`;
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
        return `${String(fences.length)} fence(s) and ${String(mailboxes.length)} mailbox(es) owed reconciliation; no provider call made`;
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
        return `audience ${dashboard.audience}, ${String(dashboard.firmsInScope)} firm(s) in scope, ${String(dashboard.messages.incomingMatched)} matched message(s), ${String(dashboard.holds.open)} open hold(s)`;
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
