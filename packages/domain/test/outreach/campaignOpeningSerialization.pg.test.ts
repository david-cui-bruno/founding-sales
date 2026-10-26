import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { candidateInputSchema } from '@fss/contracts';
import { campaignOpeningPgFixture, openingPgHandoff } from './campaignOpeningPgFixture.ts';
import { registerOpeningDatabases } from './campaignOpeningPgRuntime.ts';
import { allowAllEligibility } from '../../sequences/eligibility.ts';
import { selectCampaignOpeningBeforeTransaction, readCampaignOpeningAttempt } from '../../outreach/campaignOpeningStore.ts';
import { runDueStepExecution } from '../../sequences/executions.ts';
import { claimForDispatch, readFenceByStepExecution } from '../../outbound/fence.ts';
import { repositoryContext } from '../../db/workspaceScope.ts';
import { requestQualification } from '../../sourcing/qualificationStore.ts';
import { saveCandidate } from '../../sourcing/candidates.ts';
import { requestSourceCheck, runSourceCheck } from '../../sourcing/sourceCheck.ts';
import { withTransaction } from '../../db/queryable.ts';

async function prepared(f: Awaited<ReturnType<typeof campaignOpeningPgFixture>>) {
  await selectCampaignOpeningBeforeTransaction(f.worker, f.db, { executionId: f.executionId, eligibility: allowAllEligibility(),
    selector: { select: async input => ({ kind: 'selected', choice: { variantId: 'local', citationIds: input.citationIds } }) } });
  await f.tx(() => runDueStepExecution(f.worker, { stepExecutionId: f.executionId, now: f.at, eligibility: allowAllEligibility(),
    sendHandoff: { ...openingPgHandoff(f.at), dispatch: async () => ({ ok: true as const }) } }));
  const fence = await readFenceByStepExecution(f.worker, f.executionId); if (!fence) throw new Error('fence missing'); return fence;
}
async function newQualification(f: Awaited<ReturnType<typeof campaignOpeningPgFixture>>) {
  // Age only the existing fictional qualification request identity before any
  // opening snapshot. Keep the sole allowed model and every legacy constraint.
  // The ordinary owner can then request today's run rather than deduping it.
  await f.db.query('UPDATE research_settings SET enabled=true WHERE workspace_id=$1', [f.w]);
  const row = (await f.db.query<{ revision: number }>('SELECT revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2', [f.w, f.source.selection.candidateId])).rows[0]!;
  const run = (await f.db.query<{ prompt_version: string; policy_version: string; model_name: string }>('SELECT prompt_version,policy_version,model_name FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2', [f.w, f.source.selection.runId])).rows[0]!;
  const priorDay = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const fingerprint = createHash('sha256').update(JSON.stringify([row.revision, run.prompt_version, run.policy_version, run.model_name, priorDay])).digest('hex');
  await f.db.query("UPDATE sourcing_qualification_runs SET fingerprint=$3,requested_at=clock_timestamp()-interval '1 day',deadline_at=clock_timestamp()-interval '23 hours 30 minutes' WHERE workspace_id=$1 AND id=$2", [f.w, f.source.selection.runId, fingerprint]);
  return { candidateId: f.source.selection.candidateId, expectedRevision: row.revision };
}
async function counters(f: Awaited<ReturnType<typeof campaignOpeningPgFixture>>) {
  return { jobs: (await f.db.query('SELECT * FROM jobs WHERE workspace_id=$1 ORDER BY id', [f.w])).rows,
    counters: (await f.db.query('SELECT * FROM daily_counters WHERE workspace_id=$1 ORDER BY counter_kind,subject_key', [f.w])).rows,
    runs: (await f.db.query('SELECT id FROM sourcing_qualification_runs WHERE workspace_id=$1 ORDER BY id', [f.w])).rows };
}

it.each([false, true])('risk STD1 policy=%s candidate-first inversion refuses atomically while gate-first claim commits', async enabled => {
  const f = await campaignOpeningPgFixture(enabled);
  try {
    const input = await newQualification(f), fence = await prepared(f), baseline = await counters(f);
    const gate = await f.fixture.database.appRuntimeSession(), observer = await f.fixture.database.appRuntimeSession();
    await registerOpeningDatabases();
    const ownerPid = (await f.db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const gatePid = (await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await f.db.query('BEGIN'); await gate.query('BEGIN');
    try {
      await f.db.query('SET LOCAL statement_timeout=3000'); await gate.query('SET LOCAL statement_timeout=3000');
      await f.db.query('SELECT 1 FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [f.w, input.candidateId]);
      await gate.query("SELECT pg_advisory_xact_lock(hashtextextended('fss.send-gate:'||$1::text,0))", [f.w]);
      const waiting = gate.query('SELECT 1 FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [f.w, input.candidateId]);
      await vi.waitFor(async () => expect((await observer.query<{ blocked: boolean }>('SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked', [gatePid, ownerPid])).rows[0]?.blocked).toBe(true));
      await expect(requestQualification(f.admin, input)).rejects.toMatchObject({ code: '40001', constraint: 'campaign_opening_stop_serialization' });
      await f.db.query('ROLLBACK'); await waiting;
      expect((await claimForDispatch(repositoryContext(f.worker.scope, gate), { outboundMessageId: fence.id })).ok).toBe(true);
      await gate.query('COMMIT');
    } finally { await f.db.query('ROLLBACK'); await gate.query('ROLLBACK'); }
    expect(await counters(f)).toEqual(baseline); // No failed-request counter/job/run residue.
    expect((await readFenceByStepExecution(f.worker, f.executionId))?.state).toBe('dispatching');
    // New explicit mutation after the other transaction committed, never an
    // automatic retry of a selector, provider call or UNKNOWN attempt.
    expect((await f.tx(() => requestQualification(f.admin, input))).ok).toBe(true);
    if (enabled) expect(await readCampaignOpeningAttempt(f.worker, f.executionId)).toMatchObject({ state: 'invalidated', content: null });
    expect((await readFenceByStepExecution(f.worker, f.executionId))?.body).toBe(fence.body);
  } finally { await f.stop(); }
}, 60_000);

it.each([false, true])('risk STD1 policy=%s mutation-first commit is visible to the subsequent current-opening claim', async enabled => {
  const f = await campaignOpeningPgFixture(enabled);
  try {
    const input = await newQualification(f), fence = await prepared(f);
    expect((await f.tx(() => requestQualification(f.admin, input))).ok).toBe(true);
    if (enabled) {
      expect(await readCampaignOpeningAttempt(f.worker, f.executionId)).toMatchObject({ state: 'invalidated', content: null });
      await expect(f.tx(() => claimForDispatch(f.worker, { outboundMessageId: fence.id }))).rejects.toMatchObject({ code: '23514', constraint: 'campaign_opening_dispatch_current' });
      expect((await readFenceByStepExecution(f.worker, f.executionId))?.attemptToken).toBeNull();
    } else expect((await f.tx(() => claimForDispatch(f.worker, { outboundMessageId: fence.id }))).ok).toBe(true);
  } finally { await f.stop(); }
}, 60_000);

it.each(['same-payload', 'last-success', 'distinct', 'attempted'] as const)('risk STD2 actual distinct-candidate %s source denial erases only matching URL authority', async scenario => {
  const f = await campaignOpeningPgFixture();
  try {
    const fence = await prepared(f), attempt = await readCampaignOpeningAttempt(f.worker, f.executionId);
    const base = candidateInputSchema.parse((await f.db.query<{ payload: unknown }>('SELECT payload FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2', [f.w, f.source.selection.candidateId])).rows[0]?.payload);
    const shared = scenario === 'same-payload' || scenario === 'attempted';
    const candidate = await f.tx(() => saveCandidate(f.admin, { ...base, firmName: `Fictional Other ${randomUUID()}`,
      website: `https://other-${randomUUID()}.example.test/`, sourceUrl: shared ? f.source.website : 'https://distinct-source.example.test/evidence' }));
    if (!candidate.ok) throw new Error(candidate.reason);
    expect(candidate.value.id).not.toBe(f.source.selection.candidateId);
    await f.db.query('UPDATE research_settings SET enabled=true WHERE workspace_id=$1', [f.w]);
    expect((await f.tx(() => requestSourceCheck(f.admin, { id: candidate.value.id, expectedRevision: 1 }))).ok).toBe(true);
    if (scenario === 'last-success') await f.db.query(`UPDATE sourcing_candidates SET source_check=jsonb_set(source_check,'{lastSuccess}',$3::jsonb)
      WHERE workspace_id=$1 AND id=$2`, [f.w, candidate.value.id, JSON.stringify({ url: f.source.website, contentHash: 'd'.repeat(64), retrievedAt: new Date().toISOString(), firstParty: true, excerpt: 'Fictional previous readable evidence.', quoteMatched: true, truncated: false })]);
    const check = (await f.db.query<{ check_id: string }>("SELECT source_check->>'checkId' AS check_id FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2", [f.w, candidate.value.id])).rows[0]!;
    if (scenario === 'attempted') expect((await f.tx(() => claimForDispatch(f.worker, { outboundMessageId: fence.id }))).ok).toBe(true);
    const fetchPages = vi.fn(async () => ({ ok: false as const, costCents: 0, failureCode: 'fictional_local_unavailable' }));
    await withTransaction(f.db, () => runSourceCheck(f.admin, { candidateId: candidate.value.id, checkId: check.check_id }, { providerKey: 'fictional-local-only', fetchPages }));
    expect(fetchPages).toHaveBeenCalledTimes(1);
    const sourceCheck = (await f.db.query<{ check: { state: string; reason: string } }>('SELECT source_check AS check FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2', [f.w, candidate.value.id])).rows[0]?.check;
    expect(sourceCheck).toMatchObject({ state: 'unavailable', reason: 'source_unavailable' });
    // Persisted inspection precedes any B current-source reader or expiry sweep.
    const after = await readCampaignOpeningAttempt(f.worker, f.executionId), retained = await readFenceByStepExecution(f.worker, f.executionId);
    expect(after?.attempt_id).toBe(attempt?.attempt_id);
    if (scenario === 'distinct') { expect(after?.state).toBe('ready'); expect(retained?.body).toBe(fence.body); }
    else {
      expect(after).toMatchObject({ state: 'invalidated', content: null });
      const prefix = `I noticed ${f.source.name} serves Dallas, TX.\n\n`;
      expect(retained?.body).toBe(scenario === 'attempted' ? fence.body : fence.body.slice(prefix.length));
      expect(retained?.state).toBe(scenario === 'attempted' ? 'dispatching' : 'prepared');
    }
    expect((await f.db.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND enrollment_id=$2', [f.w, f.enrollmentId])).rows).toHaveLength(1);
  } finally { await f.stop(); }
}, 60_000);
