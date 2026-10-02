import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALL_PROPOSAL_CORRECTED_ACTION } from '@fss/contracts';
import { applyCallProposals } from '../../calls/proposalApply.ts';
import { readProposalAcceptance } from '../../calls/proposalMeasure.ts';
import { readCallLogCorrections } from '../../calls/sessions.ts';
import { readCallTrial } from '../../calls/trialReport.ts';
import { withTransaction } from '../../db/queryable.ts';
import { listCallLogs } from '../../dial/calls.ts';
import { recordAdminSupersession } from '../../suppression/events.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { answer, lines } from './analysisFixtures.ts';
import { apply, createApplyWorld, type Analysed, type ApplyWorld } from './support/applyWorld.ts';
import { callbackFields, correct, david, keepAll, logFormCall, logPlacedCall, preview, undoAll } from './support/correctionWorld.ts';

/**
 * S3X lane X2 — provenance, history and the trial hook (DESIGN-S3X §3.1, §3.7, §3.8).
 *
 *   * X2-5: history — after two corrections the original is visible with who and when;
 *   * X2-6: the trial rows for `original_error` and `new_information`; the original decision
 *     row untouched; `/calls/proposals/acceptance` unchanged;
 *   * X2-8: stops an earlier correction wrote are offered by a later one, and a stop
 *     superseded since the preview is `effects_changed` (S3XD 2);
 *   * X2-11: the reason rule by exact effect id (RESET D), including S3XDF 6's sequence.
 */

const CALLBACK_CALL = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', 'Call me back Thursday at 2.']);
const CALLBACK_READING = answer({
  summary: 'Dana asked to be called back Thursday at 2.',
  interest: { level: 'curious', signals: [] },
  callback: { requested: true, exact: true, phrase: 'Call me back Thursday at 2', line: 2, agreed_line: 0, day: 'thursday', date_text: 'Thursday', time: '2' },
});
const SOFT_NO = lines(['Y', 'Hi Dana, this is David from Callie.'], ["T", "We just signed with another vendor, so we're not looking right now."]);
const SOFT_READING = answer({
  summary: 'Dana declined for now.',
  interest: { level: 'not_interested', signals: [] },
  objections: [{ category: 'has_solution', quote: 'We just signed with another vendor', line: 2, answered_line: 0 }],
});
const STOP_CALL = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', 'Please stop calling this number.']);
const STOP_READING = answer({
  summary: 'Dana asked not to be called again.',
  stop: { requested: true, scope: 'this_number', quote: 'Please stop calling this number.', line: 2 },
});

describe('X2: provenance, history and the trial hook', () => {
  let world: ApplyWorld;

  beforeAll(async () => {
    world = await createApplyWorld();
  });
  afterAll(async () => {
    await world.drop();
  });

  const correctedRows = async (analysisId: string) =>
    (
      await world.session.query<{ detail: Record<string, unknown> }>(
        'SELECT detail FROM audit_events WHERE action = $1 AND subject_id = $2 ORDER BY occurred_at, id',
        [CALL_PROPOSAL_CORRECTED_ACTION, analysisId],
      )
    ).rows.map(row => row.detail);

  async function analysedCall(utterances = CALLBACK_CALL, reading = CALLBACK_READING): Promise<Analysed> {
    return await world.analyse(await world.placeCall(await world.newFirm(), utterances), reading);
  }

  // ---------------------------------------------------------------------------------------
  // X2-11
  // ---------------------------------------------------------------------------------------

  describe('X2-11: the reason rule, by exact effect id', () => {
    it('a manually logged outcome, then Apply callback A: undoing A needs a reason and writes one (analysis, callback) row; keeping A needs none', async () => {
      const call = await analysedCall();
      const logId = await logPlacedCall(world, call, 'interested');
      const applied = await apply(world, call, ['callback']);
      expect(applied.ok, JSON.stringify(applied)).toBe(true);
      const callbackA = applied.ok ? applied.value.results[0]?.id : null;
      const shown = await preview(world, logId, 'no_answer');
      // The form bypassed the outcome suggestion: the outcome has no applied key.
      expect(shown.outcomeAppliedKey).toBeNull();
      expect(shown.effects.find(effect => effect.kind === 'callback')).toMatchObject({ id: callbackA, appliedKey: { analysisId: call.analysisId, key: 'callback' } });
      expect(await correct(world, logId, 'no_answer', { decide: undoAll })).toEqual({ ok: false, reason: 'reason_required' });
      const corrected = await correct(world, logId, 'no_answer', { decide: undoAll, reason: 'new_information' });
      expect(corrected.ok, JSON.stringify(corrected)).toBe(true);
      expect(await correctedRows(call.analysisId)).toEqual([
        expect.objectContaining({ key: 'callback', reason: 'new_information', correctedFrom: callbackA, correctedTo: 'undone', priorResult: 'unchanged', callLogId: logId }),
      ]);

      // S3XDF 6: the correction back to callback_requested creates B, which no suggestion made.
      const shownBack = await preview(world, logId, 'callback_requested');
      expect(shownBack.callbackTimeRequired).toBe(true);
      const back = await correct(world, logId, 'callback_requested', { callback: callbackFields() });
      expect(back.ok, JSON.stringify(back)).toBe(true);
      const callbackB = back.ok ? back.value.applied.callbackId : null;
      expect(callbackB).not.toBe(callbackA);
      const shownB = await preview(world, logId, 'not_interested');
      expect(shownB.effects.find(effect => effect.kind === 'callback' && effect.conflicts)).toMatchObject({ id: callbackB, appliedKey: null });
      // Undoing B needs no reason, and writes nothing for A's pair.
      const undoneB = await correct(world, logId, 'not_interested', { decide: undoAll });
      expect(undoneB.ok, JSON.stringify(undoneB)).toBe(true);
      expect(await correctedRows(call.analysisId)).toHaveLength(1);
    });

    it('keeping an applied callback needs no reason, and a reason that is not needed is refused', async () => {
      const call = await analysedCall();
      const logId = await logPlacedCall(world, call, 'interested');
      expect((await apply(world, call, ['callback'])).ok).toBe(true);
      expect(await correct(world, logId, 'no_answer', { decide: keepAll, reason: 'original_error' })).toEqual({ ok: false, reason: 'invalid_input' });
      const kept = await correct(world, logId, 'no_answer', { decide: keepAll });
      expect(kept.ok, JSON.stringify(kept)).toBe(true);
      expect(await correctedRows(call.analysisId)).toEqual([]);
    });

    it('a decision row without effectIds (an older row): only the outcome counts', async () => {
      const call = await analysedCall();
      const applied = await apply(world, call, ['outcome', 'callback']);
      expect(applied.ok, JSON.stringify(applied)).toBe(true);
      const logId = applied.ok ? (applied.value.callLogId ?? '') : '';
      // As written before X2: no `effectIds` (the superuser may; the application roles may not).
      await world.session.query("UPDATE audit_events SET detail = detail - 'effectIds' WHERE action = 'call.proposal_decided' AND subject_id = $1", [call.analysisId]);
      const shown = await preview(world, logId, 'not_interested');
      expect(shown.outcomeAppliedKey).toEqual({ analysisId: call.analysisId, key: 'outcome' });
      expect(shown.effects.find(effect => effect.kind === 'callback')?.appliedKey).toBeNull();
      const corrected = await correct(world, logId, 'not_interested', { decide: undoAll, reason: 'original_error' });
      expect(corrected.ok, JSON.stringify(corrected)).toBe(true);
      expect((await correctedRows(call.analysisId)).map(row => [row['key'], row['correctedFrom'], row['correctedTo']])).toEqual([
        ['outcome', 'callback_requested', 'not_interested'],
      ]);
    });

    it('"Lift stop…" plus the changed outcome write one (analysis, outcome) row', async () => {
      const call = await world.analyse(await world.placeCall(await world.newFirm(), STOP_CALL), STOP_READING);
      const applied = await withTransaction(world.session, async () =>
        await applyCallProposals(david(world), {
          analysisId: call.analysisId,
          transcriptSha256: call.transcriptSha256,
          proposalHash: call.proposalHash,
          keys: ['outcome'],
          commandId: `apply-${randomUUID()}`,
          journal: recordingSuppressionJournal(),
        }),
      );
      expect(applied.ok, JSON.stringify(applied)).toBe(true);
      const logId = applied.ok ? (applied.value.callLogId ?? '') : '';
      const shown = await preview(world, logId, 'interested', david(world));
      expect(shown.effects.find(effect => effect.kind === 'stop')).toMatchObject({ appliedKey: { analysisId: call.analysisId, key: 'outcome' }, decisions: ['keep', 'lift'] });
      const corrected = await correct(world, logId, 'interested', { decide: undoAll, reason: 'original_error', context: db => david(world, db) });
      expect(corrected.ok, JSON.stringify(corrected)).toBe(true);
      expect((await correctedRows(call.analysisId)).map(row => [row['key'], row['correctedFrom'], row['correctedTo'], row['type']])).toEqual([
        ['outcome', 'do_not_call', 'interested', 'stop'],
      ]);
    });
  });

  // ---------------------------------------------------------------------------------------
  // X2-6
  // ---------------------------------------------------------------------------------------

  it('X2-6: original_error and new_information rows; the decision row untouched; the acceptance read unchanged; the trial counts them', async () => {
    const wrong = await analysedCall(SOFT_NO, SOFT_READING);
    const later = await analysedCall(SOFT_NO, SOFT_READING);
    const logs: string[] = [];
    for (const call of [wrong, later]) {
      const applied = await apply(world, call, ['outcome']);
      expect(applied.ok, JSON.stringify(applied)).toBe(true);
      logs.push(applied.ok ? (applied.value.callLogId ?? '') : '');
    }
    const decisionRows = async () =>
      (await world.session.query("SELECT id, detail, occurred_at FROM audit_events WHERE action = 'call.proposal_decided' ORDER BY id")).rows;
    const before = await decisionRows();
    const acceptanceBefore = await readProposalAcceptance(world.salesperson());

    expect((await correct(world, logs[0] ?? '', 'interested', { reason: 'original_error' })).ok).toBe(true);
    expect((await correct(world, logs[1] ?? '', 'interested', { reason: 'new_information' })).ok).toBe(true);

    expect(await correctedRows(wrong.analysisId)).toEqual([
      expect.objectContaining({ key: 'outcome', reason: 'original_error', priorResult: 'unchanged', type: 'outcome:not_interested', correctedFrom: 'not_interested', correctedTo: 'interested' }),
    ]);
    expect(await correctedRows(later.analysisId)).toEqual([expect.objectContaining({ key: 'outcome', reason: 'new_information' })]);
    expect(await decisionRows()).toEqual(before);
    expect(await readProposalAcceptance(world.salesperson())).toEqual(acceptanceBefore);
    const trial = await readCallTrial(world.salesperson(), { since: '2026-01-01T00:00:00.000Z' });
    expect(trial.types.find(type => type.type === 'outcome:not_interested')).toMatchObject({ correctedOriginalError: 1, correctedNewInformation: 1 });
  });

  // ---------------------------------------------------------------------------------------
  // X2-5
  // ---------------------------------------------------------------------------------------

  it('X2-5: after two corrections the original is visible with who and when', async () => {
    const firm = await world.newFirm();
    const logId = await logFormCall(world, firm, 'no_answer');
    const { rows: original } = await world.session.query<{ actor_user_id: string; recorded_at: Date }>('SELECT actor_user_id, recorded_at FROM call_logs WHERE id = $1', [logId]);
    expect((await correct(world, logId, 'interested')).ok).toBe(true);
    expect((await correct(world, logId, 'not_interested')).ok).toBe(true);
    const corrections = (await readCallLogCorrections(world.salesperson(), [logId])).get(logId) ?? [];
    expect(corrections.map(entry => [entry.from, entry.to, entry.byUserId, entry.reason])).toEqual([
      ['no_answer', 'interested', world.seeded.alpha.salesperson.userId, null],
      ['interested', 'not_interested', world.seeded.alpha.salesperson.userId, null],
    ]);
    expect(corrections.every(entry => Number.isFinite(Date.parse(entry.at)))).toBe(true);
    const [row] = await listCallLogs(world.salesperson(), { firmId: firm.firmId });
    expect(row).toMatchObject({ id: logId, outcome: 'not_interested', actorUserId: original[0]?.actor_user_id, direction: 'outbound', callSessionId: null });
    // The `call.logged` row and the log's own actor and time still say what happened first.
    const { rows: logged } = await world.session.query<{ outcome: string }>("SELECT detail->>'outcome' AS outcome FROM audit_events WHERE action = 'call.logged' AND subject_id = $1", [logId]);
    expect(logged).toEqual([{ outcome: 'no_answer' }]);
    const { rows: after } = await world.session.query<{ recorded_at: Date }>('SELECT recorded_at FROM call_logs WHERE id = $1', [logId]);
    expect(after[0]?.recorded_at.toISOString()).toBe(original[0]?.recorded_at.toISOString());
    expect((await preview(world, logId, 'interested')).originalOutcome).toBe('no_answer');
  });

  // ---------------------------------------------------------------------------------------
  // X2-8
  // ---------------------------------------------------------------------------------------

  it('X2-8: a stop an earlier correction wrote is Keep stop / Lift stop… later; superseded since the preview, it is effects_changed', async () => {
    const firm = await world.newFirm();
    const logId = await logFormCall(world, firm, 'no_answer', {}, world.session, db => david(world, db));
    const first = await correct(world, logId, 'do_not_call', { context: db => david(world, db) });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const [stopId] = first.ok ? first.value.applied.suppressionEventIds : [];
    const shown = await preview(world, logId, 'interested', david(world));
    expect(shown.effects.filter(effect => effect.kind === 'stop')).toEqual([
      expect.objectContaining({ id: stopId, conflicts: true, decisions: ['keep', 'lift'], appliedKey: null }),
    ]);
    const lifted = await withTransaction(world.session, async () =>
      await recordAdminSupersession(david(world), { eventId: stopId ?? '', reason: 'correction', commandId: `lift-${randomUUID()}`, journal: recordingSuppressionJournal() }),
    );
    expect(lifted.ok).toBe(true);
    expect(await correct(world, logId, 'interested', { shown, decide: keepAll, context: db => david(world, db) })).toEqual({ ok: false, reason: 'effects_changed' });
    expect((await preview(world, logId, 'interested', david(world))).effects.filter(effect => effect.kind === 'stop')).toEqual([]);
  });
});
