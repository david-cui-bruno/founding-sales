import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {recordHeartbeat} from '@fss/domain/jobs/heartbeats.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {scheduleMeetingRecordingSetup} from '@fss/domain/meetings/autoRecordingJobs.ts';
import {enqueueJob,claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {meetingAutoRecordingJobHandler} from '../../worker/src/handlers/meetingAutoRecording.ts';
import {runClaimedJob} from '../../worker/src/runner/jobRunner.ts';
import {zoomMeetingsClient} from '../../worker/src/zoom/meetingsClient.ts';
import {calcomDemoClient} from '../../worker/src/calcom/bookingClient.ts';
import type {ProviderHttp} from '../../worker/src/providers/boundedHttp.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedContact,seedFirm} from './support/crmSeed.ts';
import {startIntegrationServer} from './support/integrationServer.ts';
it('booking_to_setup_to_readback: narrow identity, lifecycle and uncertain response',async()=>{
  const f=await createAuthFixture(),server=await startIntegrationServer(f);
  try{
    const token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
    const api=async(path:string,body?:unknown)=>{
      const res=await fetch(`${server.origin}${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:res.status,body:await res.json() as Record<string,unknown>};
    };
    const command=(extra:Record<string,unknown>)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...extra});
    const setting=async(key:string,value:unknown)=>expect((await api('/settings/update',command({settingKey:key,value}))).status).toBe(200);
    await setting('calendar_integration',{integration:'calcom'});
    await recordHeartbeat(f.db,{component:'worker',instanceKey:'integration',detail:{meeting_recording_setup:true}});
    await setting('meeting_auto_recording',{enabled:true,hostEmail:'host@example.com',calcomEventTypeId:42});
    const firmId=await seedFirm(f,{name:'Demo partner',regionCode:'TX',assignedUserId:f.alpha.admin.userId}),contactId=await seedContact(f,{firmId,fullName:'Partner'});
    expect((await api('/contacts/routes/add',command({firmId,contactId,routeKind:'email',value:'pm@example.com',source:'salesperson',technicalValidation:'passed',associationConfidence:1}))).status).toBe(200);
    const controls=async()=>({settings:(await f.db.query("SELECT setting_key,value FROM workspace_settings WHERE setting_key<>'meeting_auto_recording' AND superseded_at IS NULL ORDER BY workspace_id,setting_key")).rows,domains:(await f.db.query('SELECT id,automated_sending_enabled FROM sending_domains ORDER BY id')).rows});
    const before=await controls(),patches:{id:string;body:unknown}[]=[],modes=new Map<string,string>();
    let uid='demo-integration-1',zoomId='12345678901',eventId=42,startsAt=new Date(Date.now()+86400000).toISOString(),endsAt=new Date(Date.parse(startsAt)+1800000).toISOString(),tick=Date.now(),losePatch=false;
    const http:ProviderHttp=async(url,init)=>{
      const address=new URL(String(url));
      if(address.hostname==='zoom.us')return Response.json({access_token:'test-token',expires_in:3600});
      if(address.hostname==='api.cal.com')return Response.json({status:'success',data:{uid,eventTypeId:eventId,status:'accepted',hosts:[{email:'host@example.com'}],attendees:[{email:'pm@example.com'}],start:startsAt,end:endsAt,duration:30,location:`https://zoom.us/j/${zoomId}`}});
      expect(address.pathname).toBe(`/v2/meetings/${zoomId}`);
      if(init.method==='PATCH'){
        patches.push({id:zoomId,body:JSON.parse(String(init.body)) as unknown});modes.set(zoomId,'local');
        if(losePatch){losePatch=false;throw new Error('lost_after_effect');}return new Response(null,{status:204});
      }
      return Response.json({id:Number(zoomId),host_email:'host@example.com',type:2,start_time:startsAt,duration:30,settings:{use_pmi:false,auto_recording:modes.get(zoomId)??'none'}});
    };
    const registry=new HandlerRegistry().register(meetingAutoRecordingJobHandler({calcom:calcomDemoClient({apiKey:'test',http}),zoom:zoomMeetingsClient({accountId:'test',clientId:'test',clientSecret:'test',http})}));
    const webhook=async(trigger='BOOKING_CREATED',extra:Record<string,unknown>={})=>{
      const raw=JSON.stringify({triggerEvent:trigger,createdAt:new Date(++tick).toISOString(),payload:{uid,startTime:startsAt,endTime:endsAt,organizer:{email:'host@example.com'},attendees:[{email:'pm@example.com'}],location:`https://zoom.us/j/${zoomId}`,...extra}});
      const res=await fetch(`${server.origin}/integrations/calcom/webhook`,{method:'POST',headers:{'content-type':'application/json','x-cal-signature-256':server.calcomSign(Buffer.from(raw))},body:raw});expect(res.status).toBe(200);
      return (await f.db.query<{id:string}>('SELECT id FROM meetings WHERE current_booking_uid=$1',[uid])).rows[0]!.id;
    };
    const work=async()=>{
      await withTransaction(f.db,async()=>{for(const job of await scheduleMeetingRecordingSetup(f.db,new Date().toISOString(),{providerConfigured:true}))await enqueueJob(f.db,job);});
      for(const job of await claimJobs(f.db,{owner:'integration',kinds:['meeting.recording_setup'],limit:20,leaseSeconds:90}))expect(await runClaimedJob(f.db,{registry,job})).toBe('completed');
    };
    const read=async(id:string)=>(await api(`/meetings/recording-setup?meetingId=${id}`)).body;
    const id=await webhook();await work();expect(await read(id)).toMatchObject({state:'ready'});expect(patches).toEqual([{id:zoomId,body:{settings:{auto_recording:'local'}}}]);
    // Same Zoom ID: preserve a manual disable, even after reschedule. A deliberate retry can reapply.
    modes.set(zoomId,'none');const previous=uid;uid='demo-integration-2';startsAt=new Date(Date.parse(startsAt)+3600000).toISOString();endsAt=new Date(Date.parse(endsAt)+3600000).toISOString();
    await webhook('BOOKING_RESCHEDULED',{rescheduleUid:previous});await work();const manual=await read(id);expect(manual).toMatchObject({state:'manual',reason:'manual_override'});expect(patches).toHaveLength(1);
    const retry=command({meetingId:id,expectedVersion:manual['version']});expect((await api('/meetings/recording-setup/retry',retry)).status).toBe(200);expect((await api('/meetings/recording-setup/retry',retry)).body).toMatchObject({replayed:true});
    losePatch=true;await work();expect(await read(id)).toMatchObject({state:'ready'});expect(patches).toHaveLength(2);
    // New ID gets fresh validation; non-demo evidence must never authorize PATCH.
    const prev=uid;uid='demo-integration-3';zoomId='12345678902';eventId=99;await webhook('BOOKING_RESCHEDULED',{rescheduleUid:prev});await work();expect(await read(id)).toMatchObject({state:'manual',reason:'booking_mismatch'});expect(patches).toHaveLength(2);
    uid='cancelled-demo';zoomId='12345678903';eventId=42;const cancelled=await webhook();await webhook('BOOKING_CANCELLED');await work();expect((await read(cancelled))['state']).not.toBe('ready');expect(patches).toHaveLength(2);
    uid='disabled-demo';zoomId='12345678904';await webhook();await setting('meeting_auto_recording',{enabled:false,hostEmail:'host@example.com',calcomEventTypeId:42});await work();expect(patches).toHaveLength(2);
    expect(await controls()).toEqual(before);
  }finally{await server.close();await f.stop();}
});
