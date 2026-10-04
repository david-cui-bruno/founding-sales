import { expect,it } from 'vitest';
import { meetingAutoRecordingFixture } from '@fss/domain/test/meetings/support/meetingAutoRecordingFixture.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { meetingAutoRecordingJobHandler } from '../src/handlers/meetingAutoRecording.ts';
import { runClaimedJob } from '../src/runner/jobRunner.ts';
it('uses the real external-effect runner and records verified success',async()=>{
  const f=await meetingAutoRecordingFixture();try{
    const registry=new HandlerRegistry().register(meetingAutoRecordingJobHandler({calcom:f.calcom,zoom:f.zoom}));
    expect(await runClaimedJob(f.db.session,{registry,job:await f.claim()})).toBe('completed');
    expect(f.patches()).toBe(1);expect(await f.read()).toMatchObject({state:'ready'});
  }finally{await f.db.drop();}
});
it('a crash before reservation is still bounded by the persisted first claim',async()=>{
  const f=await meetingAutoRecordingFixture();try{
    const registry=new HandlerRegistry().register({kind:'meeting.recording_setup',protection:'outbound_fence',maxAttempts:4,leaseSeconds:90,async handle(){throw new Error('before_reservation');}});
    expect(await runClaimedJob(f.db.session,{registry,job:await f.claim()})).toBe('retryable');
    await f.db.session.query("UPDATE jobs SET first_claimed_at=now()-interval '3 hours'");
    const {scheduleMeetingRecordingSetup}=await import('@fss/domain/meetings/autoRecordingJobs.ts');
    const {withTransaction}=await import('@fss/domain/db/queryable.ts');
    expect(await withTransaction(f.db.session,()=>scheduleMeetingRecordingSetup(f.db.session,new Date().toISOString(),{providerConfigured:true}))).toEqual([]);
    expect(await f.read()).toMatchObject({state:'manual',reason:'expired'});expect(f.patches()).toBe(0);
  }finally{await f.db.drop();}
});
