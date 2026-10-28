import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {callingSetupSchema,callingSetupReceiptSchema,type SessionGrant} from '@fss/contracts';
import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import {settingLockName} from '@fss/domain/settings/store.ts';
import {sendGateLockName} from '@fss/domain/policy/sendGate.ts';
import {dispatch} from '../src/server.ts';
import type {RoutingOptions} from '../src/routes/types.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {payloadHashOf} from '../src/auth/tokens.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
let f:AuthFixture,runtime:SessionQueryable,admin:SessionGrant,sales:SessionGrant,beta:SessionGrant;
const effect=vi.fn(()=>{throw Error('Provider use forbidden in setup');});
const twilio={accountSid:'FICTIONAL',twimlAppSid:'FICTIONAL',callerIdE164:'+14015550100',verifySignature:effect,mintAccessToken:effect,fetchRecording:effect};
function options(db=runtime,configured=true):RoutingOptions{return {session:db,auth:{...f.deps,db},supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:localNoopSuppressionJournal(),integrations:{publicOrigin:null,twilio:configured?twilio:null,calcom:null}};}
async function request(path:string,token:string|null,body?:unknown,db=runtime,configured=true,method=body===undefined?'GET':'POST'){
 return dispatch({method,path:'/calling/setup'+path,query:new URLSearchParams(),headers:token?{authorization:`Bearer ${token}`}:{},body},options(db,configured));
}
const command=(expectedVersion:number,provider:'tel'|'twilio'='twilio')=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,expectedVersion,provider});
function receipt(input:ReturnType<typeof command>){return {commandId:input.commandId,payloadSHA256:payloadHashOf({expectedVersion:input.expectedVersion,provider:input.provider})};}
const snapshot=async()=>callingSetupSchema.parse((await request('',admin.accessToken)).body);
const version=async()=>(await snapshot()).callingProvider.version;
async function waitForLock(db:SessionQueryable){const pid=(await db.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;return async()=>expect.poll(async()=>Number((await f.db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[pid])).rows[0]?.['n']),{timeout:3000}).toBe(1);}
beforeAll(async()=>{f=await createAuthFixture();runtime=await f.database.appRuntimeSession();admin=await issueSessionFor(f,f.alpha,f.alpha.admin);sales=await issueSessionFor(f,f.alpha,f.alpha.salesperson);beta=await issueSessionFor(f,f.beta,f.beta.admin);await f.db.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[f.alpha.workspaceId,f.beta.admin.userId]);});
afterAll(async()=>f?.stop());
it('registered routes require authentication, closed methods/bodies; active salesperson reads only the strict small snapshot',async()=>{
 expect((await request('',null)).status).toBe(401);
 expect((await request('',admin.accessToken,{})).status).toBe(405);
 expect((await request('/provider',admin.accessToken)).status).toBe(405);
 expect((await request('/receipt',admin.accessToken)).status).toBe(405);
 expect((await request('/provider',admin.accessToken,{...command(0),dailyCeilingCents:100})).status).toBe(400);
 expect((await request('/receipt',admin.accessToken,{commandId:randomUUID(),payloadSHA256:'a'.repeat(64),provider:'twilio'})).status).toBe(400);
 expect(callingSetupSchema.parse((await request('',sales.accessToken,undefined,runtime,false)).body)).toEqual({callingProvider:{provider:'tel',version:0},telephonyBudget:{dailyCeilingCents:0,maxMinutesPerCall:30,unitPriceMicros:14000,version:0},spentTodayCents:0,configured:false});
 expect((await request('/provider',sales.accessToken,command(0))).body).toMatchObject({status:'refused',reason:'admin_only'});
 expect(await version()).toBe(0);expect(effect).not.toHaveBeenCalled();
});
it('requires existing provider and positive existing budget to enable, while OFF remains possible with neither',async()=>{
 expect((await request('/provider',admin.accessToken,command(0),runtime,false)).body).toMatchObject({status:'refused',reason:'integration_unconfigured'});
 expect((await request('/provider',admin.accessToken,command(0))).body).toMatchObject({status:'refused',reason:'telephony_budget_disabled'});
 expect((await request('/provider',admin.accessToken,command(0,'tel'),runtime,false)).body).toMatchObject({status:'accepted',result:{provider:'tel',version:1}});
 await f.db.query("INSERT INTO workspace_settings(workspace_id,setting_key,version,value,changed_by_user_id) VALUES($1,'telephony_budget',1,$2::jsonb,$3)",[f.alpha.workspaceId,JSON.stringify({dailyCeilingCents:500,maxMinutesPerCall:4,unitPriceMicros:14000}),f.alpha.admin.userId]);
 const before=(await snapshot()).telephonyBudget;
 const input=command(1);expect((await request('/provider',admin.accessToken,input)).body).toMatchObject({status:'accepted',result:{provider:'twilio',version:2}});
 expect((await snapshot()).telephonyBudget).toEqual(before);
 const note=(await runtime.query<{change_note:string}>("SELECT change_note FROM workspace_settings WHERE workspace_id=$1 AND setting_key='calling_provider' AND superseded_at IS NULL",[f.alpha.workspaceId])).rows[0]!.change_note;
 expect(note).toBe('Enabled browser calling in web Calling');
 expect(effect).not.toHaveBeenCalled();
});
it('stale enable never replaces newer OFF; replay and receipt are historical and scoped to original user/device/kind/hash',async()=>{
 const v=await version(),input=command(v);expect((await request('/provider',admin.accessToken,input)).body).toMatchObject({status:'accepted',result:{version:v+1}});
 expect((await request('/provider',admin.accessToken,command(v+1,'tel'),runtime,false)).body).toMatchObject({status:'accepted',result:{version:v+2}});
 expect((await request('/provider',admin.accessToken,command(v+1))).body).toMatchObject({status:'refused',reason:'setting_version_conflict'});
 expect((await request('/provider',admin.accessToken,input)).body).toMatchObject({status:'accepted',replayed:true,result:{provider:'twilio',version:v+1}});
 expect(callingSetupReceiptSchema.parse((await request('/receipt',admin.accessToken,receipt(input))).body)).toEqual({state:'accepted',result:{provider:'twilio',version:v+1}});
 expect((await snapshot()).callingProvider).toEqual({provider:'tel',version:v+2});
 expect((await request('/provider',admin.accessToken,{...input,provider:'tel'})).body).toMatchObject({status:'refused',reason:'command_payload_mismatch'});
 const another=await issueSessionFor(f,f.alpha,f.alpha.admin);
 expect((await request('/receipt',another.accessToken,receipt(input))).body).toEqual({state:'unknown'});
 expect((await request('/receipt',beta.accessToken,receipt(input))).body).toEqual({state:'unknown'});
 expect((await request('/receipt',sales.accessToken,receipt(input))).status).toBe(401);
 expect((await request('/receipt',admin.accessToken,{...receipt(input),payloadSHA256:'b'.repeat(64)})).body).toEqual({state:'unknown'});
 const wrong=command(v+2,'tel');await runtime.query("INSERT INTO command_receipts(workspace_id,device_id,command_id,command_kind,payload_hash,result_status,result) VALUES($1,$2,$3,'different.kind',$4,'accepted','{}'::jsonb)",[f.alpha.workspaceId,admin.deviceId,wrong.commandId,receipt(wrong).payloadSHA256]);
 expect((await request('/receipt',admin.accessToken,receipt(wrong))).body).toEqual({state:'unknown'});
 expect(effect).not.toHaveBeenCalled();
});
it('queued stale enable sees a newer OFF committed under the provider setting lock',async()=>{
 const v=await version(),blocker=await f.database.appRuntimeSession(),worker=await f.database.appRuntimeSession(),waiting=await waitForLock(worker);
 await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[settingLockName(f.alpha.workspaceId,'calling_provider')]);
 const pending=request('/provider',admin.accessToken,command(v),worker);try{
  await waiting();
  // A concurrent legacy owner OFF uses the same setting lock and commits before queued Enable.
  await blocker.query("UPDATE workspace_settings SET superseded_at=greatest(now(),changed_at),superseded_by_version=$2 WHERE workspace_id=$1 AND setting_key='calling_provider' AND superseded_at IS NULL",[f.alpha.workspaceId,v+1]);
  await blocker.query("INSERT INTO workspace_settings(workspace_id,setting_key,version,value,changed_by_user_id) VALUES($1,'calling_provider',$2,'{\"provider\":\"tel\"}'::jsonb,$3)",[f.alpha.workspaceId,v+1,f.alpha.admin.userId]);
 }finally{await blocker.query('COMMIT');}
 expect((await pending).body).toMatchObject({status:'refused',reason:'setting_version_conflict'});expect((await snapshot()).callingProvider).toEqual({provider:'tel',version:v+1});
});
it.each(['role','device','session'] as const)('provider-setting wait rechecks %s and rolls back mutation, audit and receipt',async kind=>{
 const grant=await issueSessionFor(f,f.alpha,f.alpha.admin),input=command(await version()),blocker=await f.database.appRuntimeSession(),worker=await f.database.appRuntimeSession(),waiting=await waitForLock(worker),before=await version();
 await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[settingLockName(f.alpha.workspaceId,'calling_provider')]);
 const pending=request('/provider',grant.accessToken,input,worker);
 try{await waiting();
  if(kind==='role')await f.db.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[f.alpha.workspaceId,f.alpha.admin.userId]);
  if(kind==='device')await f.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE workspace_id=$1 AND id=$2",[f.alpha.workspaceId,grant.deviceId]);
  if(kind==='session')await f.db.query("UPDATE sessions SET status='ended',ended_at=now(),end_reason='signed_out' WHERE workspace_id=$1 AND device_id=$2",[f.alpha.workspaceId,grant.deviceId]);
 }finally{await blocker.query('COMMIT');}
 try{expect((await pending).status).toBe(401);expect((await runtime.query('SELECT 1 FROM command_receipts WHERE command_id=$1',[input.commandId])).rows).toEqual([]);}
 finally{if(kind==='role')await f.db.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[f.alpha.workspaceId,f.alpha.admin.userId]);}
 expect(await version()).toBe(before);
});
it('send gate precedes provider lock, and an auth deadline after a receipt uniqueness wait rolls back the whole command',async()=>{
 const before=await version(),input=command(before),grant=await issueSessionFor(f,f.alpha,f.alpha.admin),auditBefore=Number((await runtime.query('SELECT count(*)::int n FROM audit_events')).rows[0]?.['n']),blocker=await f.database.appRuntimeSession(),worker=await f.database.appRuntimeSession(),waiting=await waitForLock(worker),oldNow=f.deps.now();
 await blocker.query('BEGIN');await blocker.query("INSERT INTO command_receipts(workspace_id,device_id,command_id,command_kind,payload_hash,result_status,result) VALUES($1,$2,$3,'calling.setup_provider',$4,'refused','\"fixture\"'::jsonb)",[f.alpha.workspaceId,grant.deviceId,input.commandId,'c'.repeat(64)]);
 const pending=request('/provider',grant.accessToken,input,worker);try{await waiting();f.advance(3600001);}finally{await blocker.query('ROLLBACK');}
 try{expect((await pending).status).toBe(401);}finally{f.setNow(oldNow);}
 expect(await version()).toBe(before);expect(Number((await runtime.query('SELECT count(*)::int n FROM audit_events')).rows[0]?.['n'])).toBe(auditBefore);expect((await runtime.query('SELECT 1 FROM command_receipts WHERE command_id=$1',[input.commandId])).rows).toEqual([]);
 expect((await runtime.query("SELECT 1 FROM workspace_settings WHERE workspace_id=$1 AND setting_key='calling_provider' AND version>$2",[f.alpha.workspaceId,before])).rows).toEqual([]);
 // Holding the send gate prevents the writer from taking the provider setting lock.
 await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[sendGateLockName(f.alpha.workspaceId)]);
 const second=command(before,'tel'),write=request('/provider',admin.accessToken,second,worker);try{await waiting();
  expect((await blocker.query<{available:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) available',[settingLockName(f.alpha.workspaceId,'calling_provider')])).rows[0]!.available).toBe(true);
 }finally{await blocker.query('ROLLBACK');}
 expect((await write).body).toMatchObject({status:'accepted'});
});
it.each((['status','receipt'] as const).flatMap(kind=>(['role','device','session'] as const).map(revoked=>({kind,revoked}))))('$kind read fences current $revoked changes after real SQL waits',async({kind,revoked})=>{
 const grant=await issueSessionFor(f,f.alpha,f.alpha.admin),blocker=await f.database.appRuntimeSession(),worker=await f.database.appRuntimeSession(),waiting=await waitForLock(worker);
 await blocker.query('BEGIN');await blocker.query(`LOCK TABLE ${kind==='status'?'workspace_settings':'command_receipts'} IN ACCESS EXCLUSIVE MODE`);
 const pending=request(kind==='status'?'':'/receipt',grant.accessToken,kind==='status'?undefined:{commandId:randomUUID(),payloadSHA256:'d'.repeat(64)},worker);
 try{await waiting();if(revoked==='role')await f.db.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[f.alpha.workspaceId,f.alpha.admin.userId]);if(revoked==='device')await f.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE workspace_id=$1 AND id=$2",[f.alpha.workspaceId,grant.deviceId]);if(revoked==='session')await f.db.query("UPDATE sessions SET status='ended',ended_at=now(),end_reason='signed_out' WHERE workspace_id=$1 AND device_id=$2",[f.alpha.workspaceId,grant.deviceId]);}finally{await blocker.query('COMMIT');}
 try{expect((await pending).status).toBe(401);}finally{if(revoked==='role')await f.db.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[f.alpha.workspaceId,f.alpha.admin.userId]);}
});
it('setup changes no budgets, feature consents, call/provider/research effects or unrelated settings',async()=>{
 expect((await runtime.query("SELECT setting_key,count(*)::int n FROM workspace_settings WHERE workspace_id=$1 AND setting_key<>'calling_provider' GROUP BY setting_key",[f.alpha.workspaceId])).rows).toEqual([{setting_key:'telephony_budget',n:1}]);
 for(const table of ['call_sessions','dial_tickets','provider_reservations','provider_ledger','research_runs','jobs','firms','contacts','outbound_messages'])expect((await runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
 expect(effect).not.toHaveBeenCalled();
});
