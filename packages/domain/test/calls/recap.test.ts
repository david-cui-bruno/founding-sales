import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callAnalysisResultSchema, callRecapResponseSchema } from '@fss/contracts';
import { buildRecap, readDailyRecap, type RecapSource } from '../../calls/recap.ts';
import { answer, lines } from './analysisFixtures.ts';
import { createApplyWorld, type ApplyWorld } from './support/applyWorld.ts';

/**
 * Slice 3a, lane C — C-3: the daily recap. A read over stored analyses: its daily scope, the
 * small-sample label below five calls, "in k of n calls" with verbatim quotes, recurring at two
 * calls or more, and one coaching observation or none. No table, no model call.
 */

const ref = (quote: string) => ({ line: 2, side: 'them' as const, start: 5, end: 9, quote });

function source(id: string, objections: readonly [string, string][], coaching: string | null = null, completedAt = '2026-10-02T15:00:00.000Z'): RecapSource {
  return {
    callSessionId: id,
    completedAt,
    result: callAnalysisResultSchema.parse({
      reached: 'person',
      summary: 'A call.',
      facts: [],
      interest: { level: 'neutral', signals: [] },
      objections: objections.map(([category, quote]) => ({ category, ref: ref(quote), answered: null })),
      followUpRequest: null,
      callback: null,
      stop: null,
      wrongNumber: null,
      referral: null,
      voicemailLeft: false,
      commitments: [],
      coaching: coaching === null ? null : { observation: coaching, lines: [{ line: 1, side: 'you', start: 0, end: 4 }] },
      stopPhrases: [],
      dropped: {},
    }),
  };
}

const ids = Array.from({ length: 6 }, (_, index) => `00000000-0000-4000-8000-00000000000${String(index + 1)}`);

describe('buildRecap (pure)', () => {
  it('says "small sample" below five calls and not from five', () => {
    const four = buildRecap('2026-10-02', 'America/New_York', ids.slice(0, 4).map(id => source(id, [])));
    expect(four).toMatchObject({ callsAnalysed: 4, smallSample: true });
    const five = buildRecap('2026-10-02', 'America/New_York', ids.slice(0, 5).map(id => source(id, [])));
    expect(five).toMatchObject({ callsAnalysed: 5, smallSample: false });
  });

  it('counts an objection once per call, is recurring from two calls, and quotes verbatim from different calls', () => {
    const recap = buildRecap('2026-10-02', 'America/New_York', [
      source(ids[0] as string, [['has_solution', 'We already use AppFolio'], ['has_solution', 'We have a portal too']]),
      source(ids[1] as string, [['has_solution', 'We use Buildium'], ['price', 'Too expensive for us']]),
      source(ids[2] as string, []),
    ]);
    const solution = recap.objections.find(entry => entry.category === 'has_solution');
    // Three mentions in two calls: "in 2 of 3 calls".
    expect(solution).toMatchObject({ calls: 2, recurring: true });
    expect(solution?.quotes.map(quote => quote.quote)).toEqual(['We already use AppFolio', 'We use Buildium']);
    expect(recap.objections.find(entry => entry.category === 'price')).toMatchObject({ calls: 1, recurring: false });
    expect(recap.objections[0]?.category).toBe('has_solution');
    expect(recap.callsAnalysed).toBe(3);
  });

  it('gives one coaching observation, the newest, or none', () => {
    expect(buildRecap('2026-10-02', 'UTC', [source(ids[0] as string, [])]).coaching).toBeNull();
    const recap = buildRecap('2026-10-02', 'UTC', [
      source(ids[0] as string, [], 'Ask a question sooner.', '2026-10-02T14:00:00.000Z'),
      source(ids[1] as string, [], 'Slow down when you give the price.', '2026-10-02T16:00:00.000Z'),
    ]);
    expect(recap.coaching).toEqual({ observation: 'Slow down when you give the price.', callSessionId: ids[1] });
  });

  it('is a valid response when there are no calls at all', () => {
    const recap = buildRecap('2026-10-02', 'UTC', []);
    expect(callRecapResponseSchema.parse(recap)).toMatchObject({ callsAnalysed: 0, smallSample: true, objections: [], coaching: null });
  });
});

describe('readDailyRecap (real database)', () => {
  let world: ApplyWorld;
  beforeAll(async () => {
    world = await createApplyWorld();
  });
  afterAll(async () => {
    await world.drop();
  });

  it('reads the day’s analysed calls only, each call once however often it was analysed', async () => {
    const today = await readDailyRecap(world.salesperson());
    const before = today.callsAnalysed;
    const firm = await world.newFirm();
    const placed = await world.placeCall(firm, lines(['Y', 'Hi, David from Callie.'], ['T', "We're all set, we already use AppFolio."]));
    const reading = answer({ objections: [{ category: 'has_solution', quote: 'we already use AppFolio', line: 2, answered_line: 0 }] });
    await world.analyse(placed, reading);
    const recap = callRecapResponseSchema.parse(await readDailyRecap(world.salesperson()));
    expect(recap.callsAnalysed).toBe(before + 1);
    expect(recap.objections.find(entry => entry.category === 'has_solution')?.quotes.map(quote => quote.quote)).toContain('we already use AppFolio');

    // Another business date does not see it: the scope is the day.
    const yesterday = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const other = await readDailyRecap(world.salesperson(), { date: yesterday });
    expect(other.callsAnalysed).toBe(0);
    expect(other.smallSample).toBe(true);
  });
});
