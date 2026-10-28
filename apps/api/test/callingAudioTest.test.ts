import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {audioTestExecutionReceiptSchema} from '@fss/contracts';
import {payloadHashOf} from '../src/auth/tokens.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {PUBLIC_ORIGIN,startIntegrationServer,type IntegrationServer} from './support/integrationServer.ts';
let f:AuthFixture,server:IntegrationServer,admin:Awaited<ReturnType<typeof issueSessionFor>>,sales:Awaited<ReturnType<typeof issueSessionFor>>,identityId:string,closed=true;
async function stop(){if(closed)return;closed=true;try{await server?.close();}finally{await f?.stop();}}
const phone='+14015550198';
async function post(path:string,body:unknown,token=admin.accessToken){const response=await fetch(`${server.origin}${path}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as Record<string,unknown>};}
const command=<T extends Record<string,unknown>>(input:T)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...input});
const input=()=>command({e164:phone,callingIdentityId:identityId});
const receipt=(body:ReturnType<typeof input>)=>({commandId:body.commandId,payloadSHA256:payloadHashOf({e164:body['e164'],callingIdentityId:body['callingIdentityId']})});
async function webhook(path:string,params:Record<string,string>){const response=await fetch(`${server.origin}${path}`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','x-twilio-signature':server.twilioSign(`${PUBLIC_ORIGIN}${path}`,params)},body:new URLSearchParams(params).toString()});return {status:response.status,text:await response.text()};}
const sid=()=>`CA${randomUUID().replaceAll('-','')}`;
async function voice(sessionId:string,callSid=sid()){return webhook('/integrations/twilio/voice',{AccountSid:server.accountSid,CallSid:callSid,From:`client:${f.alpha.admin.userId}`,sessionId});}
async function state(){return (await f.db.query('SELECT (SELECT count(*) FROM browser_audio_test_requests)::int requests,(SELECT count(*) FROM call_sessions)::int sessions,(SELECT count(*) FROM provider_reservations)::int reservations,(SELECT count(*) FROM firms)::int firms,(SELECT count(*) FROM dial_tickets)::int tickets')).rows[0];}
beforeEach(async()=>{
 f=await createAuthFixture();closed=false;try{server=await startIntegrationServer(f);admin=await issueSessionFor(f,f.alpha,f.alpha.admin);sales=await issueSessionFor(f,f.alpha,f.alpha.salesperson);
  for(const [key,value] of [['calling_provider',{provider:'twilio'}],['telephony_budget',{dailyCeilingCents:500,maxMinutesPerCall:30,unitPriceMicros:14000}]] as const)await f.db.query('INSERT INTO workspace_settings(workspace_id,setting_key,version,value,changed_by_user_id) VALUES($1,$2,1,$3::jsonb,$4)',[f.alpha.workspaceId,key,JSON.stringify(value),f.alpha.admin.userId]);
  const registered=await post('/calling-identities/register',command({e164:server.callerIdE164}));expect(registered.status,JSON.stringify(registered.body)).toBe(200);identityId=((registered.body['result'] as {identity:{id:string}}).identity.id);
 }catch(error){await stop();throw error;}
});
afterEach(stop);
it('the registered HTTP route makes one recorded 60-second test through signed Voice with no CRM or dial ticket',async()=>{
 const body=input(),answer=await post('/calling/audio-test/session',body);expect(answer.status,JSON.stringify(answer.body)).toBe(200);const sessionId=String((answer.body['result'] as {sessionId:string}).sessionId);expect(Object.keys(answer.body['result'] as object).sort()).toEqual(['expiresAt','sessionId']);
 expect((await post('/calling/audio-test/session',body)).body).toMatchObject({status:'accepted',replayed:true});expect(await state()).toEqual({requests:1,sessions:1,reservations:1,firms:0,tickets:0});
 const callSid=sid(),placed=await voice(sessionId,callSid);expect(placed.status).toBe(200);expect(placed.text).toContain(`>${phone}</Number>`);expect(placed.text).toContain('record="record-from-answer-dual"');expect(placed.text).toContain('timeLimit="60"');expect((await voice(sessionId)).text).not.toContain('<Dial');
 expect(audioTestExecutionReceiptSchema.parse((await post('/calling/audio-test/receipt',receipt(body))).body)).toMatchObject({state:'accepted',sessionId,canReconnect:false});
 await webhook('/integrations/twilio/status',{AccountSid:server.accountSid,CallSid:callSid,DialCallSid:sid(),DialCallStatus:'completed',DialCallDuration:'23'});
 const terminal=audioTestExecutionReceiptSchema.parse((await post('/calling/audio-test/receipt',receipt(body))).body);expect(terminal).toMatchObject({state:'accepted',sessionId,status:'completed',canReconnect:false});
 expect(JSON.stringify(terminal)).not.toContain(phone);expect((await f.db.query('SELECT e164,erased_at IS NOT NULL AS erased FROM browser_audio_test_requests')).rows).toEqual([{e164:null,erased:true}]);
 for(const table of ['call_logs','calling_follow_up_drafts','call_transcripts','call_summaries','jobs','outbound_messages'])expect((await f.db.query(`SELECT 1 FROM ${table}`)).rows).toEqual([]);
});
it('test routes refuse extra scope and salesperson execution without creating a test or provider reservation',async()=>{
 expect((await post('/calling/audio-test/session',{...input(),firmId:randomUUID()})).status).toBe(400);
 expect((await post('/calling/audio-test/session',input(),sales.accessToken)).body).toMatchObject({status:'refused',reason:'audio_test_admin_only'});
 expect((await fetch(`${server.origin}/calling/audio-test/session`,{headers:{authorization:`Bearer ${admin.accessToken}`}})).status).toBe(405);
 expect((await post('/calling/audio-test/receipt',{...receipt(input()),e164:phone})).status).toBe(400);expect(await state()).toEqual({requests:0,sessions:0,reservations:0,firms:0,tickets:0});
});
it('exact receipt remains readable after owner OFF, while wrong device/hash/kind never recover or reconnect',async()=>{
 const body=input(),made=await post('/calling/audio-test/session',body);expect(made.status).toBe(200);
 const other=await issueSessionFor(f,f.alpha,f.alpha.admin);
 expect((await post('/calling/audio-test/receipt',receipt(body),other.accessToken)).body).toEqual({state:'unknown'});
 expect((await post('/calling/audio-test/receipt',{...receipt(body),payloadSHA256:'b'.repeat(64)})).body).toEqual({state:'unknown'});
 expect((await post('/calling/audio-test/session',{...body,e164:'+14015550197'})).body).toMatchObject({status:'refused',reason:'command_payload_mismatch'});
 expect((await post('/calling/setup/provider',command({expectedVersion:1,provider:'tel'}))).status).toBe(200);
 expect((await post('/calling/audio-test/receipt',receipt(body))).body).toMatchObject({state:'accepted',canReconnect:false});
 expect((await post('/calling/audio-test/session',input())).status).toBe(404);expect((await voice(String((made.body['result'] as {sessionId:string}).sessionId))).text).not.toContain('<Dial');expect(await state()).toEqual({requests:1,sessions:1,reservations:1,firms:0,tickets:0});
});
