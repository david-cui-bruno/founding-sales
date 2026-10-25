import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {dispatch,type ApiRequest} from '../src/server.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {payloadHashOf} from '../src/auth/tokens.ts';
import {manualOrdinaryFixture} from '../../../packages/domain/test/sourcing/support/manualProspectFixture.ts';
let f:AuthFixture,admin:string,sales:string,beta:string,id:string;
const prefix='/sourcing/candidates/prospects/activity';
const content={performedByUser:true,channel:'manual_phone',occurrence:{kind:'unknown'},result:'unknown',note:'Synthetic API report private prose',callback:null};
const command=()=>({...content,operation:'create',candidateId:id,expectedCandidateRevision:1,attemptId:randomUUID(),commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
async function request(path:string,token:string|null,body:unknown,method='POST'){
 return dispatch({method,path:prefix+'/'+path,query:new URLSearchParams(),headers:token===null?{}:{authorization:`Bearer ${token}`},body} as ApiRequest,{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:localNoopSuppressionJournal()});
}
beforeAll(async()=>{
 f=await createAuthFixture();admin=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;sales=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;beta=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;
 const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),f.db);
 const saved=await withTransaction(f.db,()=>saveCandidate(ctx,manualOrdinaryFixture(777)));if(!saved.ok)throw Error(saved.reason);id=saved.value.id;
});
afterAll(async()=>f?.stop());
it('all four routes enforce signed current admin and strict scope without phone or consent prerequisites',async()=>{
 for(const route of ['list','read','save','receipt']){expect((await request(route,null,{})).status).toBe(401);expect((await request(route,sales,{})).status).toBe(403);expect((await request(route,admin,{},'GET')).status).toBe(405);}
 expect((await request('list',admin,{candidateId:id,expectedCandidateRevision:1})).body).toEqual({activities:[],nextAfterId:null});
 expect((await request('list',beta,{candidateId:id,expectedCandidateRevision:1})).status).toBe(409);
 expect((await request('save',admin,{...command(),contactConsent:true})).status).toBe(400);
});
it('opaque exact receipts replay IDs only, mismatched hash stays unknown and fresh read alone returns prose',async()=>{
 const body=command(),saved=await request('save',admin,body);expect(saved.body).toMatchObject({status:'accepted',replayed:false,result:{attemptId:body.attemptId,activityRevision:1}});
 expect(JSON.stringify(saved.body)).not.toContain(content.note);expect((await request('save',admin,body)).body).toMatchObject({status:'accepted',replayed:true});
 expect((await request('save',admin,{...body,note:'different'})).body).toMatchObject({status:'refused',reason:'command_payload_mismatch'});
 const {commandId:_commandId,clientVersion:_clientVersion,...payload}=body;
 const receipt={commandId:body.commandId,payloadSHA256:payloadHashOf(payload)};
 expect((await request('receipt',admin,receipt)).body).toMatchObject({state:'accepted',result:{attemptId:body.attemptId}});
 expect((await request('receipt',admin,{...receipt,payloadSHA256:'f'.repeat(64)})).body).toEqual({state:'unknown'});
 expect((await request('receipt',beta,receipt)).body).toEqual({state:'unknown'});
 expect(JSON.stringify((await request('list',admin,{candidateId:id,expectedCandidateRevision:1})).body)).not.toContain(content.note);
 expect((await request('read',admin,{candidateId:id,expectedCandidateRevision:1,attemptId:body.attemptId})).body).toMatchObject({activity:{note:content.note,occurrence:{kind:'unknown'},contactAuthority:'not_granted'}});
 await f.db.query(`UPDATE sourcing_candidates SET source_check='{"state":"unavailable","reason":"source_not_permitted"}'::jsonb WHERE id=$1`,[id]);
 expect((await request('read',admin,{candidateId:id,expectedCandidateRevision:1,attemptId:body.attemptId})).status).toBe(409);
 expect((await f.db.query('SELECT content FROM sourcing_manual_prospect_attempts WHERE id=$1',[body.attemptId])).rows).toEqual([{content:null}]);
 expect((await request('receipt',admin,receipt)).body).toMatchObject({state:'accepted'});
 for(const table of ['jobs','provider_reservations','firms','contacts','call_logs','callbacks','today_items','phone_routes','sequence_enrollments','outbound_messages','suppression_events'])expect((await f.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});
it('real receipt uniqueness wait rechecks source wall clock at final commit and rolls back prose, audit and receipt',async()=>{
 const grant=await issueSessionFor(f,f.alpha,f.alpha.admin),runtime=await f.database.appRuntimeSession(),blocker=await f.database.appRuntimeSession();
 const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),runtime),input=manualOrdinaryFixture(778);
 const candidate=await withTransaction(runtime,()=>saveCandidate(ctx,input));if(!candidate.ok)throw Error(candidate.reason);
 const firm=(await f.db.query<{id:string}>('INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,$2,$3) RETURNING id',[f.alpha.workspaceId,'Synthetic receipt expiry parent',f.alpha.admin.userId])).rows[0]!.id;
 await f.db.query(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at) VALUES($1,$2,'website',$3,$4,true,clock_timestamp()+interval '2 seconds')`,[f.alpha.workspaceId,firm,input.sourceUrl,'e'.repeat(64)]);
 const body={...command(),candidateId:candidate.value.id};
 await blocker.query('BEGIN');await blocker.query(`INSERT INTO command_receipts(workspace_id,device_id,command_id,command_kind,payload_hash,result_status,result) VALUES($1,$2,$3,'sourcing.manual_activity_save',$4,'refused','"fixture"'::jsonb)`,[f.alpha.workspaceId,grant.deviceId,body.commandId,'e'.repeat(64)]);
 const pending=dispatch({method:'POST',path:prefix+'/save',query:new URLSearchParams(),headers:{authorization:`Bearer ${grant.accessToken}`},body},{session:runtime,auth:{...f.deps,db:runtime},supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update'});
 try{
  await expect.poll(async()=>Number((await f.db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'INSERT INTO command_receipts%'")).rows[0]?.['n'])).toBe(1);
  await blocker.query('SELECT pg_sleep(2.1)');
 }finally{await blocker.query('ROLLBACK');}
 expect(await pending).toMatchObject({status:409,body:{error:'candidate_unavailable'}});
 expect((await runtime.query('SELECT id FROM sourcing_manual_prospect_attempts WHERE id=$1',[body.attemptId])).rows).toEqual([]);
 expect((await runtime.query('SELECT command_id FROM command_receipts WHERE command_id=$1',[body.commandId])).rows).toEqual([]);
 expect((await runtime.query('SELECT id FROM audit_events WHERE subject_id=$1',[body.attemptId])).rows).toEqual([]);
});
