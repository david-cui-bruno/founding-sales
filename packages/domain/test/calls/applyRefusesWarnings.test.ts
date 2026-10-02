import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { taskKey } from '../../calls/analysisPolicy.ts';
import type * as Pipeline from '../../crm/pipeline.ts';
import { answer, lines } from './analysisFixtures.ts';
import { apply, createApplyWorld, refusedAt, type Analysed, type ApplyWorld } from './support/applyWorld.ts';

/**
 * Slice 3a, lane B — review S3BF: an Apply never keeps what the manual form keeps.
 *
 * `logCallOutcome` records history and downgrades what it could not do to warnings
 * (`callback_time_needed`, `effects_not_applied`): right for the form, wrong for an Apply,
 * whose click is atomic. So:
 *
 *   * the reviewer's trigger — outcome + callback + task, the callback's `dueAt` not the
 *     instant its date, time and zone name — is `callback_instant_mismatch` on `callback`,
 *     and nothing is written: no log, the pending hold still open, no callback, no task, no
 *     decision;
 *   * an effect the outcome's command could not apply (here `setManualControlMode` refused,
 *     injected) is `effects_not_applied` on `outcome`, and nothing is written.
 */

const manualMode = vi.hoisted(() => ({ refuse: false }));
vi.mock('../../crm/pipeline.ts', async importOriginal => {
  const original = await importOriginal<typeof Pipeline>();
  return {
    ...original,
    setManualControlMode: async (...args: Parameters<typeof original.setManualControlMode>) =>
      manualMode.refuse ? { ok: false as const, reason: 'invalid_input' as const } : await original.setManualControlMode(...args),
  };
});

const PROMISE = 'I will send you the pricing sheet today';
const CALL = lines(
  ['Y', 'Hi Dana, this is David from Callie.'],
  ['T', 'Sure. Can you show us a demo?'],
  ['Y', `Absolutely. ${PROMISE}.`],
  ['T', 'Call me back Thursday at 2.'],
);
const READING = answer({
  summary: 'You reached Dana. She asked for a demo and to be called back Thursday at 2.',
  interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'Can you show us a demo?', line: 2 }] },
  commitments: [{ speaker: 'you', quote: PROMISE, line: 3, due_phrase: 'today' }],
  callback: { requested: true, exact: true, phrase: 'Call me back Thursday at 2', line: 4, agreed_line: 0, day: 'thursday', date_text: 'Thursday', time: '2' },
});
const INTERESTED = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', 'Sure. Can you show us a demo?'], ['Y', `Absolutely. ${PROMISE}.`]);
const INTERESTED_READING = answer({
  summary: 'You reached Dana. She asked for a demo.',
  interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'Can you show us a demo?', line: 2 }] },
  commitments: [{ speaker: 'you', quote: PROMISE, line: 3, due_phrase: 'today' }],
});

describe('S3BF: an Apply refuses what the form would keep as a warning', () => {
  let world: ApplyWorld;

  beforeAll(async () => {
    world = await createApplyWorld();
    await world.setTranscription(true);
  });
  afterAll(async () => {
    await world.drop();
  });

  async function nothingWritten(call: Analysed): Promise<void> {
    const count = async (sql: string): Promise<number> => (await world.session.query(sql, [call.sessionId])).rows.length;
    expect(await count('SELECT 1 FROM call_sessions WHERE id = $1 AND call_log_id IS NOT NULL')).toBe(0);
    expect(await count('SELECT 1 FROM call_logs l JOIN call_sessions s ON s.ticket_id = l.ticket_id WHERE s.id = $1')).toBe(0);
    expect(await count('SELECT 1 FROM call_tasks WHERE call_session_id = $1')).toBe(0);
    expect(
      await count("SELECT 1 FROM active_holds WHERE source_event_kind = 'call_analysis_pending' AND source_event_id = $1::text AND released_at IS NULL"),
    ).toBe(1);
    const { rows } = await world.session.query("SELECT 1 FROM audit_events WHERE action = 'call.proposal_decided' AND subject_id = $1", [call.analysisId]);
    expect(rows).toHaveLength(0);
    const { rows: callbacks } = await world.session.query('SELECT 1 FROM callbacks WHERE firm_id = $1', [call.firm.firmId]);
    expect(callbacks).toHaveLength(0);
  }

  it("the reviewer's trigger: outcome + callback + task with a dueAt the callback's fields do not name is callback_instant_mismatch, and nothing is written", async () => {
    const call = await world.analyse(await world.placeCall(await world.newFirm(), CALL), READING);
    expect(call.keys).toEqual(expect.arrayContaining(['outcome', 'callback', taskKey(PROMISE)]));
    const result = await apply(world, call, ['outcome', 'callback', taskKey(PROMISE)], {
      // 10:00 in New York on 6 October is 14:00Z; 15:00Z is not that instant.
      edits: { callback: { localDate: '2026-10-06', localTime: '10:00', sourceTimeZone: 'America/New_York', dueAt: '2026-10-06T15:00:00Z' } },
    });
    expect(result).toEqual(refusedAt('callback_instant_mismatch', 'callback'));
    await nothingWritten(call);
  });

  it('an effect the outcome could not apply (setManualControlMode refused) is effects_not_applied, and nothing is written', async () => {
    const call = await world.analyse(await world.placeCall(await world.newFirm({ opportunity: 'open' }), INTERESTED), INTERESTED_READING);
    manualMode.refuse = true;
    try {
      const result = await apply(world, call, ['outcome', taskKey(PROMISE)]);
      expect(result).toEqual(refusedAt('effects_not_applied', 'outcome'));
    } finally {
      manualMode.refuse = false;
    }
    await nothingWritten(call);
    // And without the injection the same click applies.
    expect((await apply(world, call, ['outcome', taskKey(PROMISE)])).ok).toBe(true);
  });
});
