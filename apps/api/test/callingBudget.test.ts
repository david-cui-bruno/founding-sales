import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {callingSetupSchema,callingBudgetReceiptSchema,type SessionGrant} from '@fss/contracts';
import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import {settingLockName} from '@fss/domain/settings/store.ts';
import {dispatch} from '../src/server.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {payloadHashOf} from '../src/auth/tokens.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
let f:AuthFixture,runtime:SessionQueryable,admin:SessionGrant,sales:SessionGrant;
const command=(expectedVersion=1,dailyCeilingCents=500)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,expectedVersion,dailyCeilingCents});
const receipt=(input:ReturnType<typeof command>)=>({commandId:input.commandId,payloadSHA256:payloadHashOf({expectedVersion:input.expectedVersion,dailyCeilingCents:input.dailyCeilingCents})});
async function request(path:string,body:unknown,token=admin.accessToken,db=runtime,method='POST'){
 return dispatch({method,path:'/calling/setup'+path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:db,auth:{...f.deps,db},supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:localNoopSuppressionJournal()});
}
const snapshot=async()=>callingSetupSchema.parse((await request('',undefined,admin.accessToken,runtime,'GET')).body);
async function lockWait(db:SessionQueryable){const pid=(await db.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;return async()=>expect.poll(async()=>Number((await f.db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[pid])).rows[0]?.['n']),{timeout:3000}).toBe(1);}
beforeEach(async()=>{
 f=await createAuthFixture();runtime=await f.database.appRuntimeSession();admin=await issueSessionFor(f,f.alpha,f.alpha.admin);sales=await issueSessionFor(f,f.alpha,f.alpha.salesperson);
 await f.db.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[f.alpha.workspaceId,f.beta.admin.userId]);
 for(const [key,value] of [['calling_provider',{provider:'tel'}],['telephony_budget',{dailyCeilingCents:100,maxMinutesPerCall:7,unitPriceMicros:14000}]] as const)await f.db.query('INSERT INTO workspace_settings(workspace_id,setting_key,version,value,changed_by_user_id) VALUES($1,$2,1,$3::jsonb,$4)',[f.alpha.workspaceId,key,JSON.stringify(value),f.alpha.admin.userId]);
});
afterEach(async()=>f?.stop());
it('uses a strict current-version command to change only the daily ceiling without enabling calling',async()=>{
 const prior=await snapshot();const input=command();expect((await request('/budget',input)).body).toMatchObject({status:'accepted',replayed:false,result:{dailyCeilingCents:500,version:2}});
 expect(await snapshot()).toEqual({...prior,telephonyBudget:{...prior.telephonyBudget,dailyCeilingCents:500,version:2}});
 expect((await request('/budget',{...command(2),unitPriceMicros:1})).status).toBe(400);expect((await request('/budget',command(2),admin.accessToken,runtime,'GET')).status).toBe(405);
 expect((await request('/budget',command(2),sales.accessToken)).body).toMatchObject({status:'refused',reason:'admin_only'});
 for(const table of ['call_sessions','browser_audio_test_requests','provider_reservations','provider_ledger','jobs','firms','outbound_messages'])expect((await runtime.query(`SELECT 1 FROM ${table}`)).rows).toEqual([]);
});
it('stale changes refuse and old command replay/receipt never overwrite a newer lower ceiling',async()=>{
 const input=command();expect((await request('/budget',input)).status).toBe(200);expect((await request('/budget',command(2,200))).status).toBe(200);
 expect((await request('/budget',command(2,500))).body).toMatchObject({status:'refused',reason:'setting_version_conflict'});
 expect((await request('/budget',input)).body).toMatchObject({status:'accepted',replayed:true,result:{dailyCeilingCents:500,version:2}});
 expect(callingBudgetReceiptSchema.parse((await request('/budget-receipt',receipt(input))).body)).toEqual({state:'accepted',result:{dailyCeilingCents:500,version:2}});
 expect((await snapshot()).telephonyBudget).toMatchObject({dailyCeilingCents:200,version:3});
 expect((await request('/budget',{...input,dailyCeilingCents:600})).body).toMatchObject({status:'refused',reason:'command_payload_mismatch'});
 const other=await issueSessionFor(f,f.alpha,f.alpha.admin);expect((await request('/budget-receipt',receipt(input),other.accessToken)).body).toEqual({state:'unknown'});
 expect((await request('/budget-receipt',{...receipt(input),payloadSHA256:'a'.repeat(64)})).body).toEqual({state:'unknown'});
 expect((await request('/receipt',receipt(input))).body).toEqual({state:'unknown'});
});
it.each(['role','device','session'] as const)('budget-lock wait rechecks %s and rolls back setting/audit/receipt',async kind=>{
 const blocker=await f.database.appRuntimeSession(),worker=await f.database.appRuntimeSession(),waiting=await lockWait(worker),input=command(),audit=Number((await runtime.query('SELECT count(*)::int n FROM audit_events')).rows[0]?.['n']);
 await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[settingLockName(f.alpha.workspaceId,'telephony_budget')]);
 const pending=request('/budget',input,admin.accessToken,worker);try{await waiting();
  if(kind==='role')await f.db.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[f.alpha.workspaceId,f.alpha.admin.userId]);
  if(kind==='device')await f.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE workspace_id=$1 AND id=$2",[f.alpha.workspaceId,admin.deviceId]);
  if(kind==='session')await f.db.query("UPDATE sessions SET status='ended',ended_at=now(),end_reason='signed_out' WHERE workspace_id=$1 AND device_id=$2",[f.alpha.workspaceId,admin.deviceId]);
 }finally{await blocker.query('COMMIT');}
 expect((await pending).status).toBe(401);expect((await runtime.query('SELECT 1 FROM command_receipts WHERE command_id=$1',[input.commandId])).rows).toEqual([]);
 expect((await runtime.query("SELECT value,version FROM workspace_settings WHERE workspace_id=$1 AND setting_key='telephony_budget' AND superseded_at IS NULL",[f.alpha.workspaceId])).rows).toEqual([{value:{dailyCeilingCents:100,maxMinutesPerCall:7,unitPriceMicros:14000},version:1}]);
 expect(Number((await runtime.query('SELECT count(*)::int n FROM audit_events')).rows[0]?.['n'])).toBe(audit);
});
it('deadline expiry after a receipt uniqueness wait rolls back the entire budget change',async()=>{
 const blocker=await f.database.appRuntimeSession(),worker=await f.database.appRuntimeSession(),waiting=await lockWait(worker),input=command(),audit=Number((await runtime.query('SELECT count(*)::int n FROM audit_events')).rows[0]?.['n']);
 await blocker.query('BEGIN');await blocker.query("INSERT INTO command_receipts(workspace_id,device_id,command_id,command_kind,payload_hash,result_status,result) VALUES($1,$2,$3,'calling.setup_budget',$4,'refused','\"fixture\"'::jsonb)",[f.alpha.workspaceId,admin.deviceId,input.commandId,'c'.repeat(64)]);
 const pending=request('/budget',input,admin.accessToken,worker);try{await waiting();f.advance(3600001);}finally{await blocker.query('ROLLBACK');}
 expect((await pending).status).toBe(401);expect((await runtime.query('SELECT 1 FROM command_receipts WHERE command_id=$1',[input.commandId])).rows).toEqual([]);expect((await runtime.query("SELECT version FROM workspace_settings WHERE setting_key='telephony_budget' AND workspace_id=$1",[f.alpha.workspaceId])).rows).toEqual([{version:1}]);expect(Number((await runtime.query('SELECT count(*)::int n FROM audit_events')).rows[0]?.['n'])).toBe(audit);
});
