import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {prospectPriorityListSchema,prospectPriorityReceiptSchema,prospectPriorityLearningSchema} from '@fss/contracts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {manualOrdinaryFixture} from '../../../packages/domain/test/sourcing/support/manualProspectFixture.ts';
import {dispatch,type ApiRequest} from '../src/server.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {payloadHashOf} from '../src/auth/tokens.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';

const prefix='/sourcing/candidates/prospects/priority';
let fixture:AuthFixture,admin:string,sales:string,beta:string,candidateId:string,sourceUrl:string;
async function request(action:string,token:string|null,body:unknown,method='POST'){
 return dispatch({method,path:`${prefix}/${action}`,query:new URLSearchParams(),headers:token?{authorization:`Bearer ${token}`}:{},body} as ApiRequest,
 {session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:localNoopSuppressionJournal()});
}
beforeAll(async()=>{
 fixture=await createAuthFixture();
 admin=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
 sales=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
 beta=(await issueSessionFor(fixture,fixture.beta,fixture.beta.admin)).accessToken;
 const ctx=repositoryContext(workspaceScope(fixture.alpha.workspaceId,{kind:'user',userId:fixture.alpha.admin.userId,role:'admin'}),fixture.db);
 const candidate=manualOrdinaryFixture(848);sourceUrl=candidate.sourceUrl;
 const saved=await withTransaction(fixture.db,()=>saveCandidate(ctx,candidate));if(!saved.ok)throw Error(saved.reason);candidateId=saved.value.id;
});
afterAll(async()=>fixture?.stop());

it('authenticates all current routes and preserves raw visibility without qualification, phone or model work',async()=>{
 for(const action of ['list','save','consider','learning','receipt']){
  expect((await request(action,null,{})).status).toBe(401);
  expect((await request(action,sales,{})).status).toBe(403);
  expect((await request(action,admin,{},'GET')).status).toBe(405);
 }
 expect((await request('list',admin,{state:'all',offset:0,qualification:'approved'})).status).toBe(400);
 const answer=prospectPriorityListSchema.parse((await request('list',admin,{state:'all',offset:0})).body);
 expect(answer.prospects).toMatchObject([{prospect:{candidateId,qualification:'unverified',contactAuthority:'not_granted'},priority:{fit:'unknown',timing:'unknown',roleState:'unknown',consideredCount:0}}]);
 expect(prospectPriorityListSchema.parse((await request('list',beta,{state:'all',offset:0})).body).prospects).toEqual([]);
 for(const table of ['jobs','provider_reservations','firms','contacts','phone_routes','outbound_messages'])expect((await fixture.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});

it('saves human evidence with exact revision receipts, rejects stale pages and records deliberate selection once',async()=>{
 const old=prospectPriorityListSchema.parse((await request('list',admin,{state:'all',offset:0})).body);
 const payload={candidateId,expectedCandidateRevision:1,expectedAssessmentRevision:0,fit:'positive',value:'positive',timing:'unknown',sourceUrl,roles:[]};
 const commandId=randomUUID(),body={...payload,commandId,clientVersion:CURRENT_CLIENT_VERSION};
 const saved=await request('save',admin,body);expect(saved).toMatchObject({status:200,body:{status:'accepted',replayed:false,result:{candidateId,candidateRevision:1,assessmentRevision:1}}});
 expect((await request('save',admin,body)).body).toMatchObject({status:'accepted',replayed:true});
 expect((await request('save',admin,{...body,value:'unknown'})).body).toMatchObject({status:'refused',reason:'command_payload_mismatch'});
 const receipt={commandId,payloadSHA256:payloadHashOf(payload),operation:'save'};
 expect(prospectPriorityReceiptSchema.parse((await request('receipt',admin,receipt)).body)).toMatchObject({state:'accepted',result:{assessmentRevision:1}});
 expect((await request('receipt',beta,receipt)).body).toEqual({state:'unknown'});
 expect((await request('receipt',admin,{...receipt,payloadSHA256:'f'.repeat(64)})).body).toEqual({state:'unknown'});
 expect((await request('list',admin,{state:'all',offset:50,viewRevision:old.viewRevision})).body).toEqual({error:'view_changed'});
 const current=prospectPriorityListSchema.parse((await request('list',admin,{state:'all',offset:0})).body);
 expect(current.prospects[0]?.priority).toMatchObject({fit:'positive',timing:'unknown',roleState:'unknown',reasons:[{code:'human_fit',sourceUrl},{code:'human_value',sourceUrl}]});
 const considered={candidateId,expectedCandidateRevision:1,expectedAssessmentRevision:1,disposition:'selected',commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION};
 expect((await request('consider',admin,considered)).body).toMatchObject({status:'accepted'});
 expect((await request('consider',admin,considered)).body).toMatchObject({status:'accepted',replayed:true});
 const after=prospectPriorityListSchema.parse((await request('list',admin,{state:'all',offset:0})).body);
 expect(after.prospects[0]?.priority.consideredCount).toBe(1);
 const learning=prospectPriorityLearningSchema.parse((await request('learning',admin,{from:'2020-01-01T00:00:00.000Z',to:'2099-01-01T00:00:00.000Z'})).body);
 expect(learning).toMatchObject({considered:1,selected:1,paidAdoption:'unavailable',retention:'unavailable',observations:{conversation:0}});
});

it('refuses forged sources and roles, foreign candidates and stale revisions without broadening contact authority',async()=>{
 const input={candidateId,expectedCandidateRevision:1,expectedAssessmentRevision:1,fit:'positive',value:'unknown',timing:'unknown',roles:[],sourceUrl:'https://unrelated.example.test/'};
 const command=()=>({...input,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
 expect((await request('save',admin,command())).body).toMatchObject({status:'refused',reason:'source_unavailable'});
 expect((await request('save',beta,command())).status).toBe(409);
 expect((await request('save',admin,{...command(),sourceUrl,roles:[{personId:randomUUID(),relationshipId:randomUUID(),relationshipRevision:1,role:'budget_approver'}]})).body).toMatchObject({status:'refused',reason:'role_unavailable'});
 expect((await request('consider',admin,{candidateId,expectedCandidateRevision:2,expectedAssessmentRevision:1,disposition:'considered',commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION})).status).toBe(409);
 const row=(await fixture.db.query('SELECT status,revision FROM sourcing_candidates WHERE id=$1',[candidateId])).rows[0];expect(row?.['revision']).toBe(1);
 for(const table of ['jobs','provider_reservations','firms','contacts','phone_routes','sequence_enrollments','outbound_messages'])expect((await fixture.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});

it('rolls selection and its receipt back when source-bound snapshot expires during the receipt wait',async()=>{
 const grant=await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin);
 const runtime=await fixture.database.appRuntimeSession(),blocker=await fixture.database.appRuntimeSession();
 const commandId=randomUUID(),body={candidateId,expectedCandidateRevision:1,expectedAssessmentRevision:1,disposition:'selected',commandId,clientVersion:CURRENT_CLIENT_VERSION};
 const before=(await fixture.db.query('SELECT id FROM sourcing_prospect_considerations WHERE workspace_id=$1',[fixture.alpha.workspaceId])).rows;
 await fixture.db.query("WITH wall AS (SELECT clock_timestamp() t) UPDATE sourcing_prospect_priorities SET decided_at=wall.t-interval '30 days'+interval '2 seconds',expires_at=wall.t+interval '2 seconds' FROM wall WHERE workspace_id=$1 AND candidate_id=$2",[fixture.alpha.workspaceId,candidateId]);
 await blocker.query('BEGIN');
 await blocker.query(`INSERT INTO command_receipts(workspace_id,device_id,command_id,command_kind,payload_hash,result_status,result) VALUES($1,$2,$3,'sourcing.prospect_priority_consider',$4,'refused','"fixture"'::jsonb)`,[fixture.alpha.workspaceId,grant.deviceId,commandId,'e'.repeat(64)]);
 const pending=dispatch({method:'POST',path:`${prefix}/consider`,query:new URLSearchParams(),headers:{authorization:`Bearer ${grant.accessToken}`},body},
 {session:runtime,auth:{...fixture.deps,db:runtime},supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update'});
 try{
  await expect.poll(async()=>Number((await fixture.db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'INSERT INTO command_receipts%'")).rows[0]?.['n'])).toBe(1);
  await blocker.query('SELECT pg_sleep(2.1)');
 }finally{await blocker.query('ROLLBACK');}
 expect(await pending).toMatchObject({status:409,body:{error:'source_expired'}});
 expect((await runtime.query('SELECT command_id FROM command_receipts WHERE command_id=$1',[commandId])).rows).toEqual([]);
 expect((await runtime.query('SELECT id FROM sourcing_prospect_considerations WHERE workspace_id=$1',[fixture.alpha.workspaceId])).rows).toEqual(before);
});
