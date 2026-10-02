import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueCallTranscription } from '../../calls/transcription.ts';
import { withTransaction } from '../../db/queryable.ts';
import { lines } from './analysisFixtures.ts';
import { createApplyWorld, type ApplyWorld } from './support/applyWorld.ts';

/**
 * S3T contract check (probe): the same session facts through the two real gates that decide
 * whether an answered call is held for review and whether it is transcribed (and so
 * analysed), and through the brief's reading of the eligibility rule.
 */

const CALL = lines(['Y', 'Hi Dana, this is David from Callie.'], ['T', 'Sure, go ahead.']);

type Row = {
  readonly name: string;
  readonly statuses: { status: string; seconds?: number }[];
  readonly recordingSeconds: number | null;
  readonly transcription: boolean;
};

const ROWS: Row[] = [
  { name: 'answered 125 s, recording 125 s', statuses: [{ status: 'in-progress' }, { status: 'completed', seconds: 125 }], recordingSeconds: 125, transcription: true },
  { name: 'answered 19 s, recording 19 s', statuses: [{ status: 'in-progress' }, { status: 'completed', seconds: 19 }], recordingSeconds: 19, transcription: true },
  { name: 'answered 20 s, recording 20 s', statuses: [{ status: 'in-progress' }, { status: 'completed', seconds: 20 }], recordingSeconds: 20, transcription: true },
  { name: 'no-answer', statuses: [{ status: 'no-answer', seconds: 30 }], recordingSeconds: null, transcription: true },
  { name: 'terminal completed with no in-progress, 25 s, recording 25 s', statuses: [{ status: 'completed', seconds: 25 }], recordingSeconds: 25, transcription: true },
  { name: 'answered, call 15 s, recording 25 s', statuses: [{ status: 'in-progress' }, { status: 'completed', seconds: 15 }], recordingSeconds: 25, transcription: true },
  { name: 'answered, call 25 s, recording 15 s', statuses: [{ status: 'in-progress' }, { status: 'completed', seconds: 25 }], recordingSeconds: 15, transcription: true },
  { name: 'answered, call 25 s, no recording', statuses: [{ status: 'in-progress' }, { status: 'completed', seconds: 25 }], recordingSeconds: null, transcription: true },
  { name: 'answered, not terminal, recording 25 s', statuses: [{ status: 'in-progress' }], recordingSeconds: 25, transcription: true },
  { name: 'transcription off', statuses: [{ status: 'in-progress' }, { status: 'completed', seconds: 125 }], recordingSeconds: 125, transcription: false },
];

describe('S3T contract probe: pending-hold admission vs transcription enqueue vs the brief rule', () => {
  let world: ApplyWorld;
  beforeAll(async () => {
    world = await createApplyWorld();
  });
  afterAll(async () => {
    await world.drop();
  });

  it('prints the table', async () => {
    const table: Record<string, unknown>[] = [];
    for (const row of ROWS) {
      await world.setTranscription(row.transcription);
      const call = await world.placeCall(await world.newFirm(), CALL, { statuses: row.statuses, recordingSeconds: row.recordingSeconds, transcript: false });
      const held = (
        await world.session.query("SELECT 1 FROM active_holds WHERE source_event_kind = 'call_analysis_pending' AND source_event_id = $1", [call.sessionId])
      ).rows.length > 0;
      const enqueue = await withTransaction(world.session, async () =>
        await enqueueCallTranscription(world.session, { workspaceId: world.seeded.alpha.workspaceId, sessionId: call.sessionId, keyConfigured: true }),
      );
      const { rows } = await world.session.query<{ status: string; provider_status: string | null; answered: boolean; seconds: number | null }>(
        `SELECT status, provider_status, answered_at IS NOT NULL AS answered, coalesce(duration_seconds, recording_duration_seconds) AS seconds
           FROM call_sessions WHERE id = $1`,
        [call.sessionId],
      );
      const f = rows[0]!;
      const brief =
        ['completed', 'failed', 'canceled'].includes(f.status) &&
        (f.answered || f.provider_status === 'completed') &&
        f.seconds !== null && Number(f.seconds) >= 20 &&
        row.transcription;
      table.push({ row: row.name, held, transcribed: enqueue.enqueued, brief });
    }
    console.table(table);
    expect(table.length).toBe(ROWS.length);
  });
});
