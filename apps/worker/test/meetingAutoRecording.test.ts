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
