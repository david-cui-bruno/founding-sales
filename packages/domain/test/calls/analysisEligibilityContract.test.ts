import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callAnalysisAdmission, callAnalysisEligibility, type CallAnalysisEligibility } from '../../calls/analysisEligibility.ts';
import { listOwedAnalyses, postCallModelPath } from '../../calls/analysisPaid.ts';
import { recordCallRecording, recordCallStatus } from '../../calls/sessions.ts';
import { listHeldTranscriptions } from '../../calls/transcription.ts';
import { withTransaction } from '../../db/queryable.ts';
import { enqueueJob } from '../../jobs/jobStore.ts';
import { jobIdempotencyKey } from '../../jobs/jobKinds.ts';
import { lines } from './analysisFixtures.ts';
import { createApplyWorld, type ApplyWorld, type PlacedCall } from './support/applyWorld.ts';

/**
 * Slice S3T, the contract check: one eligibility rule, and the real gates agree with it.
 *
 * Each row delivers a call through the real callbacks only (`recordCallStatus`,
 * `recordCallRecording`), in the row's order. Those run the real admission on every delivery:
 * the transcription enqueue, then the pending hold (`admitToAnalysisPath`). Then, on the facts
 * the row accumulated:
 *
 *   * held — a `call_analysis_pending` hold exists;
 *   * transcribed — a `call.transcribe` job exists (queued by the callbacks, nothing else);
 *   * resumable — `listHeldTranscriptions`, after the row's job is finished and the switch is
 *     written again, offers the call (its own SQL copy of the rule);
 *   * classifier — `callAnalysisAdmission`.
 *
 * On every row the four agree. The five named disagreement rows are the ones the hold and the
 * analysis path disagreed on before S3T (the probe at c3f97aa7); the recording-before-answer
 * row is review S3T's finding 2.
 */

const CALL = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', 'Sure, go ahead.']);

type Row = {
  readonly name: string;
  readonly statuses: { status: string; seconds?: number }[];
  readonly recordingSeconds: number | null;
  /** The recording is delivered before the statuses (default: after). */
  readonly recordingFirst?: boolean;
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
  {
    name: 'review S3T finding 2: the 25 s recording before the answer, then in-progress, then completed',
    statuses: answeredThen(25),
    recordingSeconds: 25,
    recordingFirst: true,
    transcription: true,
    expected: 'eligible',
  },
  {
    name: 'the 19 s recording before the answer',
    statuses: answeredThen(19),
    recordingSeconds: 19,
    recordingFirst: true,
    transcription: true,
    expected: 'excluded',
    reason: 'too_short',
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

  const status = async (call: PlacedCall, providerStatus: string, seconds?: number) =>
    await withTransaction(world.session, async () =>
      await recordCallStatus(world.session, { callSid: call.callSid, providerStatus, ...(seconds === undefined ? {} : { durationSeconds: seconds }) }),
    );
  const recording = async (call: PlacedCall, seconds: number) =>
    await withTransaction(world.session, async () =>
      await recordCallRecording(world.session, {
        callSid: call.callSid,
        recordingSid: `RE${'d'.repeat(32)}`,
        recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Recordings/RE${'d'.repeat(32)}`,
        durationSeconds: seconds,
      }),
    );
  const transcribeJobs = async (sessionId: string): Promise<number> =>
    (
      await world.session.query("SELECT 1 FROM jobs WHERE kind = 'call.transcribe' AND payload ->> 'callSessionId' = $1", [sessionId])
    ).rows.length;

  /** Whether the resumption source would offer the call once its (real or stand-in) job has finished. */
  const resumable = async (call: PlacedCall, transcription: boolean): Promise<boolean> => {
    // A call the callbacks did not queue gets a stand-in job, so the source's own copy of the
    // rule — not the absence of a job — is what decides.
    await enqueueJob(world.session, {
      workspaceId: world.seeded.alpha.workspaceId,
      kind: 'call.transcribe',
      idempotencyKey: jobIdempotencyKey.callTranscribe(call.sessionId),
      payload: { callSessionId: call.sessionId },
      maxAttempts: 3,
    });
    await world.session.query(
      "UPDATE jobs SET state = 'done', completed_at = now() - interval '1 minute', updated_at = now() - interval '1 minute' WHERE kind = 'call.transcribe' AND payload ->> 'callSessionId' = $1",
      [call.sessionId],
    );
    // The switch written again, after the job finished: what resumes held work.
    await world.setTranscription(transcription);
    return (await listHeldTranscriptions(world.session)).some(held => held.sessionId === call.sessionId);
  };

  for (const row of ROWS) {
    it(row.name, async () => {
      await world.setTranscription(row.transcription);
      const call = await world.placeCall(await world.newFirm(), CALL, { statuses: [], recordingSeconds: null, transcript: false });
      if (row.recordingFirst === true && row.recordingSeconds !== null) await recording(call, row.recordingSeconds);
      for (const delivery of row.statuses) await status(call, delivery.status, delivery.seconds);
      if (row.recordingFirst !== true && row.recordingSeconds !== null) await recording(call, row.recordingSeconds);

      const verdict = callAnalysisAdmission(await factsOf(call, row.transcription));
      const answers = {
        held: await held(call.sessionId),
        transcribed: (await transcribeJobs(call.sessionId)) === 1,
        classifier: verdict.kind === 'eligible',
      };
      const want = row.expected === 'eligible';
      expect(answers).toEqual({ held: want, transcribed: want, classifier: want });
      if (verdict.kind === 'excluded') expect(verdict.reason).toBe(row.reason);
      expect(await resumable(call, row.transcription)).toBe(want);
    });
  }

  it('after transcription, the analysis source offers exactly the calls the whole rule calls eligible', async () => {
    await world.setTranscription(true);
    const cases: { readonly provider: string; readonly model: string; readonly summary: boolean; readonly reason: string | null }[] = [
      { provider: 'aws_transcribe', model: 'standard', summary: false, reason: null },
      { provider: 'deepgram', model: 'nova-3', summary: false, reason: 'not_channel_labelled' },
      { provider: 'aws_transcribe', model: 'standard', summary: true, reason: 'summary_path' },
    ];
    for (const transcript of cases) {
      const call = await world.placeCall(await world.newFirm(), CALL, { transcript: false });
      await world.session.query(
        `INSERT INTO call_transcripts (workspace_id, call_session_id, provider, model, language, duration_seconds, utterances)
         VALUES ($1, $2, $3, $4, 'en-US', 125, $5::jsonb)`,
        [world.seeded.alpha.workspaceId, call.sessionId, transcript.provider, transcript.model, JSON.stringify(CALL)],
      );
      if (transcript.summary) {
        // An obligation started before 3a: a summarize job puts the call on the summary path.
        await enqueueJob(world.session, {
          workspaceId: world.seeded.alpha.workspaceId,
          kind: 'call.summarize',
          idempotencyKey: jobIdempotencyKey.callSummarize(call.sessionId),
          payload: { callSessionId: call.sessionId },
          maxAttempts: 3,
        });
      }
      const verdict = callAnalysisEligibility({
        ...(await factsOf(call, true)),
        transcript: transcript.provider === 'deepgram' ? 'not_channel_labelled' : 'channel_labelled',
        transcribeQueued: (await transcribeJobs(call.sessionId)) > 0,
        transcriptionFailed: false,
        summaryPath: (await postCallModelPath(world.session, world.seeded.alpha.workspaceId, call.sessionId)) === 'summary',
      });
      const offered = (await listOwedAnalyses(world.session, 500)).some(owed => owed.sessionId === call.sessionId);
      expect({ offered, eligible: verdict.kind === 'eligible' }).toEqual({ offered: transcript.reason === null, eligible: transcript.reason === null });
      if (verdict.kind === 'excluded') expect(verdict.reason).toBe(transcript.reason);
    }
  });
});
