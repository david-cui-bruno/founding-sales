import {expect,it} from 'vitest';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {setupConversation} from './support/bookingConversationFixture.ts';

const stops=[{scope:'handle',channel:'email'},{scope:'handle',channel:'all'},{scope:'firm',channel:'all'}] as const;
for(const target of stops){
 it(`standing admission respects an existing ${target.scope}/${target.channel} booking opt-out`,async()=>{
  const f=await setupConversation();try{
   const stopped=await f.request('POST','/suppressions/record',f.command({...target,source:'prospect_opt_out',...(target.scope==='firm'?{firmId:f.firmId}:{value:'PROSPECT@booking.example'})}));
   expect(stopped.status,JSON.stringify(stopped.body)).toBe(200);
   await runOnce(f.db,{registry:f.registry,owner:'standing-stopped-admission',limit:20});
   await runOnce(f.db,{registry:f.registry,owner:'standing-stopped-create',limit:20});
   expect(f.providerCalls).toHaveLength(0);
   expect((await f.fixture.db.query('SELECT id FROM booking_create_submissions WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);
  }finally{await f.fixture.stop();}
 });
 it(`standing create refuses a ${target.scope}/${target.channel} opt-out committed during availability`,async()=>{
  const f=await setupConversation();try{
   await runOnce(f.db,{registry:f.registry,owner:'standing-admitted-before-stop',limit:20});
   const pending=(await f.fixture.db.query<{id:string}>('SELECT id FROM booking_create_submissions WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows;
   expect(pending).toHaveLength(1);
   f.runtime.provider.availability=async()=>{
    const stopped=await f.request('POST','/suppressions/record',f.command({...target,source:'prospect_opt_out',...(target.scope==='firm'?{firmId:f.firmId}:{value:'prospect@booking.example'})}));
    expect(stopped.status,JSON.stringify(stopped.body)).toBe(200);
    return {available:true,reason:null};
   };
   await runOnce(f.db,{registry:f.registry,owner:'standing-availability-stop',limit:20});
   expect(f.providerCalls).toHaveLength(0);
   expect((await f.request('GET',`/meetings/booking-create?submissionId=${pending[0]!.id}`)).body).toMatchObject({state:'failed',reason:target.scope==='firm'?'firm_suppressed':'handle_suppressed',dispatchStartedAt:null});
   expect((await f.fixture.db.query('SELECT id FROM meetings WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);
  }finally{await f.fixture.stop();}
 });
}
it('standing email booking keeps phone-only and unrelated-handle suppression independent',async()=>{
 const f=await setupConversation();try{
  expect((await f.request('POST','/suppressions/record',f.command({scope:'firm',channel:'phone',source:'prospect_opt_out',firmId:f.firmId}))).status).toBe(200);
  expect((await f.request('POST','/suppressions/record',f.command({scope:'handle',channel:'all',source:'prospect_opt_out',value:'unrelated@booking.example'}))).status).toBe(200);
  await runOnce(f.db,{registry:f.registry,owner:'standing-unrelated-stops',limit:20});
  await runOnce(f.db,{registry:f.registry,owner:'standing-unrelated-create',limit:20});
  expect(f.providerCalls).toHaveLength(1);
  expect((await f.request('GET',`/meetings/booking-conversation?conversationId=${f.conversationId}`)).body).toMatchObject({state:'booked',origin:'standing_policy',enabled:false,booking:{state:'accepted'}});
 }finally{await f.fixture.stop();}
});
