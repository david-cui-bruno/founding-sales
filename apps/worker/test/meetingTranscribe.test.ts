import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { meetingProcessingFixture, accountId, jobPrefix } from '@fss/domain/test/meetings/support/meetingProcessingFixture.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { enqueueJob } from '@fss/domain/jobs/jobStore.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { scheduleMeetingTranscriptions } from '@fss/domain/meetings/transcriptionJobs.ts';
import type { MeetingTranscriptionProvider } from '@fss/domain/meetings/transcriptionTypes.ts';
import { meetingTranscribeJobHandler } from '../src/handlers/meetingTranscribe.ts';
import { readMeetingTranscriptionComposition, registerHandlers, workerDueWorkSources, workerSourceFlags } from '../src/bootstrap/main.ts';
import { runOnce } from '../src/runner/jobRunner.ts';

describe('meeting worker through the actual chunked runner', () => {
  let f: Awaited<ReturnType<typeof meetingProcessingFixture>>;
  beforeEach(async () => { f = await meetingProcessingFixture(); }); afterEach(async () => { await f.db.drop(); });
  async function setup(mode: 'normal' | 'disable_during_prepare' = 'normal') {
    const recordingId = await f.recording(await f.meeting()); let starts = 0, preparations = 0;
    const provider: MeetingTranscriptionProvider = {
      async start() { starts++; return 'ambiguous'; },
      async collect() { return { kind: 'complete', language: 'en-US', utterances: [] }; },
    };
    const options = { accountId, jobPrefix, provider, preparer: { async prepare(input: { preparedKey: string }) {
      preparations++; if (mode === 'disable_during_prepare') await f.configure({ enabled: false });
      return { inputKey: input.preparedKey, durationMs: 1200000, sizeBytes: 400, sha256: 'a'.repeat(64), mediaFormat: 'flac' as const };
    } } };
    return { recordingId, options, starts: () => starts, preparations: () => preparations };
  }
  it('a lost Start response and a fresh worker collect one durable paid job', async () => {
    const s = await setup(); const registry = new HandlerRegistry().register(meetingTranscribeJobHandler(s.options));
    const first = await runOnce(f.db.session, { registry, owner: 'meeting-one', limit: 5 });
    expect(first.failed).toBe(0); expect(s.starts()).toBe(1);
    await f.db.session.query("UPDATE meeting_transcription_attempts SET next_check_at=now()-interval '1 minute'");
    const at = (await f.db.session.query<{ at: string }>('SELECT clock_timestamp()::text AS at')).rows[0]!.at;
    await withTransaction(f.db.session, async () => { for (const job of await scheduleMeetingTranscriptions(f.db.session, at)) await enqueueJob(f.db.session, job); });
    const restart = new HandlerRegistry().register(meetingTranscribeJobHandler(s.options));
    expect((await runOnce(f.db.session, { registry: restart, owner: 'meeting-restart', limit: 5 })).failed).toBe(0);
    expect(s.starts()).toBe(1); expect(s.preparations()).toBe(1);
    expect((await f.db.session.query('SELECT id FROM meeting_transcripts')).rows).toHaveLength(1);
    expect((await f.db.session.query('SELECT state,settled_cents FROM provider_reservations')).rows).toEqual([{ state: 'estimated', settled_cents: 12 }]);
  });
  it('disablement while preparing makes zero paid calls', async () => {
    const s = await setup('disable_during_prepare'); const registry = new HandlerRegistry().register(meetingTranscribeJobHandler(s.options));
    expect((await runOnce(f.db.session, { registry, owner: 'meeting-stop', limit: 5 })).failed).toBe(0);
    expect(s.preparations()).toBe(1); expect(s.starts()).toBe(0);
    expect((await f.db.session.query('SELECT id FROM provider_reservations')).rows).toHaveLength(0);
  });
  it('composition registers the new handler and bounded source only with a known AWS account', async () => {
    const env = { FSS_CALL_AUDIO_BUCKET: 'test-audio', AWS_REGION: 'us-east-1', FSS_NAME_PREFIX: jobPrefix };
    expect(readMeetingTranscriptionComposition(env).options).toBeNull();
    expect(readMeetingTranscriptionComposition({ ...env, FSS_AWS_ACCOUNT_ID: accountId }).options).not.toBeNull();
    const s = await setup(); const composition = { classifier: undefined, mail: undefined, send: undefined, research: undefined, meetingTranscription: s.options };
    expect(registerHandlers(new HandlerRegistry(), composition).get('meeting.transcribe')).toBeDefined();
    expect(workerSourceFlags(composition).meetingTranscription).toBe(true);
    expect(workerDueWorkSources(workerSourceFlags(composition)).map(source => source.name)).toContain('meeting-transcription');
  });
  it('unverified funding makes zero preparation or paid calls', async () => {
    const s = await setup(); await f.configure({ creditCoverage: null });
    const registry = new HandlerRegistry().register(meetingTranscribeJobHandler(s.options));
    expect((await runOnce(f.db.session, { registry, owner: 'meeting-no-credit', limit: 5 })).failed).toBe(0);
    expect(s.preparations()).toBe(0); expect(s.starts()).toBe(0);
  });
});
