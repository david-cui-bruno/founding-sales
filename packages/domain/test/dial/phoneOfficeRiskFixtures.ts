import { expect } from 'vitest';
import type { SourceObservation, QualificationFact } from '@fss/contracts';
import { withTransaction, type SessionQueryable } from '../../db/queryable.ts';
import { saveCandidate } from '../../sourcing/candidates.ts';
import { requestQualification, finishQualification } from '../../sourcing/qualificationStore.ts';
import type { OwnerRiskFixture } from './phoneOwnerRiskFixtures.ts';

export async function admitOffice(value: OwnerRiskFixture) {
  const source = (await value.database.session.query<{ observation: SourceObservation; facts: QualificationFact[] }>(
    'SELECT observation,facts FROM firm_office_assessment_sources WHERE workspace_id=$1', [value.w])).rows[0]!;
  const candidate = await withTransaction(value.runtime, () => saveCandidate(value.context, { firmName: 'Northwind Test Holdings',
    website: 'https://northwind.example.test', locality: 'Providence', region: 'RI', signal: 'fit_only', evidence: 'Synthetic source',
    sourceUrl: 'https://northwind.example.test', observedOn: new Date().toISOString().slice(0, 10), preparedBy: 'Synthetic test only' }));
  if (!candidate.ok) throw new Error(candidate.reason);
  const run = await withTransaction(value.runtime, () => requestQualification(value.context, { candidateId: candidate.value.id, expectedRevision: 1 }, { enqueue: false }));
  if (!run.ok) throw new Error(run.reason);
  expect((await withTransaction(value.runtime, () => finishQualification(value.context, { runId: run.value.runId,
    observations: [source.observation], facts: source.facts, reason: null }))).ok).toBe(true);
  await value.database.session.query(`INSERT INTO sourcing_admissions(workspace_id,candidate_id,run_id,firm_id,route_id)
    VALUES($1,$2,$3,$4,$5)`, [value.w, candidate.value.id, run.value.runId, value.crm.alpha.firmId, value.policy.alpha.phoneRouteId]);
  return { candidateId: candidate.value.id, runId: run.value.runId, source };
}
export async function connection(value: OwnerRiskFixture) {
  const session = await value.database.appRuntimeSession();
  await session.query("SET statement_timeout='8s'");
  const pid = (await session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  return { session, pid };
}
export async function waitsOn(value: OwnerRiskFixture, waiter: number, blocker: number) {
  await expect.poll(async () => (await value.database.session.query<{ blocked: boolean }>(
    'SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked', [blocker, waiter])).rows[0]?.blocked,
  { timeout: 4000 }).toBe(true);
}
export async function pid(session: SessionQueryable) {
  return (await session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
}
