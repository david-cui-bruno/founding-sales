import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {createTestDatabase, type TestDatabase} from '../../db/testing/testDatabase.ts';
import {repositoryContext, workspaceScope, type RepositoryContext} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces, type TwoWorkspaces} from '../db/support/fixtures.ts';
import {seedCrm, type SeededCrm} from '../db/support/crmFixtures.ts';
import {databaseNow} from '../../policy/clock.ts';
import {enqueueFirmResearch} from '../../research/enqueue.ts';
import {listRuns, nextRevision, runInProgress} from '../../research/runs.ts';
import {runFirmResearch} from '../../research/enrichment.ts';
import {readCallBrief, readFirmJudgments, countFailedTries} from '../../research/brief.ts';
import {readFirmOfficeAssessment} from '../../research/officeAssessmentStore.ts';
import {enqueueJob} from '../../jobs/jobStore.ts';
import {jobIdempotencyKey} from '../../jobs/jobKinds.ts';
import type {ExtractionProvider} from '../../research/providers.ts';
import {officeProviders} from '../support/officeProviders.ts';

let db: TestDatabase;
let members: TwoWorkspaces;
let crm: SeededCrm;
let ctx: RepositoryContext;
beforeAll(async () => {
  db = await createTestDatabase();
  members = await seedTwoWorkspaces(db.session);
  crm = await seedCrm(db.session, members);
  ctx = repositoryContext(workspaceScope(members.alpha.workspaceId, {
    kind: 'user', role: 'admin', userId: members.alpha.admin.userId,
  }), db.session);
});
afterAll(async () => { await db.drop(); });
beforeEach(async () => {
  await db.session.query('BEGIN');
  await db.session.query('INSERT INTO research_settings(workspace_id,enabled) VALUES($1,true)', [members.alpha.workspaceId]);
});
afterEach(async () => { await db.session.query('ROLLBACK'); });
const command = (purpose: 'brief' | 'office_evidence' = 'office_evidence') => ({
  firmId: crm.alpha.firmId, trigger: 'user_request' as const,
  requestedByUserId: members.alpha.admin.userId, purpose,
});
async function strict(revision = 1) {
  return await runFirmResearch(ctx, {...command(), revision, at: await databaseNow(ctx), ...officeProviders()});
}
async function job(revision: number, patch: Readonly<Record<string, unknown>> = {}) {
  return await enqueueJob(db.session, {
    workspaceId: members.alpha.workspaceId, kind: 'research.firm',
    idempotencyKey: jobIdempotencyKey.researchFirm(crm.alpha.firmId, revision),
    payload: {...command(), revision, ...patch}, maxAttempts: 3,
  });
}

describe('global office research revisions and ordinary output isolation', () => {
  it.each(['done', 'dead', 'archived'] as const)('never reuses a %s durable job revision', async state => {
    const queued = await job(17);
    await db.session.query(`UPDATE jobs SET state=$2,completed_at=CASE WHEN $2='done' THEN now() END,
      dead_at=CASE WHEN $2='dead' THEN now() END,payload_archived_at=CASE WHEN $3 THEN now() END,
      payload=CASE WHEN $3 THEN '{}'::jsonb ELSE payload END WHERE id=$1`,
    [queued.jobId, state === 'archived' ? 'done' : state, state === 'archived']);
    expect(await nextRevision(ctx, crm.alpha.firmId)).toBe(18);
    const result = await enqueueFirmResearch(ctx, command('brief'));
    expect(result.ok && result.value.revision).toBe(18);
  });

  it('allocates an ordinary revision after a pending strict request without retagging it', async () => {
    const office = await enqueueFirmResearch(ctx, command());
    const brief = await enqueueFirmResearch(ctx, command('brief'));
    expect(office.ok && office.value.revision).toBe(1);
    expect(brief.ok && brief.value.revision).toBe(2);
    const rows = (await db.session.query<{payload: Record<string, unknown>}>(
      "SELECT payload FROM jobs WHERE workspace_id=$1 AND kind='research.firm' ORDER BY payload->>'revision'",
      [members.alpha.workspaceId],
    )).rows;
    expect(rows[0]?.payload['purpose']).toBe('office_evidence');
    expect(rows[1]?.payload).not.toHaveProperty('purpose');
  });

  it('rejects malformed and overflow durable identities rather than reusing a revision', async () => {
    await job(1);
    await db.session.query("UPDATE jobs SET idempotency_key=$2 WHERE workspace_id=$1", [
      members.alpha.workspaceId, `research-firm:${crm.alpha.firmId}:broken`,
    ]);
    await expect(nextRevision(ctx, crm.alpha.firmId)).rejects.toThrow('Malformed research revision identity');
    await db.session.query("UPDATE jobs SET idempotency_key=$2 WHERE workspace_id=$1", [
      members.alpha.workspaceId, `research-firm:${crm.alpha.firmId}:2147483647`,
    ]);
    await expect(nextRevision(ctx, crm.alpha.firmId)).rejects.toThrow('Research revision exhausted');
  });

  it('unfinished strict work blocks only strict enqueues even after its lease age', async () => {
    await db.session.query(`INSERT INTO research_runs(workspace_id,firm_id,revision,purpose,trigger,requested_by_user_id,started_at)
      VALUES($1,$2,1,'office_evidence','user_request',$3,now()-interval '31 minutes')`,
    [members.alpha.workspaceId, crm.alpha.firmId, members.alpha.admin.userId]);
    expect(await runInProgress(ctx, crm.alpha.firmId)).toBe(false);
    expect(await enqueueFirmResearch(ctx, command())).toMatchObject({ok: false, reason: 'run_in_progress'});
    const ordinary = await enqueueFirmResearch(ctx, command('brief'));
    expect(ordinary.ok && ordinary.value.revision).toBe(2);
  });

  it.each([
    {trigger: 'sweep'},
    {requestedByUserId: ''},
    {requestedByUserId: null},
    {revision: '2'},
  ])('does not treat a malformed strict payload as a newer valid intent %#', async patch => {
    expect((await strict()).ok).toBe(true);
    await job(2, patch);
    expect(await readFirmOfficeAssessment(ctx, {firmId: crm.alpha.firmId})).toMatchObject({status: 'supported'});
    const requested = await enqueueFirmResearch(ctx, command());
    expect(requested.ok && requested.value).toMatchObject({revision: 3, inserted: true});
  });

  it('shows a dead newer strict intent as failed, never an older positive', async () => {
    await strict();
    const queued = await job(2);
    await db.session.query("UPDATE jobs SET state='dead',dead_at=now() WHERE id=$1", [queued.jobId]);
    expect(await readFirmOfficeAssessment(ctx, {firmId: crm.alpha.firmId})).toMatchObject({
      status: 'pending', reason: 'job_failed', assessmentId: null,
    });
  });

  it('preserves a nonempty ordinary brief, generated history, judgments and freshness across strict success and failure', async () => {
    const ordinary: ExtractionProvider = {
      providerKey: 'anthropic_extraction', countInputTokens: async () => 100,
      extract: async request => {
        if (request.purpose === 'office_evidence') throw new Error('Ordinary fixture only');
        const source = request.sources[0]!;
        const block = source.blocks.find(b => b.text.includes('manages residential'))!;
        return {ok: true, costCents: 1, value: {
          selections: [{key: 'target_fit', sourceReference: source.sourceReference, blockId: block.id}],
          questions: ['How are work orders handled?', 'Who coordinates maintenance?'],
          opening: 'Your published residential-management page.',
          modelName: request.modelName, inputTokens: 100, outputTokens: 80,
        }};
      },
    };
    const result = await runFirmResearch(ctx, {
      ...command('brief'), revision: 1, at: await databaseNow(ctx),
      pageFetch: officeProviders().pageFetch, extraction: ordinary,
    });
    expect(result.ok).toBe(true);
    const snapshot = async () => ({
      brief: await readCallBrief(ctx, crm.alpha.firmId),
      judgments: await readFirmJudgments(ctx, crm.alpha.firmId),
      runs: await listRuns(ctx, crm.alpha.firmId),
      failures: await countFailedTries(ctx, crm.alpha.firmId),
      stored: (await db.session.query(`SELECT * FROM research_runs WHERE workspace_id=$1 AND purpose='brief'`, [members.alpha.workspaceId])).rows,
      facts: (await db.session.query('SELECT * FROM firm_facts WHERE workspace_id=$1 ORDER BY id', [members.alpha.workspaceId])).rows,
      judgmentRows: (await db.session.query('SELECT * FROM firm_judgments WHERE workspace_id=$1 ORDER BY run_id', [members.alpha.workspaceId])).rows,
    });
    const before = await snapshot();
    expect(before.brief?.whyFit).toHaveLength(1);
    expect(before.facts).toHaveLength(1);
    expect(before.runs).toHaveLength(1);
    expect((await strict(2)).ok).toBe(true);
    const failed = officeProviders({throwExtract: true});
    await runFirmResearch(ctx, {...command(), revision: 3, at: await databaseNow(ctx), ...failed});
    expect(failed.stats().calls).toBe(1);
    expect(await snapshot()).toEqual(before);
    expect((await listRuns(ctx, crm.alpha.firmId))[0]?.revision).toBe(1);
  });

  it('allows a lower outstanding ordinary revision to complete after newer strict work', async () => {
    await strict(2);
    const result = await runFirmResearch(ctx, {
      ...command('brief'), revision: 1, at: await databaseNow(ctx),
      pageFetch: officeProviders().pageFetch,
    });
    expect(result.ok).toBe(true);
    expect((await listRuns(ctx, crm.alpha.firmId)).map(run => run.revision)).toEqual([1]);
    expect(await readFirmOfficeAssessment(ctx, {firmId: crm.alpha.firmId})).toMatchObject({status: 'supported'});
  });
});
