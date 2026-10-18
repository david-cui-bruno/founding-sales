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
import { readFinishing } from '../../settings/finishing.ts';
import { openHold, releaseHold } from '../../policy/holds.ts';
import { enqueueFirmResearch } from '../../research/enqueue.ts';
import { readResearchSettings } from '../../research/settings.ts';
import { settleAttempt } from '../../research/reservations.ts';

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
const PAGE = `<p>${'We manage residential property for owners. '.repeat(20)}</p>`
  .concat(`<p>${'Our maintenance team takes every work order. '.repeat(20)}</p>`)
  .concat(`<p>${'The portfolio is about four hundred doors. '.repeat(20)}</p>`);
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
  await session.query('DELETE FROM active_holds');
  await session.query('DELETE FROM jobs');
  await session.query('UPDATE firms SET assigned_user_id=$1 WHERE id=$2', [seeded.alpha.salesperson.userId, crm.alpha.firmId]);
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

/** A page fetch that counts its requests; `duringFetch` runs inside it. */
function countingFetch(duringFetch: () => Promise<void> = async () => {}): PageFetchProvider & {
  readonly requests: () => number;
  readonly askedPause: () => boolean;
} {
  let requests = 0;
  let askedPause = false;
  return {
    providerKey: 'company_page',
    requests: () => requests,
    askedPause: () => askedPause,
    fetchPages: async request => {
      requests += 1;
      await duringFetch();
      // The adapter asks the predicate before each of its own requests; this fake asks once.
      if (request.shouldContinue !== undefined) {
        askedPause = true;
        if (!(await request.shouldContinue())) {
          return { ok: true as const, costCents: 0, value: { pages: [], skipped: { paused: 1 } } };
        }
      }
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
function recordingExtraction(duringCount: () => Promise<void> = async () => {}, tokens = 1_000): ExtractionProvider & {
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
      return tokens;
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
    // Marked `calling` and not yet called: the one the finishing line counts.
    expect(await readFinishing(context)).toMatchObject({ researchOn: false, researchFinishing: 1 });
    const fetch = countingFetch();
    const extraction = recordingExtraction();
    const result = await chunkThree(where, 1, fetch, extraction);

    expect(result).toEqual({ ok: false, reason: 'research_disabled' });
    expect(fetch.requests()).toBe(0);
    expect(extraction.counted).toHaveLength(0);
    expect(extraction.called).toHaveLength(0);
    expect(await runRow(where.runId)).toEqual({ outcome: 'refused', refusal: 'research_disabled', state: 'released', settled: 0 });
    expect((await readFinishing(context)).researchFinishing).toBe(0);

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

describe('I1: research turned off inside chunk 3, between its requests', () => {
  it('off during the page fetch: the fetcher is handed the predicate, and nothing is counted or called', async () => {
    const where = await upToTheCall(1);
    const fetch = countingFetch(async () => {
      await setResearch(false);
    });
    const extraction = recordingExtraction();
    const result = await chunkThree(where, 1, fetch, extraction);
    expect(fetch.askedPause()).toBe(true);
    expect(result).toEqual({ ok: false, reason: 'research_disabled' });
    expect(extraction.counted).toHaveLength(0);
    expect(extraction.called).toHaveLength(0);
    expect(await runRow(where.runId)).toEqual({ outcome: 'refused', refusal: 'research_disabled', state: 'released', settled: 0 });
  });

  it('off during an oversized count: no second count and no call', async () => {
    const where = await upToTheCall(1);
    // Every count is too large for the reservation, so without the pause the loop drops a
    // block and counts again.
    const extraction = recordingExtraction(async () => {
      await setResearch(false);
    }, 10_000_000);
    const result = await chunkThree(where, 1, countingFetch(), extraction);
    expect(result).toEqual({ ok: false, reason: 'research_disabled' });
    expect(extraction.counted).toHaveLength(1);
    expect(extraction.called).toHaveLength(0);
    expect(await runRow(where.runId)).toMatchObject({ outcome: 'refused', state: 'released' });
  });

  it('the control: on, an oversized count is counted again after a drop', async () => {
    const where = await upToTheCall(1);
    const extraction = recordingExtraction(async () => {}, 10_000_000);
    await chunkThree(where, 1, countingFetch(), extraction);
    expect(extraction.counted.length).toBeGreaterThan(1);
    expect(extraction.called).toHaveLength(0);
  });
});

type ResearchHoldScope = 'workspace' | 'firm' | 'owner' | 'channel';
async function holdResearch(scopeKind: ResearchHoldScope): Promise<string> {
  const key = { workspace: undefined, firm: crm.alpha.firmId, owner: seeded.alpha.salesperson.userId, channel: 'research' }[scopeKind];
  return await openHold(context, {
    scopeKind, ...(key === undefined ? {} : { scopeKey: key }),
    reasonCode: 'scoped_pause', blockedActionKinds: ['research'], sourceEventKind: 'research_hold_test',
  });
}

describe('explicit research holds disable the action, never the stored switch', () => {
  it.each(['workspace', 'firm', 'owner', 'channel'] as const)('%s hold refuses enqueue and begin before reserving', async scope => {
    await setResearch(true);
    await holdResearch(scope);
    expect(await enqueueFirmResearch(context, { firmId: crm.alpha.firmId, trigger: 'user_request', requestedByUserId: seeded.alpha.admin.userId }))
      .toEqual({ ok: false, reason: 'research_disabled' });
    expect(await beginFirmResearch(context, { firmId: crm.alpha.firmId, revision: 1, trigger: 'sweep', at: AT }))
      .toEqual({ ok: false, reason: 'research_disabled' });
    expect((await session.query('SELECT id FROM provider_reservations')).rows).toEqual([]);
    expect((await session.query('SELECT id FROM jobs')).rows).toEqual([]);
    expect((await readResearchSettings(context)).enabled).toBe(true);
  });

  it.each(['workspace', 'firm', 'owner', 'channel'] as const)('%s hold after reservation stops fetch/count/extraction and releases unused spend', async scope => {
    await setResearch(true);
    const where = await upToTheCall(1);
    await holdResearch(scope);
    const fetch = countingFetch(), extraction = recordingExtraction();
    expect(await chunkThree(where, 1, fetch, extraction)).toEqual({ ok: false, reason: 'research_disabled' });
    expect(fetch.requests()).toBe(0);
    expect(extraction.counted).toHaveLength(0);
    expect(extraction.called).toHaveLength(0);
    expect(await runRow(where.runId)).toEqual({ outcome: 'refused', refusal: 'research_disabled', state: 'released', settled: 0 });
    expect((await readResearchSettings(context)).enabled).toBe(true);
  });

  it('hands the scoped-hold predicate to the fetcher and refuses incomplete work', async () => {
    const where = await upToTheCall(1);
    let allowed: boolean | undefined;
    const fetch: PageFetchProvider = { providerKey: 'company_page', fetchPages: async request => {
      await holdResearch('firm');
      allowed = await request.shouldContinue?.();
      return { ok: true, costCents: 0, value: { pages: [], skipped: { paused: 1 } } };
    } };
    const extraction = recordingExtraction();
    expect(await chunkThree(where, 1, fetch, extraction)).toEqual({ ok: false, reason: 'research_disabled' });
    expect(allowed).toBe(false);
    expect(extraction.counted).toHaveLength(0);
    expect(extraction.called).toHaveLength(0);
    expect((await readResearchSettings(context)).enabled).toBe(true);
  });

  it.each([1_000, 10_000_000])('hold during token count %s prevents the next count and paid extraction', async tokens => {
    const where = await upToTheCall(1);
    const extraction = recordingExtraction(async () => { await holdResearch('channel'); }, tokens);
    expect(await chunkThree(where, 1, countingFetch(), extraction)).toEqual({ ok: false, reason: 'research_disabled' });
    expect(extraction.counted).toHaveLength(1);
    expect(extraction.called).toHaveLength(0);
    expect(await runRow(where.runId)).toMatchObject({ outcome: 'refused', state: 'released', settled: 0 });
  });

  it('re-reads assignment after queuing, rather than binding owner authority to requester', async () => {
    await openHold(context, { scopeKind: 'owner', scopeKey: seeded.alpha.admin.userId, reasonCode: 'scoped_pause', blockedActionKinds: ['research'], sourceEventKind: 'research_hold_test' });
    expect((await enqueueFirmResearch(context, { firmId: crm.alpha.firmId, trigger: 'user_request', requestedByUserId: seeded.alpha.admin.userId })).ok).toBe(true);
    const where = await upToTheCall(1);
    await session.query('UPDATE firms SET assigned_user_id=$1 WHERE id=$2', [seeded.alpha.admin.userId, crm.alpha.firmId]);
    const extraction = recordingExtraction(), fetch = countingFetch();
    expect(await chunkThree(where, 1, fetch, extraction)).toEqual({ ok: false, reason: 'research_disabled' });
    expect(fetch.requests()).toBe(0);
    expect(extraction.called).toHaveLength(0);
  });

  it.each(['settled', 'estimated'] as const)('keeps earlier %s cost while releasing the held current attempt', async kind => {
    const first = await upToTheCall(1);
    const row = (await session.query<{ id: string }>('SELECT id FROM provider_reservations WHERE subject_id=$1', [first.runId])).rows[0]!;
    await settleAttempt(context, { reservationId: row.id, at: AT, outcome: { kind, cents: 2 } });
    const next = await ensureResearchCalling(context, { runId: first.runId, at: AT, maxReservations: RESEARCH_FIRM_MAX_RESERVATIONS, hasExtraction: true });
    if (next.kind !== 'calling') throw new Error('retry did not reserve');
    await holdResearch('firm');
    const extraction = recordingExtraction();
    expect(await chunkThree({ runId: first.runId, attempt: next.attempt }, 1, countingFetch(), extraction)).toEqual({ ok: false, reason: 'research_disabled' });
    expect(extraction.called).toHaveLength(0);
    expect((await session.query('SELECT outcome,refusal_code,cost_cents,cost_estimated FROM research_runs WHERE id=$1', [first.runId])).rows[0])
      .toEqual({ outcome: 'refused', refusal_code: 'research_disabled', cost_cents: 2, cost_estimated: kind === 'estimated' });
    expect((await session.query('SELECT state,settled_cents FROM provider_reservations ORDER BY attempt')).rows)
      .toEqual([{ state: kind, settled_cents: 2 }, { state: 'released', settled_cents: 0 }]);
    expect((await readResearchSettings(context)).enabled).toBe(true);
  });

  it.each(['other_owner', 'other_firm', 'other_workspace', 'email', 'call', 'released', 'unassigned', 'reassigned'] as const)('does not widen %s holds into a research stop', async scenario => {
    await setResearch(true);
    if (scenario === 'other_owner') await openHold(context, { scopeKind: 'owner', scopeKey: seeded.alpha.admin.userId, reasonCode: 'scoped_pause', blockedActionKinds: ['research'], sourceEventKind: 'research_hold_test' });
    else if (scenario === 'other_firm') await openHold(context, { scopeKind: 'firm', scopeKey: crm.beta.firmId, reasonCode: 'scoped_pause', blockedActionKinds: ['research'], sourceEventKind: 'research_hold_test' });
    else if (scenario === 'other_workspace') await openHold(repositoryContext(workspaceScope(seeded.beta.workspaceId, { kind: 'system', component: 'worker' }), session), { scopeKind: 'workspace', reasonCode: 'scoped_pause', blockedActionKinds: ['research'], sourceEventKind: 'research_hold_test' });
    else if (scenario === 'email' || scenario === 'call') await openHold(context, { scopeKind: 'channel', scopeKey: scenario, reasonCode: 'scoped_pause', blockedActionKinds: scenario === 'email' ? ['email_send'] : ['call_task', 'dial_authorization'], sourceEventKind: 'research_hold_test' });
    else if (scenario === 'released') await releaseHold(context, await holdResearch('firm'));
    else {
      await holdResearch('owner');
      await session.query('UPDATE firms SET assigned_user_id=$1 WHERE id=$2', [scenario === 'unassigned' ? null : seeded.alpha.admin.userId, crm.alpha.firmId]);
    }
    const where = await upToTheCall(1), extraction = recordingExtraction();
    expect((await chunkThree(where, 1, countingFetch(), extraction)).ok).toBe(true);
    expect(extraction.called).toHaveLength(1);
  });
});
