import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { RESEARCH_FIRM_MAX_RESERVATIONS } from '../../research/ceilings.ts';
import { beginFirmResearch, ensureResearchCalling, finishFirmResearch, runFirmResearch } from '../../research/enrichment.ts';
import type { ExtractionProvider, ExtractionRequest, PageFetchProvider } from '../../research/providers.ts';
import { updateResearchSettings } from '../../research/settings.ts';
import { selectFirmsForSweep } from '../../research/sweep.ts';

/**
 * Slice P1, invariant I1, on the research path: the research switch is read again
 * immediately before each provider request of chunk 3 — the page fetch, the token count
 * and the model call. Before this slice `enabled` was asked only at clearance (chunks 1
 * and 2), so a switch turned off between chunk 2 and chunk 3 still bought the model call.
 *
 * Off is a hold: nothing is asked of the provider, the attempt's reservation is released
 * unused, and the run closes `refused` with `research_disabled`, which the sweep does not
 * count as a look at the firm — so the firm is researched again, as a new revision, once
 * the switch is back on.
 */

const AT = '2026-09-28T14:00:00.000Z';
const PAGE = `<p>${'We manage residential property for owners. '.repeat(20)}</p>`;
const hashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

let database: TestDatabase;
let session: SessionQueryable;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let context: RepositoryContext;
let admin: RepositoryContext;

beforeAll(async () => {
  database = await createTestDatabase();
  session = database.session;
  seeded = await seedTwoWorkspaces(session);
  crm = await seedCrm(session, seeded);
  context = repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), session);
  admin = repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
    session,
  );
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  for (const table of [
    'firm_judgments',
    'firm_facts',
    'research_runs',
    'evidence_items',
    'provider_reservations',
    'provider_ledger',
    'daily_counters',
    'funnel_facts',
    'research_settings',
  ]) {
    await session.query(`DELETE FROM ${table}`);
  }
});

/** A page fetch that counts its requests. */
function countingFetch(): PageFetchProvider & { readonly requests: () => number } {
  let requests = 0;
  return {
    providerKey: 'company_page',
    requests: () => requests,
    fetchPages: async request => {
      requests += 1;
      return await Promise.resolve({
        ok: true as const,
        costCents: 0,
        value: {
          pages: request.urls.slice(0, 1).map(url => ({
            url,
            contentHash: hashOf(PAGE),
            contentType: 'text/html; charset=utf-8',
            body: new TextEncoder().encode(PAGE),
            retrievedAt: AT,
            firstParty: true,
          })),
          skipped: {},
        },
      });
    },
  };
}

/** An extraction that records its counts and calls; `duringCount` runs inside the count. */
function recordingExtraction(duringCount: () => Promise<void> = async () => {}): ExtractionProvider & {
  readonly counted: ExtractionRequest[];
  readonly called: ExtractionRequest[];
} {
  const counted: ExtractionRequest[] = [];
  const called: ExtractionRequest[] = [];
  return {
    providerKey: 'anthropic_extraction',
    counted,
    called,
    countInputTokens: async (request: ExtractionRequest) => {
      counted.push(request);
      await duringCount();
      return 1_000;
    },
    extract: async (request: ExtractionRequest) => {
      called.push(request);
      return await Promise.resolve({
        ok: true as const,
        costCents: 1,
        value: { selections: [], questions: null, opening: null, modelName: request.modelName, inputTokens: 1_000, outputTokens: 200 },
      });
    },
  };
}

/** Chunks 1 and 2: the run reserved and the reservation marked `calling`. */
async function upToTheCall(revision: number): Promise<{ runId: string; attempt: number }> {
  const started = await beginFirmResearch(context, { firmId: crm.alpha.firmId, revision, trigger: 'sweep', at: AT });
  if (!started.ok || started.value.kind !== 'reserved') throw new Error('chunk 1 did not reserve');
  const permission = await ensureResearchCalling(context, {
    runId: started.value.runId,
    at: AT,
    maxReservations: RESEARCH_FIRM_MAX_RESERVATIONS,
    hasExtraction: true,
  });
  if (permission.kind !== 'calling') throw new Error('chunk 2 did not mark the reservation');
  return { runId: started.value.runId, attempt: permission.attempt };
}

async function chunkThree(
  where: { runId: string; attempt: number },
  revision: number,
  fetch: PageFetchProvider,
  extraction: ExtractionProvider,
) {
  return await finishFirmResearch(context, {
    runId: where.runId,
    firmId: crm.alpha.firmId,
    revision,
    at: AT,
    attempt: where.attempt,
    mayCall: true,
    pageFetch: fetch,
    extraction,
  });
}

async function runRow(runId: string): Promise<{ outcome: string; refusal: string | null; state: string; settled: number }> {
  const { rows } = await session.query<{ outcome: string; refusal: string | null; state: string; settled: number }>(
    `SELECT r.outcome, r.refusal_code AS refusal, p.state, p.settled_cents AS settled
       FROM research_runs r JOIN provider_reservations p ON p.subject_id = r.id
      WHERE r.id = $1`,
    [runId],
  );
  return rows[0] ?? { outcome: 'missing', refusal: null, state: 'missing', settled: -1 };
}

const setResearch = async (enabled: boolean): Promise<void> => {
  const updated = await updateResearchSettings(admin, { enabled });
  expect(updated.ok).toBe(true);
};

describe('I1: research turned off between chunk 2 and chunk 3', () => {
  it('the control: on, chunk 3 fetches, counts and calls once', async () => {
    const where = await upToTheCall(1);
    const fetch = countingFetch();
    const extraction = recordingExtraction();
    const result = await chunkThree(where, 1, fetch, extraction);
    expect(result.ok).toBe(true);
    expect(fetch.requests()).toBe(1);
    expect(extraction.called).toHaveLength(1);
    expect(await runRow(where.runId)).toMatchObject({ outcome: 'completed', state: 'settled' });
  });

  it('off: no fetch, no count, no model call; the reservation released; the run resumable', async () => {
    const where = await upToTheCall(1);
    await setResearch(false);
    const fetch = countingFetch();
    const extraction = recordingExtraction();
    const result = await chunkThree(where, 1, fetch, extraction);

    expect(result).toEqual({ ok: false, reason: 'research_disabled' });
    expect(fetch.requests()).toBe(0);
    expect(extraction.counted).toHaveLength(0);
    expect(extraction.called).toHaveLength(0);
    expect(await runRow(where.runId)).toEqual({ outcome: 'refused', refusal: 'research_disabled', state: 'released', settled: 0 });

    // Resumable: with research back on, the firm is due again, and a new revision calls once.
    await setResearch(true);
    const due = await selectFirmsForSweep(context, { limit: 50, at: AT, extractionConfigured: true });
    expect(due.map(candidate => candidate.firmId)).toContain(crm.alpha.firmId);
    const again = recordingExtraction();
    const resumed = await runFirmResearch(context, {
      firmId: crm.alpha.firmId,
      revision: 2,
      trigger: 'sweep',
      at: AT,
      pageFetch: countingFetch(),
      extraction: again,
    });
    expect(resumed.ok).toBe(true);
    expect(again.called).toHaveLength(1);
  });

  it('off during the token count: the model is not called and the reservation is released', async () => {
    const where = await upToTheCall(1);
    const fetch = countingFetch();
    // The switch commits while the provider is counting: the last read before the call
    // is the only thing that can see it.
    const extraction = recordingExtraction(async () => {
      await setResearch(false);
    });
    const result = await chunkThree(where, 1, fetch, extraction);

    expect(result).toEqual({ ok: false, reason: 'research_disabled' });
    expect(fetch.requests()).toBe(1);
    expect(extraction.counted).toHaveLength(1);
    expect(extraction.called).toHaveLength(0);
    expect(await runRow(where.runId)).toEqual({ outcome: 'refused', refusal: 'research_disabled', state: 'released', settled: 0 });
  });
});
