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
  it('captures one exact owner-bound extraction successor in the original transcript transaction only when enabled',async()=>{
    await f.db.session.query("INSERT INTO crm_extraction_purposes(workspace_id,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,1,true,'fixture','fixture-v1','fixture-grant','fixture-handling',100,1000,1,1,$2)",[f.workspace,f.seeded.alpha.admin.userId]);
    const s=await setup();const registry=new HandlerRegistry().register(meetingTranscribeJobHandler(s.options));
    await runOnce(f.db.session,{registry,owner:'native-capture-first',limit:5});
    await f.db.session.query("UPDATE meeting_transcription_attempts SET next_check_at=now()-interval '1 minute'");
    const at=(await f.db.session.query<{at:string}>('SELECT clock_timestamp()::text AS at')).rows[0]!.at;
    await withTransaction(f.db.session,async()=>{for(const job of await scheduleMeetingTranscriptions(f.db.session,at))await enqueueJob(f.db.session,job);});
    expect((await runOnce(f.db.session,{registry,owner:'native-capture-finish',limit:5})).failed).toBe(0);
    const rows=(await f.db.session.query<{source_id:string;requested_by:string;source_hash:string;purpose_revision:number}>('SELECT source_id,requested_by,source_hash,purpose_revision FROM crm_extraction_generations WHERE workspace_id=$1',[f.workspace])).rows;
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({requested_by:f.seeded.alpha.salesperson.userId,purpose_revision:1,source_hash:'4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'});
    const jobs=(await f.db.session.query<{payload:unknown}>("SELECT payload FROM jobs WHERE workspace_id=$1 AND kind='crm.extract'",[f.workspace])).rows;
    expect(jobs).toHaveLength(1);expect(Object.keys(jobs[0]!.payload as object)).toEqual(['generationId']);
    await f.db.session.query('UPDATE firms SET assigned_user_id=$2 WHERE workspace_id=$1 AND id=$3',[f.workspace,f.seeded.alpha.admin.userId,f.firmId]);
    expect((await f.db.session.query('SELECT requested_by FROM crm_extraction_generations WHERE workspace_id=$1',[f.workspace])).rows).toEqual([{requested_by:f.seeded.alpha.salesperson.userId}]);
  });

  it('rolls native source capture back if its extraction successor intent cannot be recorded',async()=>{
    await f.db.session.query("INSERT INTO crm_extraction_purposes(workspace_id,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,1,true,'fixture','fixture-v1','fixture-grant','fixture-handling',100,1000,1,1,$2)",[f.workspace,f.seeded.alpha.admin.userId]);
    const s=await setup();const registry=new HandlerRegistry().register(meetingTranscribeJobHandler(s.options));await runOnce(f.db.session,{registry,owner:'native-rollback-first',limit:5});
    await f.db.session.query("UPDATE meeting_transcription_attempts SET next_check_at=now()-interval '1 minute'");
    const at=(await f.db.session.query<{at:string}>('SELECT clock_timestamp()::text AS at')).rows[0]!.at;await withTransaction(f.db.session,async()=>{for(const job of await scheduleMeetingTranscriptions(f.db.session,at))await enqueueJob(f.db.session,job);});
    await f.db.session.query("CREATE FUNCTION reject_fixture_extraction_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='crm.extract' THEN RAISE EXCEPTION 'controlled_intent_failure'; END IF; RETURN NEW; END $$");
    await f.db.session.query('CREATE TRIGGER reject_fixture_extraction_intent BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_fixture_extraction_intent()');
    expect((await runOnce(f.db.session,{registry,owner:'native-rollback-finish',limit:5})).failed).toBe(1);
    expect((await f.db.session.query('SELECT id FROM meeting_transcripts')).rows).toEqual([]);expect((await f.db.session.query('SELECT id FROM crm_extraction_generations')).rows).toEqual([]);expect(s.starts()).toBe(1);
  });

});
