import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '@fss/domain/test/db/support/fixtures.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { JOB_KIND_PROTECTION } from '@fss/domain/jobs/jobKinds.ts';
import { enqueueJob, claimJobs } from '@fss/domain/jobs/jobStore.ts';
import { recordProviderCall } from '@fss/domain/research/ledger.ts';
import { reserveAttempt } from '@fss/domain/research/reservations.ts';
import { runClaimedJob } from '../src/runner/jobRunner.ts';

let database: TestDatabase;
let seeded: TwoWorkspaces;
beforeAll(async () => { database = await createTestDatabase(); seeded = await seedTwoWorkspaces(database.session); });
afterAll(async () => { await database.drop(); });
beforeEach(async () => {
  await database.session.query('DELETE FROM jobs');
  await database.session.query('DELETE FROM provider_reservations');
  await database.session.query('DELETE FROM provider_ledger');
});

describe('typed model budget refusal reaches the durable worker boundary without retries', () => {
  it.each(['canary', 'mail.watch_renew', 'sourcing.qualify'] as const)('%s becomes terminal on its first refused reservation', async kind => {
    const session = database.session;
    const context = repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), session);
    const at = new Date().toISOString();
    await withTransaction(session, () => recordProviderCall(context, { at, businessTimeZone: 'America/New_York', providerKey: 'aws_bedrock.classifier', costCents: 5000 }));
    const protection = JOB_KIND_PROTECTION[kind];
    let providerCalls = 0;
    const registry = new HandlerRegistry().register({
      kind, protection, maxAttempts: 4, leaseSeconds: 60,
      async handle() {
        const claim = () => reserveAttempt(context, {
          subjectKind: 'research_run', subjectId: randomUUID(), attempt: 1, at, businessTimeZone: 'America/New_York',
          providerKey: 'aws_bedrock.extraction', cents: 1, modelName: 'claude-haiku-4-5', maxInputTokens: 1, maxOutputTokens: 1,
        });
        if (protection === 'outbound_fence') await withTransaction(session, claim);
        else await claim();
        providerCalls++;
      },
    });
    await enqueueJob(session, { workspaceId: seeded.alpha.workspaceId, kind, idempotencyKey: `model-refusal:${kind}`, payload: {}, maxAttempts: 4 });
    const [job] = await claimJobs(session, { owner: 'budget-test', kinds: [kind], limit: 1, leaseSeconds: 60 });
    if (!job) throw new Error('job not claimed');
    expect(await runClaimedJob(session, { registry, job })).toBe('dead');
    expect(providerCalls).toBe(0);
    expect((await session.query('SELECT state,attempt_count,error_code FROM jobs WHERE id=$1', [job.id])).rows).toEqual([
      { state: 'dead', attempt_count: 1, error_code: 'credit_model_daily_ceiling' },
    ]);
    expect(await claimJobs(session, { owner: 'retry-test', kinds: [kind], limit: 1, leaseSeconds: 60 })).toEqual([]);
    expect((await session.query('SELECT count(*)::int AS count FROM provider_reservations')).rows).toEqual([{ count: 0 }]);
  });
});
