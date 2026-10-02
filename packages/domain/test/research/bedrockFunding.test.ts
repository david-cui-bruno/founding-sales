import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { RESEARCH_FIRM_MAX_RESERVATIONS } from '../../research/ceilings.ts';
import { beginFirmResearch, ensureResearchCalling } from '../../research/enrichment.ts';
import { worstCaseRunCents } from '../../research/pricing.ts';

/**
 * Slice BR1 on research, against the real database: a run whose extraction goes through
 * Bedrock is reserved under `aws_bedrock.extraction` at Bedrock's worst case and is not
 * cleared against the month's cash ceiling; and a reservation made for the direct API is
 * released, not called against, by a Bedrock worker's chunk 2.
 */

const AT = '2026-09-28T14:00:00.000Z';
const BEDROCK = 'aws_bedrock.extraction';

let database: TestDatabase;
let session: SessionQueryable;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let context: RepositoryContext;

beforeAll(async () => {
  database = await createTestDatabase();
  session = database.session;
  seeded = await seedTwoWorkspaces(session);
  crm = await seedCrm(session, seeded);
  context = repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), session);
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await session.query('DELETE FROM research_runs');
  await session.query('DELETE FROM provider_reservations');
  await session.query('DELETE FROM provider_ledger');
  await session.query('DELETE FROM daily_counters');
  await session.query('DELETE FROM research_settings');
  await session.query("DELETE FROM workspace_settings WHERE setting_key = 'monthly_cash_ceiling_cents'");
});

const reservations = async (): Promise<readonly [number, string, string, number][]> => {
  const { rows } = await session.query<{ attempt: number; provider_key: string; state: string; cents: number }>(
    'SELECT attempt, provider_key, state, cents FROM provider_reservations ORDER BY attempt',
  );
  return rows.map(row => [Number(row.attempt), row.provider_key, row.state, Number(row.cents)]);
};

async function noCashHeadroom(): Promise<void> {
  await session.query(
    `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, changed_by_user_id)
     VALUES ($1, 'monthly_cash_ceiling_cents', 1, '{"cents": 0}'::jsonb, $2)`,
    [seeded.alpha.workspaceId, seeded.alpha.admin.userId],
  );
}

const begin = async (revision: number, providerKey?: string) =>
  await beginFirmResearch(context, {
    firmId: crm.alpha.firmId,
    revision,
    trigger: 'sweep',
    at: AT,
    ...(providerKey === undefined ? {} : { providerKey }),
  });

const priced = { modelName: 'claude-haiku-4-5', maxPagesPerFirm: 4, maxPageBytes: 1_000_000 };

describe('a Bedrock research run is credit-funded', () => {
  it('the control: on the direct API, no cash headroom refuses the run', async () => {
    await noCashHeadroom();
    const started = await begin(1);
    expect(started).toEqual({ ok: false, reason: 'monthly_cash_ceiling' });
    expect(await reservations()).toEqual([]);
  });

  it('through Bedrock it is reserved anyway, under aws_bedrock.extraction, at the Bedrock worst case', async () => {
    await noCashHeadroom();
    const started = await begin(1, BEDROCK);
    expect(started.ok && started.value.kind).toBe('reserved');
    expect(await reservations()).toEqual([[1, BEDROCK, 'reserved', worstCaseRunCents({ ...priced, transport: 'bedrock' })]]);
  });
});

describe('a reservation is only ever called through the transport it was made for', () => {
  it('releases a direct-API reservation in a Bedrock worker’s chunk 2 and calls only against a fresh Bedrock one', async () => {
    const started = await begin(1);
    if (!started.ok || started.value.kind !== 'reserved') throw new Error('not reserved');
    const permission = await ensureResearchCalling(context, {
      runId: started.value.runId,
      at: AT,
      maxReservations: RESEARCH_FIRM_MAX_RESERVATIONS,
      hasExtraction: true,
      providerKey: BEDROCK,
    });
    expect(permission).toMatchObject({ kind: 'calling', attempt: 2 });
    expect(await reservations()).toEqual([
      [1, 'anthropic_extraction', 'released', worstCaseRunCents(priced)],
      [2, BEDROCK, 'calling', worstCaseRunCents({ ...priced, transport: 'bedrock' })],
    ]);
  });

  it('marks its own transport’s reservation calling, as before', async () => {
    const started = await begin(1, BEDROCK);
    if (!started.ok || started.value.kind !== 'reserved') throw new Error('not reserved');
    const permission = await ensureResearchCalling(context, {
      runId: started.value.runId,
      at: AT,
      maxReservations: RESEARCH_FIRM_MAX_RESERVATIONS,
      hasExtraction: true,
      providerKey: BEDROCK,
    });
    expect(permission).toMatchObject({ kind: 'calling', attempt: 1 });
    expect((await reservations()).map(row => row.slice(0, 3))).toEqual([[1, BEDROCK, 'calling']]);
  });
});
