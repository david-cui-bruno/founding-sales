import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callAnalysisAdmission, callAnalysisEligibility, type CallAnalysisEligibility } from '../../calls/analysisEligibility.ts';
import { listOwedAnalyses } from '../../calls/analysisPaid.ts';
import { enqueueCallTranscription } from '../../calls/transcription.ts';
import { withTransaction } from '../../db/queryable.ts';
import { lines } from './analysisFixtures.ts';
import { createApplyWorld, type ApplyWorld, type PlacedCall } from './support/applyWorld.ts';

/**
 * Slice S3T, the contract check: one eligibility rule, and the real gates agree with it.
 *
 * Each row places a call through the real callbacks (`recordCallStatus`, then
 * `recordCallRecording`), which run the real pending-hold admission on every delivery. Then
 * the real transcription enqueue (`enqueueCallTranscription`, with a transcription worker up)
 * is asked about the same session, and `callAnalysisAdmission` is asked about the facts the
 * row accumulated. On every row: held == transcribed == the classifier.
 *
 * The five named rows are the ones the hold and the analysis path disagreed on before S3T
 * aligned the hold to the analysis path (the probe at c3f97aa7); with the old hold they fail.
 */

const CALL = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', 'Sure, go ahead.']);

type Row = {
  readonly name: string;
  readonly statuses: { status: string; seconds?: number }[];
  readonly recordingSeconds: number | null;
  readonly transcription: boolean;
  readonly expected: CallAnalysisEligibility['kind'];
  readonly reason?: string;
};

const answeredThen = (seconds: number): Row['statuses'] => [{ status: 'in-progress' }, { status: 'completed', seconds }];

const ROWS: Row[] = [
  { name: 'answered, 125 s, recording 125 s', statuses: answeredThen(125), recordingSeconds: 125, transcription: true, expected: 'eligible' },
  { name: 'answered, 19 s, recording 19 s', statuses: answeredThen(19), recordingSeconds: 19, transcription: true, expected: 'excluded', reason: 'too_short' },
  { name: 'answered, 20 s, recording 20 s', statuses: answeredThen(20), recordingSeconds: 20, transcription: true, expected: 'eligible' },
  { name: 'no-answer', statuses: [{ status: 'no-answer', seconds: 30 }], recordingSeconds: null, transcription: true, expected: 'excluded', reason: 'not_answered' },
  { name: 'busy', statuses: [{ status: 'busy' }], recordingSeconds: null, transcription: true, expected: 'excluded', reason: 'not_answered' },
  { name: 'transcription off', statuses: answeredThen(125), recordingSeconds: 125, transcription: false, expected: 'excluded', reason: 'transcription_off' },
  // The five rows the old hold disagreed on.
  {
    name: 'disagreement 1: a terminal `completed` with no `in-progress` (no answered_at), recording 25 s',
    statuses: [{ status: 'completed', seconds: 25 }],
    recordingSeconds: 25,
    transcription: true,
    expected: 'excluded',
    reason: 'answered_at_missing',
  },
  {
    name: 'disagreement 2: answered, call 15 s, recording 25 s',
    statuses: answeredThen(15),
    recordingSeconds: 25,
    transcription: true,
    expected: 'eligible',
  },
  {
    name: 'disagreement 3: answered, call 25 s, recording 15 s',
    statuses: answeredThen(25),
    recordingSeconds: 15,
    transcription: true,
    expected: 'excluded',
    reason: 'too_short',
  },
  {
    name: 'disagreement 4: answered, call 25 s, no recording',
    statuses: answeredThen(25),
    recordingSeconds: null,
    transcription: true,
    expected: 'excluded',
    reason: 'no_recording',
  },
  {
    name: 'disagreement 5: answered, not terminal yet, recording 25 s',
    statuses: [{ status: 'in-progress' }],
    recordingSeconds: 25,
    transcription: true,
    expected: 'eligible',
  },
];

describe('S3T contract: the hold, the transcription enqueue and the eligibility rule agree', () => {
  let world: ApplyWorld;
  beforeAll(async () => {
    world = await createApplyWorld();
  });
  afterAll(async () => {
    await world.drop();
  });

  const held = async (sessionId: string): Promise<boolean> =>
    (await world.session.query("SELECT 1 FROM active_holds WHERE source_event_kind = 'call_analysis_pending' AND source_event_id = $1", [sessionId])).rows
      .length > 0;

  const factsOf = async (call: PlacedCall, transcriptionOn: boolean) => {
    const { rows } = await world.session.query<{
      status: string;
      provider_status: string | null;
      answered: boolean;
      recording: boolean;
      recording_seconds: number | null;
    }>(
      `SELECT status, provider_status, answered_at IS NOT NULL AS answered, recording_path IS NOT NULL AS recording,
              recording_duration_seconds AS recording_seconds
         FROM call_sessions WHERE id = $1`,
      [call.sessionId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('no session');
    return {
      status: row.status,
      providerStatus: row.provider_status,
      answered: row.answered,
      recording: row.recording,
      recordingSeconds: row.recording_seconds === null ? null : Number(row.recording_seconds),
      transcriptionOn,
    };
  };

  for (const row of ROWS) {
    it(row.name, async () => {
      await world.setTranscription(row.transcription);
      const call = await world.placeCall(await world.newFirm(), CALL, { statuses: row.statuses, recordingSeconds: row.recordingSeconds, transcript: false });
      const enqueue = await withTransaction(world.session, async () =>
        await enqueueCallTranscription(world.session, { workspaceId: world.seeded.alpha.workspaceId, sessionId: call.sessionId, keyConfigured: true }),
      );
      const verdict = callAnalysisAdmission(await factsOf(call, row.transcription));
      const answers = { held: await held(call.sessionId), transcribed: enqueue.enqueued, classifier: verdict.kind === 'eligible' };
      const want = row.expected === 'eligible';
      expect(answers).toEqual({ held: want, transcribed: want, classifier: want });
      if (verdict.kind === 'excluded') expect(verdict.reason).toBe(row.reason);
    });
  }

  it('after transcription, the analysis source offers exactly the calls the whole rule calls eligible', async () => {
    await world.setTranscription(true);
    const cases: { readonly provider: string; readonly model: string; readonly labelled: boolean }[] = [
      { provider: 'aws_transcribe', model: 'standard', labelled: true },
      { provider: 'deepgram', model: 'nova-3', labelled: false },
    ];
    for (const transcript of cases) {
      const call = await world.placeCall(await world.newFirm(), CALL, { transcript: false });
      await world.session.query(
        `INSERT INTO call_transcripts (workspace_id, call_session_id, provider, model, language, duration_seconds, utterances)
         VALUES ($1, $2, $3, $4, 'en-US', 125, $5::jsonb)`,
        [world.seeded.alpha.workspaceId, call.sessionId, transcript.provider, transcript.model, JSON.stringify(CALL)],
      );
      const verdict = callAnalysisEligibility({
        ...(await factsOf(call, true)),
        transcript: transcript.labelled ? 'channel_labelled' : 'not_channel_labelled',
        transcribeQueued: false,
        transcriptionFailed: false,
        summaryPath: false,
      });
      const offered = (await listOwedAnalyses(world.session, 500)).some(owed => owed.sessionId === call.sessionId);
      expect({ offered, eligible: verdict.kind === 'eligible' }).toEqual({ offered: transcript.labelled, eligible: transcript.labelled });
      if (verdict.kind === 'excluded') expect(verdict.reason).toBe('not_channel_labelled');
    }
  });
});
