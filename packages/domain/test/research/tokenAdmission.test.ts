import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { RESEARCH_FIRM_MAX_RESERVATIONS } from '../../research/ceilings.ts';
import { beginFirmResearch, ensureResearchCalling, finishFirmResearch } from '../../research/enrichment.ts';
import {
  admitCall,
  centsOf,
  countedWithHeadroom,
  MAX_EXTRACTION_OUTPUT_TOKENS,
  TOKEN_COUNT_HEADROOM,
  worstCaseInputTokens,
  type ReservationSnapshot,
} from '../../research/pricing.ts';
import type { ExtractionProvider, ExtractionRequest, PageFetchProvider } from '../../research/providers.ts';
import { updateResearchSettings } from '../../research/settings.ts';

/**
 * Token admission, decided against the reservation rather than against the settings.
 *
 * The fourth review's third P0. Attempt 1 priced its cents from the settings at opening
 * time, and chunk 3 then re-read those settings and compared the provider's count with
 * their *current* token limit — never with `reservation.cents`. Raising
 * `max_pages_per_firm` between the two chunks admitted a request bigger than the money
 * held for it, and the model called was whatever the adapter had been composed with.
 *
 * The fix is a snapshot on the row: `model_name`, `max_input_tokens`,
 * `max_output_tokens` beside `cents`, all four written by the one clearance that priced
 * them. `admitCall` is the whole decision, and it is pure.
 */

const AT = '2026-09-28T14:00:00.000Z';
const PRICED = 'claude-haiku-4-5';

const PAGE = `<p>${'We manage residential property for owners. '.repeat(20)}</p>`
  .concat(`<p>${'Our maintenance team takes every work order. '.repeat(20)}</p>`)
  .concat(`<p>${'The portfolio is about four hundred doors. '.repeat(20)}</p>`);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const hashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The snapshot chunk 1 writes at the defaults: four pages, one model, six hundred out. */
const defaultSnapshot: ReservationSnapshot = {
  modelName: PRICED,
  maxInputTokens: worstCaseInputTokens({ maxPagesPerFirm: 4, maxPageBytes: 1_000_000 }),
  maxOutputTokens: MAX_EXTRACTION_OUTPUT_TOKENS,
  cents: 3,
};

describe('admitCall', () => {
  it('admits a request inside the snapshot, and prices it at the counted tokens', () => {
    expect(admitCall(defaultSnapshot, 1_000)).toEqual({ kind: 'call', inputTokens: 1_050 });
  });

  it('refuses a count that only fits without its headroom', () => {
    // Anthropic documents the count as an estimate, so the estimate gets five per cent
    // before it is compared with the money. A request counted at exactly the snapshot's
    // input bound is therefore refused: billed five per cent higher it would cost more
    // than the cents being held.
    const exactly = defaultSnapshot.maxInputTokens;
    expect(countedWithHeadroom(exactly)).toBeGreaterThan(exactly);
    expect(admitCall(defaultSnapshot, exactly)).toEqual({ kind: 'refuse', reason: 'tokens' });
    // And the largest count that still fits is the bound divided by the headroom.
    const fits = Math.floor(exactly / TOKEN_COUNT_HEADROOM);
    expect(admitCall(defaultSnapshot, fits).kind).toBe('call');
  });

  it('refuses when the counted request would cost more than the cents on the row', () => {
    // The half the old check never asked. The tokens fit the snapshot's bound here and
    // the cents do not, which is exactly what a reservation priced at another moment
    // looks like.
    const cheap: ReservationSnapshot = { ...defaultSnapshot, cents: 1 };
    const counted = 20_000;
    expect(countedWithHeadroom(counted)).toBeLessThanOrEqual(cheap.maxInputTokens);
    expect(centsOf(PRICED, { inputTokens: countedWithHeadroom(counted), outputTokens: cheap.maxOutputTokens })).toBeGreaterThan(1);
    expect(admitCall(cheap, counted)).toEqual({ kind: 'refuse', reason: 'cents' });
  });

  it('refuses a snapshot naming a model nobody priced, rather than pricing it at zero', () => {
    expect(admitCall({ ...defaultSnapshot, modelName: 'claude-haiku-9-9' }, 100)).toEqual({
      kind: 'refuse',
      reason: 'unpriced',
    });
  });
});

/** A fetch of one large page, so there are blocks to drop. */
function fakeFetch(): PageFetchProvider {
  return {
    providerKey: 'company_page',
    fetchPages: async request => ({
      ok: true,
      costCents: 0,
      value: {
        pages: request.urls.slice(0, 1).map(url => ({
          url,
          contentHash: hashOf(PAGE),
          contentType: 'text/html; charset=utf-8',
          body: bytes(PAGE),
          retrievedAt: AT,
          firstParty: true,
        })),
        skipped: {},
      },
    }),
  };
}

/** An extraction that reports a fixed count and records every request it was handed. */
function recordingExtraction(count: number): ExtractionProvider & {
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
      return await Promise.resolve(count);
    },
    extract: async (request: ExtractionRequest) => {
      called.push(request);
      return await Promise.resolve({
        ok: true as const,
        costCents: 1,
        value: {
          selections: [],
          questions: null,
          opening: null,
          modelName: request.modelName,
          inputTokens: count,
          outputTokens: 200,
        },
      });
    },
  };
}

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
  context = repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }),
    session,
  );
  admin = repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
    session,
  );
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await session.query('DELETE FROM firm_judgments');
  await session.query('DELETE FROM firm_facts');
  await session.query('DELETE FROM research_runs');
  await session.query('DELETE FROM evidence_items');
  await session.query('DELETE FROM provider_reservations');
  await session.query('DELETE FROM provider_ledger');
  await session.query('DELETE FROM daily_counters');
  await session.query('DELETE FROM funnel_facts');
  await session.query('DELETE FROM research_settings');
});

/** Chunks 1 and 2, which is everything before the call. */
const upToTheCall = async (): Promise<{ runId: string; attempt: number }> => {
  const started = await beginFirmResearch(context, {
    firmId: crm.alpha.firmId,
    revision: 1,
    trigger: 'sweep',
    at: AT,
  });
  if (!started.ok || started.value.kind !== 'reserved') throw new Error('chunk 1 did not reserve');
  const permission = await ensureResearchCalling(context, {
    runId: started.value.runId,
    at: AT,
    maxReservations: RESEARCH_FIRM_MAX_RESERVATIONS,
    hasExtraction: true,
  });
  if (permission.kind !== 'calling') throw new Error('chunk 2 did not mark the reservation');
  return { runId: started.value.runId, attempt: permission.attempt };
};

const chunkThree = async (
  where: { runId: string; attempt: number },
  extraction: ExtractionProvider,
): Promise<void> => {
  await finishFirmResearch(context, {
    runId: where.runId,
    firmId: crm.alpha.firmId,
    revision: 1,
    at: AT,
    attempt: where.attempt,
    mayCall: true,
    pageFetch: fakeFetch(),
    extraction,
  });
};

const runState = async (): Promise<{ outcome: string; extraction: string; cost: number; state: string }> => {
  const { rows } = await session.query<{ outcome: string; extraction: string; cost: number; state: string }>(
    `SELECT r.outcome, r.extraction, r.cost_cents::int AS cost, p.state
       FROM research_runs r JOIN provider_reservations p ON p.subject_id = r.id
      WHERE r.workspace_id = $1`,
    [seeded.alpha.workspaceId],
  );
  return rows[0] ?? { outcome: 'missing', extraction: 'missing', cost: -1, state: 'missing' };
};

describe('the call chunk 3 may make', () => {
  it('refuses a request that fits the settings as they are now but not the reservation', async () => {
    const where = await upToTheCall();
    // Somebody doubles the pages between the chunks. The *settings* would now admit a
    // request of about forty-eight thousand tokens; the reservation was priced for
    // twenty-four thousand and holds three cents.
    await updateResearchSettings(admin, { maxPagesPerFirm: 8 });
    const widened = worstCaseInputTokens({ maxPagesPerFirm: 8, maxPageBytes: 1_000_000 });
    const counted = 30_000;
    expect(counted + MAX_EXTRACTION_OUTPUT_TOKENS).toBeLessThanOrEqual(widened);
    expect(countedWithHeadroom(counted)).toBeGreaterThan(defaultSnapshot.maxInputTokens);

    const extraction = recordingExtraction(counted);
    await chunkThree(where, extraction);
    // Counted, dropped, recounted — and never called.
    expect(extraction.counted.length).toBeGreaterThan(1);
    expect(extraction.called).toEqual([]);
    // Not a failure and not a cost: the evidence is kept, the cents go back, and the run
    // says which of the two it was.
    expect(await runState()).toEqual({ outcome: 'completed', extraction: 'over_budget', cost: 0, state: 'released' });
  });

  it('calls with the model and the output bound the reservation names, not the settings’', async () => {
    const where = await upToTheCall();
    // The row is the authorization, so it is the row that says what the call is. A
    // narrower output bound here than `MAX_EXTRACTION_OUTPUT_TOKENS` is what proves the
    // request is built from the snapshot and not from the constant or the settings.
    await session.query('UPDATE provider_reservations SET max_output_tokens = 400');
    const extraction = recordingExtraction(1_000);
    await chunkThree(where, extraction);
    expect(extraction.called.length).toBe(1);
    expect(extraction.called[0]).toMatchObject({ modelName: PRICED, maxOutputTokens: 400 });
    // The count is of the same request, snapshot included: an exact count of a different
    // body is an estimate again.
    expect(extraction.counted[0]).toMatchObject({ modelName: PRICED, maxOutputTokens: 400 });
    expect(await runState()).toMatchObject({ outcome: 'completed', extraction: 'used', state: 'settled' });
  });

  it('makes no call at all when the reservation’s model has no reviewed price', async () => {
    const where = await upToTheCall();
    // The settings' model is priced; this row's is not. Under the old check the call
    // went out at the settings' model and was priced at the settings' model, whatever
    // the reservation had authorized.
    await session.query("UPDATE provider_reservations SET model_name = 'claude-haiku-9-9'");
    const extraction = recordingExtraction(100);
    await chunkThree(where, extraction);
    expect(extraction.called).toEqual([]);
    expect(await runState()).toEqual({ outcome: 'completed', extraction: 'over_budget', cost: 0, state: 'released' });
  });
});
