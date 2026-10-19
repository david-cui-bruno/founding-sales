import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createTestDatabase, type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext, workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {seedTwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {seedCrm} from '@fss/domain/test/db/support/crmFixtures.ts';
import {officeProviders} from '@fss/domain/test/support/officeProviders.ts';
import {enqueueFirmResearch} from '@fss/domain/research/enqueue.ts';
import {readFirmOfficeAssessment} from '@fss/domain/research/officeAssessmentStore.ts';
import type {ExtractionProvider, PageFetchProvider} from '@fss/domain/research/providers.ts';
import {claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {researchFirmJobHandler} from '../src/handlers/research.ts';
import {runClaimedJob} from '../src/runner/jobRunner.ts';

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>(resolve => { release = resolve; });
  return {reached, release};
}
let db: TestDatabase;
beforeEach(async () => { db = await createTestDatabase(); });
afterEach(async () => { await db.drop(); });

describe('same-firm distinct-purpose registered finish serialization', () => {
  it.each(['brief', 'office_evidence'] as const)('finishes %s first without a lock upgrade or a lost strict reservation', async firstPurpose => {
    const members = await seedTwoWorkspaces(db.session);
    const crm = await seedCrm(db.session, members);
    const workspaceId = members.alpha.workspaceId, firmId = crm.alpha.firmId;
    const ctx = repositoryContext(workspaceScope(workspaceId, {
      kind: 'user', role: 'admin', userId: members.alpha.admin.userId,
    }), db.session);
    await db.session.query('INSERT INTO research_settings(workspace_id,enabled) VALUES($1,true)', [workspaceId]);
    for (const purpose of ['brief', 'office_evidence'] as const) {
      expect(await withTransaction(db.session, () => enqueueFirmResearch(ctx, {
        firmId, purpose, trigger: 'user_request', requestedByUserId: members.alpha.admin.userId,
      }))).toMatchObject({ok: true});
    }
    const claims = await claimJobs(db.session, {owner: 'office-finish-race', kinds: ['research.firm'], limit: 2, leaseSeconds: 120});
    expect(claims).toHaveLength(2);
    const first = claims.find(job => (job.payload['purpose'] ?? 'brief') === firstPurpose)!;
    const second = claims.find(job => job.id !== first.id)!;
    const left = await db.appRuntimeSession(), right = await db.appRuntimeSession();
    const leftPid = (await left.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const rightPid = (await right.query<{pid: number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const ready = {brief: barrier(), office_evidence: barrier()};
    const start = {brief: barrier(), office_evidence: barrier()};
    const fetching = {brief: barrier(), office_evidence: barrier()};
    const respond = {brief: barrier(), office_evidence: barrier()};
    const fetchStarted = {brief: false, office_evidence: false};
    const strict = officeProviders();
    let ordinaryCalls = 0, ordinaryCounts = 0;
    const extraction: ExtractionProvider = {
      providerKey: strict.extraction.providerKey,
      countInputTokens: async request => {
        if (request.purpose === 'office_evidence') return await strict.extraction.countInputTokens(request);
        ordinaryCounts++;
        return 100;
      },
      extract: async request => {
        if (request.purpose === 'office_evidence') return await strict.extraction.extract(request);
        ordinaryCalls++;
        const source = request.sources[0]!;
        return {ok: true, costCents: 1, value: {
          selections: [{key: 'residential_scope', sourceReference: source.sourceReference,
            blockId: source.blocks.find(block => block.text.includes('manages residential'))!.id}],
          questions: null, opening: null, modelName: request.modelName, inputTokens: 100, outputTokens: 80,
        }};
      },
    };
    const pageFetch: PageFetchProvider = {
      providerKey: strict.pageFetch.providerKey,
      fetchPages: async request => {
        const purpose = request.prioritizeContactPages ? 'office_evidence' : 'brief';
        fetchStarted[purpose] = true;
        fetching[purpose].release();
        await respond[purpose].reached;
        return await strict.pageFetch.fetchPages(request);
      },
    };
    const handler = researchFirmJobHandler({pageFetch, extraction});
    const databaseErrors: string[] = [];
    const registry = new HandlerRegistry().register({...handler, handle: async input => {
      const progress = input.job.payload['progress'] as {step?: string} | undefined;
      if (progress?.step === 'calling') {
        const purpose = input.job.payload['purpose'] === 'office_evidence' ? 'office_evidence' : 'brief';
        ready[purpose].release();
        await start[purpose].reached;
      }
      try {
        return await handler.handle(input);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') databaseErrors.push(error.code);
        throw error;
      }
    }});
    const runs = [runClaimedJob(left, {registry, job: first}), runClaimedJob(right, {registry, job: second})];
    const secondPurpose = firstPurpose === 'brief' ? 'office_evidence' : 'brief';
    try {
      await Promise.all([ready.brief.reached, ready.office_evidence.reached]);
      // Both calling markers are committed, so serialization must happen in chunk 3.
      expect((await db.session.query("SELECT state FROM provider_reservations ORDER BY id")).rows).toEqual([{state: 'calling'}, {state: 'calling'}]);
      start[firstPurpose].release();
      await fetching[firstPurpose].reached;
      start[secondPurpose].release();
      // Observe an actual PostgreSQL wait behind the first finish transaction, not
      // a sleep or two compatible locks held at independent fetch barriers.
      await expect.poll(async () => fetchStarted[secondPurpose] || (await db.session.query<{blocked: boolean}>(
        'SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [rightPid, leftPid],
      )).rows[0]?.blocked, {timeout: 2000}).toBe(true);
      const serialized = !fetchStarted[secondPurpose];
      expect(ordinaryCalls + strict.stats().calls).toBe(0);
      // The pre-fix path reaches both fetch barriers with compatible locks. Release
      // both there to reproduce the real upgrade deadlock, not just a missing wait.
      respond[firstPurpose].release();
      if (!serialized) respond[secondPurpose].release();
      await fetching[secondPurpose].reached;
      respond[secondPurpose].release();
      const outcomes = await Promise.all(runs);
      expect(databaseErrors).toEqual([]);
      expect(outcomes).toEqual(['completed', 'completed']);
      expect(serialized).toBe(true);
    } finally {
      for (const purpose of ['brief', 'office_evidence'] as const) {
        start[purpose].release(); respond[purpose].release();
      }
      await Promise.allSettled(runs);
    }
    expect(strict.stats()).toEqual({fetches: 2, counts: 1, calls: 1});
    expect({ordinaryCounts, ordinaryCalls}).toEqual({ordinaryCounts: 1, ordinaryCalls: 1});
    expect((await db.session.query(`SELECT purpose,outcome,extraction,facts_recorded FROM research_runs ORDER BY revision`)).rows)
      .toEqual([{purpose: 'brief', outcome: 'completed', extraction: 'used', facts_recorded: 1},
        {purpose: 'office_evidence', outcome: 'completed', extraction: 'used', facts_recorded: 0}]);
    expect((await db.session.query(`SELECT r.purpose,p.attempt,p.state FROM provider_reservations p
      JOIN research_runs r ON r.id=p.subject_id AND r.workspace_id=p.workspace_id ORDER BY r.revision`)).rows)
      .toEqual([{purpose: 'brief', attempt: 1, state: 'settled'}, {purpose: 'office_evidence', attempt: 1, state: 'settled'}]);
    expect((await db.session.query('SELECT key,quote FROM firm_facts WHERE firm_id=$1', [firmId])).rows)
      .toEqual([{key: 'residential_scope', quote: 'Northwind Test Holdings manages residential properties in Providence, RI.'}]);
    expect(await readFirmOfficeAssessment(ctx, {firmId})).toMatchObject({status: 'supported', sourceCount: 1});
  }, 15000);
});
