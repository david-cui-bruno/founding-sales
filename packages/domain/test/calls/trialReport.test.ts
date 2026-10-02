import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALL_PROPOSAL_CORRECTED_ACTION, callTrialResponseSchema, type CallTrialResponse } from '@fss/contracts';
import { createAnalysisVersion, failCallAnalysis } from '../../calls/analysis.ts';
import { declineCallProposals } from '../../calls/proposalMeasure.ts';
import { readCallTrial } from '../../calls/trialReport.ts';
import { withTransaction } from '../../db/queryable.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { answer, lines } from './analysisFixtures.ts';
import { apply, createApplyWorld, type Analysed, type ApplyWorld, type PlacedCall } from './support/applyWorld.ts';

/**
 * Slice S3T: `GET /calls/trial`, over real Postgres, through the real callbacks and writers.
 * Every placed call since `since` is counted somewhere: toward the trial, as unanswered, or
 * as answered-but-excluded with its reason. Nothing disappears.
 */

const SIGNAL_CALL = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', "We're evaluating tools. Can you show us a demo?"]);
const SIGNAL = answer({
  summary: 'You reached Dana. She asked for a demo.',
  interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'Can you show us a demo?', line: 2 }] },
});
const answeredThen = (seconds: number) => [{ status: 'in-progress' }, { status: 'completed', seconds }];

describe('the trial read', () => {
  let world: ApplyWorld;
  let since: string;
  let trial: CallTrialResponse;
  const placed: Partial<Record<'before' | 'twenty' | 'nineteen' | 'noAnswer' | 'busy' | 'providerOnly' | 'off' | 'failed', PlacedCall>> = {};
  let applied: Analysed;
  let bypassed: Analysed;

  const read = async (options: { since?: string } = {}) =>
    callTrialResponseSchema.parse(JSON.parse(JSON.stringify(await readCallTrial(world.salesperson(), { since: options.since ?? since }))));

  beforeAll(async () => {
    world = await createApplyWorld();
    await world.setTranscription(true);
    since = new Date(Date.now() - 60_000).toISOString();

    // Before `since`: never counted.
    placed.before = await world.placeCall(await world.newFirm(), SIGNAL_CALL, { transcript: false, recordingSeconds: 125 });
    await world.session.query(
      `UPDATE call_sessions SET answered_at = $2::timestamptz - interval '1 day', started_at = $2::timestamptz - interval '1 day',
              created_at = $2::timestamptz - interval '1 day' WHERE id = $1`,
      [placed.before.sessionId, since],
    );

    // Eligible and analysed: the outcome applied unchanged, the buying signal left unresolved.
    applied = await world.analyse(await world.placeCall(await world.newFirm(), SIGNAL_CALL), SIGNAL);
    const result = await apply(world, applied, ['outcome']);
    if (!result.ok) throw new Error(JSON.stringify(result));

    // Eligible and analysed: the buying signal declined, then the form logged: bypassed.
    bypassed = await world.analyse(await world.placeCall(await world.newFirm(), SIGNAL_CALL), SIGNAL);
    const declined = await withTransaction(world.session, async () =>
      await declineCallProposals(world.salesperson(), { analysisId: bypassed.analysisId, proposalHash: bypassed.proposalHash, keys: ['buying_signal'] }),
    );
    if (!declined.ok) throw new Error(JSON.stringify(declined));
    const logged = await withTransaction(world.session, async () =>
      await logCallOutcome(world.salesperson(), {
        firmId: bypassed.firm.firmId,
        callSessionId: bypassed.sessionId,
        outcome: 'interested',
        commandId: `trial-form-${bypassed.sessionId}`,
        journal: recordingSuppressionJournal(),
      }),
    );
    if (!logged.ok) throw new Error(JSON.stringify(logged));

    // Exactly 20 s: eligible, transcribed, not yet analysed (pending).
    placed.twenty = await world.placeCall(await world.newFirm(), SIGNAL_CALL, { statuses: answeredThen(20), recordingSeconds: 20 });
    // 19 s: too short.
    placed.nineteen = await world.placeCall(await world.newFirm(), SIGNAL_CALL, { statuses: answeredThen(19), recordingSeconds: 19, transcript: false });
    // Unanswered.
    placed.noAnswer = await world.placeCall(await world.newFirm(), SIGNAL_CALL, { statuses: [{ status: 'no-answer', seconds: 30 }], recordingSeconds: null, transcript: false });
    placed.busy = await world.placeCall(await world.newFirm(), SIGNAL_CALL, { statuses: [{ status: 'busy' }], recordingSeconds: null, transcript: false });
    // Answered by the provider's status only: no answered_at.
    placed.providerOnly = await world.placeCall(await world.newFirm(), SIGNAL_CALL, { statuses: [{ status: 'completed', seconds: 25 }], recordingSeconds: 25, transcript: false });
    // Transcription off when the call ended.
    await world.setTranscription(false);
    placed.off = await world.placeCall(await world.newFirm(), SIGNAL_CALL, { transcript: false });
    await world.setTranscription(true);
    // Eligible, analysis failed.
    placed.failed = await world.placeCall(await world.newFirm(), SIGNAL_CALL);
    const version = await withTransaction(world.session, async () =>
      await createAnalysisVersion(world.system(), { sessionId: placed.failed!.sessionId, origin: 'model', reason: 'transcript', model: 'claude-haiku-4-5-20251001' }),
    );
    if (version.kind !== 'created') throw new Error(version.kind);
    await withTransaction(world.session, async () => await failCallAnalysis(world.system(), { analysisId: version.analysisId, reason: 'refused' }));

    trial = await read();
  });
  afterAll(async () => {
    await world.drop();
  });

  it('progress: answered calls, the eligible ones, the analysed ones toward ten, and the fully decided', () => {
    // Answered: applied, bypassed, 20 s, 19 s, provider-only, off, failed.
    expect(trial.progress).toEqual({ answered: 7, eligible: 4, analysed: 2, fullyDecided: 1 });
    expect(trial).toMatchObject({ since, target: 10, minimumRecordingSeconds: 20, minimumDecided: 5 });
  });

  it('20 s counts, 19 s is excluded as too short with its duration', () => {
    const excluded = trial.excluded.sessions.find(row => row.callSessionId === placed.nineteen!.sessionId);
    expect(excluded).toMatchObject({ reason: 'too_short', recordingSeconds: 19, callSeconds: 19 });
    expect(trial.excluded.sessions.some(row => row.callSessionId === placed.twenty!.sessionId)).toBe(false);
  });

  it('unanswered calls are counted apart, by provider status', () => {
    expect(trial.unanswered).toEqual({
      total: 2,
      byProviderStatus: [
        { providerStatus: 'busy', count: 1 },
        { providerStatus: 'no-answer', count: 1 },
      ],
    });
    const ids = trial.excluded.sessions.map(row => row.callSessionId);
    expect(ids).not.toContain(placed.noAnswer!.sessionId);
  });

  it('answered-but-excluded calls are listed by reason: provider status only, transcription off, too short', () => {
    expect(trial.excluded.byReason).toEqual([
      { reason: 'answered_at_missing', count: 1 },
      { reason: 'too_short', count: 1 },
      { reason: 'transcription_off', count: 1 },
    ]);
    expect(trial.excluded.sessions.find(row => row.callSessionId === placed.providerOnly!.sessionId)).toMatchObject({
      reason: 'answered_at_missing',
      providerStatus: 'completed',
      recordingSeconds: 25,
    });
    expect(trial.excluded.sessions.find(row => row.callSessionId === placed.off!.sessionId)).toMatchObject({ reason: 'transcription_off' });
    for (const row of trial.excluded.sessions) expect(row.firmName).toMatch(/^Apply Test Firm /u);
  });

  it('analysis outcomes for the eligible calls: completed, failed with its reason, pending', () => {
    expect(trial.analysis).toEqual({ completed: 2, failed: 1, failedByReason: [{ reason: 'refused', count: 1 }], pending: 1, held: 0 });
  });

  it('the check line: no call is held for review that the analysis path excludes', () => {
    expect(trial.heldButExcluded).toBe(0);
  });

  it('per type: unchanged, bypassed, declined and unresolved, with the bar share and the apply sample', () => {
    const outcome = trial.types.find(type => type.type === 'outcome:interested');
    expect(outcome).toMatchObject({
      unchanged: 1,
      bypassed: 1,
      edited: 0,
      declined: 0,
      undecided: 0,
      acceptedUnchangedShare: 0.5,
      insufficient: true,
      correctedOriginalError: 0,
      correctedNewInformation: 0,
      applyMode: 2,
    });
    expect(outcome?.applySample).toMatchObject({ kind: 'outcome', mode: 'apply' });
    const signal = trial.types.find(type => type.type === 'buying_signal');
    expect(signal).toMatchObject({ declined: 1, undecided: 1, unchanged: 0, insufficient: true, acceptedUnchangedShare: 0 });
    expect(trial.incorrect).toEqual([
      expect.objectContaining({ analysisId: bypassed.analysisId, callSessionId: bypassed.sessionId, key: 'buying_signal', type: 'buying_signal', result: 'declined' }),
    ]);
  });

  it('corrections (a separate action): none means zero; an original error lowers the share among unchanged only; new information does not', async () => {
    // No `call.proposal_corrected` rows: zero everywhere (asserted above too).
    for (const type of trial.types) expect([type.correctedOriginalError, type.correctedNewInformation]).toEqual([0, 0]);
    const correction = async (shown: Analysed, key: string, reason: string) =>
      await world.session.query(
        `INSERT INTO audit_events (workspace_id, actor_kind, actor_user_id, action, subject_kind, subject_id, detail)
         VALUES ($1, 'user', $2, $3, 'call_analysis', $4, $5::jsonb)`,
        [
          world.seeded.alpha.workspaceId,
          world.seeded.alpha.salesperson.userId,
          CALL_PROPOSAL_CORRECTED_ACTION,
          shown.analysisId,
          JSON.stringify({ analysisId: shown.analysisId, key, reason, priorResult: 'unchanged', before: {}, after: {} }),
        ],
      );
    const outcome = async () => (await read()).types.find(type => type.type === 'outcome:interested');
    // New information on the unchanged outcome: recorded, not a model error.
    await correction(applied, 'outcome', 'new_information');
    expect(await outcome()).toMatchObject({ unchanged: 1, bypassed: 1, correctedOriginalError: 0, correctedNewInformation: 1, acceptedUnchangedShare: 0.5 });
    // An original error on the bypassed one: counted, but the share is of unchanged only.
    await correction(bypassed, 'outcome', 'original_error');
    expect(await outcome()).toMatchObject({ correctedOriginalError: 1, correctedNewInformation: 1, acceptedUnchangedShare: 0.5 });
    // An original error on the unchanged one too: that pair now counts once, as original_error.
    await correction(applied, 'outcome', 'original_error');
    expect(await outcome()).toMatchObject({ unchanged: 1, bypassed: 1, correctedOriginalError: 2, correctedNewInformation: 0, acceptedUnchangedShare: 0 });
    // A deal suggestion corrected for an original error is incorrect; the decline stays listed.
    await correction(bypassed, 'buying_signal', 'original_error');
    expect((await read()).incorrect.map(row => [row.key, row.result])).toEqual([
      ['buying_signal', 'declined'],
      ['buying_signal', 'corrected'],
    ]);
  });

  it('the since filter: a call before it is not counted anywhere; an earlier since counts it', async () => {
    const all = JSON.stringify(trial);
    expect(all).not.toContain(placed.before!.sessionId);
    const earlier = await read({ since: new Date(Date.parse(since) - 2 * 86_400_000).toISOString() });
    // It was answered with a 125 s recording and has no transcript: transcription never took it.
    expect(earlier.progress.answered).toBe(trial.progress.answered + 1);
  });

  it('defaults since to the 3a release', async () => {
    const read3a = callTrialResponseSchema.parse(await readCallTrial(world.salesperson()));
    expect(read3a.since).toBe('2026-10-02T07:14:00.000Z');
  });
});
