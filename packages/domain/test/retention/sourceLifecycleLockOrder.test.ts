import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction, type QueryResultRowLike, type SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { commitDeletion, previewDeletion, REDACTED_NAME } from '../../retention/deletion.ts';
import { runRetentionBatch } from '../../retention/runs.ts';
import { saveCandidate } from '../../sourcing/candidates.ts';
import { saveManualProspectActivity } from '../../sourcing/manualProspectActivity.ts';
import { MANUAL_SOURCE_LOSS_ACTION, rememberExpiredManualSources } from '../../sourcing/manualProspectSourceLoss.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { manualOrdinaryFixture } from '../sourcing/support/manualProspectFixture.ts';

let database: TestDatabase;
let seeded: TwoWorkspaces;
let runtime: SessionQueryable;
const context = (session: SessionQueryable, worker = false) => repositoryContext(
  workspaceScope(seeded.alpha.workspaceId, worker
    ? { kind: 'system', component: 'worker' }
    : { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
  session,
);

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  runtime = await database.appRuntimeSession();
});
afterAll(async () => { await database?.drop(); });

async function fixture(expiring: boolean) {
  const workspace = seeded.alpha.workspaceId;
  const firms = (await runtime.query<{ id: string }>(
    `INSERT INTO firms(workspace_id,name,assigned_user_id)
     VALUES($1,'Deletion lifecycle fixture',$2),($1,'Independent source fixture',$2) RETURNING id`,
    [workspace, seeded.alpha.admin.userId],
  )).rows;
  const deletionFirm = firms[0]!.id, sourceFirm = firms[1]!.id;
  const candidate = manualOrdinaryFixture(expiring ? 99101 : 99102);
  const saved = await withTransaction(runtime, () => saveCandidate(context(runtime), candidate));
  if (!saved.ok) throw new Error(saved.reason);
  const sources = (await runtime.query<{ id: string; firm_id: string }>(
    `INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at)
     VALUES($1,$2,'website','https://deletion.example.test/'||$2::uuid::text,$4,true,NULL),
           ($1,$3,'website',$5,$4,true,clock_timestamp()+CASE WHEN $6 THEN interval '2 seconds' ELSE interval '1 day' END)
     RETURNING id,firm_id`,
    [workspace, deletionFirm, sourceFirm, 'a'.repeat(64), candidate.sourceUrl, expiring],
  )).rows;
  const attemptId = randomUUID();
  const activity = await withTransaction(runtime, () => saveManualProspectActivity(context(runtime), {
    operation: 'create', candidateId: saved.value.id, expectedCandidateRevision: 1, attemptId,
    performedByUser: true, channel: 'manual_phone', occurrence: { kind: 'unknown' },
    result: 'unknown', note: 'Synthetic retained private source note', callback: null,
  }, async () => true));
  expect(activity).toMatchObject({ ok: true });
  expect((await runtime.query('SELECT content IS NOT NULL AS retained FROM sourcing_manual_prospect_attempts WHERE id=$1', [attemptId])).rows)
    .toEqual([{ retained: true }]);
  const preview = await withTransaction(runtime, () => previewDeletion(context(runtime), { targetKind: 'firm', firmId: deletionFirm }));
  if (!preview.ok) throw new Error(preview.reason);
  // Expiry is real database wall time. No update trigger pre-clears the note, and
  // the full retention owner must actually remove its original and derived copy.
  if (expiring) await runtime.query(
    `SELECT pg_sleep(GREATEST(0,extract(epoch FROM retention_expires_at-clock_timestamp()))+0.02)
       FROM evidence_items WHERE workspace_id=$1 AND firm_id=$2`, [workspace, sourceFirm],
  );
  return {
    deletionFirm, sourceFirm, sources, attemptId, sourceUrl: candidate.sourceUrl,
    requestId: preview.value.requestId, previewHash: preview.value.previewHash,
  };
}

/** Pause only after commitDeletion has acquired its real lifecycle lock. All SQL,
 * application role privileges and transaction/lock behavior remain unchanged. */
function pausedDeletion(raw: SessionQueryable) {
  let paused = false;
  let resume = () => { /* Replaced synchronously by the Promise constructor. */ };
  const released = new Promise<void>(resolve => { resume = resolve; });
  const session: SessionQueryable = {
    query: async <Row extends QueryResultRowLike>(sql: string, values?: readonly unknown[]) => {
      const result = await raw.query<Row>(sql, values);
      if (!paused && sql.includes('pg_advisory_xact_lock(') && values?.[0] === `sourcing-discovery-review:${seeded.alpha.workspaceId}`) {
        paused = true;
        await released;
      }
      return result;
    },
  };
  return { session, isPaused: () => paused, resume: () => { resume(); } };
}

function settled<T>(promise: Promise<T>) {
  return promise.then(
    value => ({ value, error: null }),
    (error: unknown) => ({ value: null, error: error instanceof Error && 'code' in error ? String(error.code) : String(error) }),
  );
}

it.each(['research_evidence', 'standalone_source_loss'] as const)('%s waits before the gate while commitDeletion owns source lifecycle; both commit without 40P01', async kind => {
  const f = await fixture(kind === 'research_evidence');
  const deletion = pausedDeletion(await database.appRuntimeSession());
  const cleanup = await database.appRuntimeSession();
  const deletionPid = (await deletion.session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const cleanupPid = (await cleanup.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const deleting = settled(withTransaction(deletion.session, () => commitDeletion(context(deletion.session), {
    requestId: f.requestId, previewHash: f.previewHash, commandId: randomUUID(), journal: recordingSuppressionJournal(),
  })));
  let gateHeldBeforeLifecycle: boolean | undefined;
  let cleaning: ReturnType<typeof settled<unknown>> | undefined;
  let deletionOutcome: Awaited<typeof deleting> | undefined;
  let cleanupOutcome: Awaited<NonNullable<typeof cleaning>> | undefined;
  try {
    await expect.poll(deletion.isPaused).toBe(true);
    cleaning = settled(withTransaction(cleanup, async () => {
      if (kind === 'research_evidence') return await runRetentionBatch(context(cleanup, true), { dataKind: 'research_evidence', period: '2026-10-28', limit: 50 });
      await rememberExpiredManualSources(context(cleanup, true), [f.sourceUrl]);
      return { sourceLossRecorded: true };
    }));
    await expect.poll(async () => (await database.session.query<{ waiting: boolean }>(
      'SELECT $2::integer=ANY(pg_blocking_pids($1)) AS waiting', [cleanupPid, deletionPid],
    )).rows[0]?.waiting).toBe(true);
    gateHeldBeforeLifecycle = (await database.session.query<{ held: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted
          AND classid::bigint=((hashtextextended($2,0)>>32)&4294967295)
          AND objid::bigint=(hashtextextended($2,0)&4294967295)) AS held`,
      [cleanupPid, `fss.send-gate:${seeded.alpha.workspaceId}`],
    )).rows[0]!.held;
  } finally {
    deletion.resume();
    [deletionOutcome, cleanupOutcome] = await Promise.all([deleting, cleaning]);
  }
  // Before the repair, the real cleanup holds the gate here and one real
  // transaction aborts with 40P01 when deletion continues lifecycle -> Ask -> gate.
  expect([deletionOutcome?.error, cleanupOutcome?.error]).toEqual([null, null]);
  expect(gateHeldBeforeLifecycle).toBe(false);
  expect(deletionOutcome?.value).toMatchObject({ ok: true });
  expect(cleanupOutcome?.value).toMatchObject(kind === 'research_evidence'
    ? { outcome: 'swept', replayed: false, detail: { evidence_items: 1 } }
    : { sourceLossRecorded: true });
  expect((await runtime.query('SELECT state FROM deletion_requests WHERE id=$1', [f.requestId])).rows).toEqual([{ state: 'committed' }]);
  expect((await runtime.query('SELECT name FROM firms WHERE id=$1', [f.deletionFirm])).rows).toEqual([{ name: REDACTED_NAME }]);
  expect((await runtime.query('SELECT id FROM evidence_items WHERE firm_id=$1', [f.deletionFirm])).rows).toEqual([]);
  expect((await runtime.query('SELECT content,reason FROM sourcing_manual_prospect_attempts WHERE id=$1', [f.attemptId])).rows)
    .toEqual([{ content: null, reason: 'source_changed_or_unavailable' }]);
  const sourceHash = createHash('sha256').update(f.sourceUrl.replace(/\/+$/u, '')).digest('hex');
  expect((await runtime.query('SELECT subject_id FROM audit_events WHERE workspace_id=$1 AND action=$2 AND subject_id=$3',
    [seeded.alpha.workspaceId, MANUAL_SOURCE_LOSS_ACTION, sourceHash])).rows).toEqual([{ subject_id: sourceHash }]);
  // The standalone owner records loss and clears derived content; physical
  // evidence deletion remains the retention target's separate responsibility.
  expect((await runtime.query('SELECT id FROM evidence_items WHERE firm_id=$1', [f.sourceFirm])).rows)
    .toEqual(kind === 'research_evidence' ? [] : f.sources.filter(row => row.firm_id === f.sourceFirm).map(row => ({ id: row.id })));
});
