import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {dispatch,type ApiRequest} from '../src/server.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveDiscoveryCandidate} from '@fss/domain/sourcing/discoveryIntake.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {manualProspectListSchema} from '@fss/contracts';
import {manualDiscoveryFixture,manualOrdinaryFixture} from '../../../packages/domain/test/sourcing/support/manualProspectFixture.ts';
import {manualLiteralPhoneFixture,seedManualPhoneRun} from '../../../packages/domain/test/sourcing/support/manualPhoneFixture.ts';
let f:AuthFixture,admin:string,sales:string,beta:string,id:string;
const read='/sourcing/candidates/prospects/list',feedback='/sourcing/candidates/prospects/feedback';
async function request(path:string,token:string|null,body:unknown,method='POST'){
 return dispatch({method,path,query:new URLSearchParams(),headers:token===null?{}:{authorization:`Bearer ${token}`},body} as ApiRequest,{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:localNoopSuppressionJournal()});
}
const command=(state='kept')=>({candidateId:id,expectedRevision:1,state,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
beforeAll(async()=>{
 f=await createAuthFixture();admin=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;sales=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;beta=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;
 const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),f.db);
 const saved=await withTransaction(f.db,()=>saveDiscoveryCandidate(ctx,manualDiscoveryFixture()));if(!saved.ok)throw Error(saved.reason);id=saved.value.id;
});
afterAll(async()=>{await f.stop();});
it('authenticates exact narrow raw reads and strict commands without provider or qualification prerequisites',async()=>{
 for(const path of [read,feedback]){expect((await request(path,null,path===read?{state:'all',offset:0}:command())).status).toBe(401);expect((await request(path,sales,path===read?{state:'all',offset:0}:command())).status).toBe(403);expect((await request(path,admin,{},'GET')).status).toBe(405);}
 expect((await request(read,admin,{state:'all',offset:0})).body).toMatchObject({prospects:[{candidateId:id,revision:1,observedPhone:null,qualification:'unverified'}]});
 expect((await request(read,beta,{state:'all',offset:0})).body).toEqual({prospects:[],hasMore:false});
 expect((await request(feedback,beta,command())).body).toMatchObject({status:'refused',reason:'candidate_unavailable'});
 expect((await request(read,admin,{state:'all',offset:0,owner:'forged'})).status).toBe(400);
 expect((await request(feedback,admin,{...command(),phone:'invented'})).status).toBe(400);
});
it('normal runCommand receipts reconcile exact UUID without reapplying historical state',async()=>{
 const before=(await f.db.query('SELECT * FROM sourcing_candidates')).rows;
 const keep=command(),first=await request(feedback,admin,keep);expect(first.body).toEqual({status:'accepted',replayed:false,result:{candidateId:id,revision:1,state:'kept'}});
 expect((await request(feedback,admin,keep)).body).toEqual({...first.body as object,replayed:true});
 expect((await request(feedback,admin,{...keep,state:'skipped'})).body).toMatchObject({status:'refused',reason:'command_payload_mismatch'});
 expect((await request(feedback,admin,command('wrong_number'))).body).toMatchObject({status:'accepted'});
 expect((await request(feedback,admin,keep)).body).toMatchObject({status:'accepted',replayed:true,result:{state:'kept'}});
 expect((await request(read,admin,{state:'all',offset:0})).body).toMatchObject({prospects:[{candidateId:id,state:'wrong_number'}]});
 expect((await request(feedback,admin,{...command(),expectedRevision:2})).body).toMatchObject({status:'refused',reason:'candidate_changed'});
 expect((await f.db.query('SELECT * FROM sourcing_candidates')).rows).toEqual(before);
 for(const table of ['jobs','provider_reservations','firms','contacts','phone_routes','sequence_enrollments','outbound_messages'])expect((await f.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});
it('775 authenticates literal original extraction independently of malformed model facts and keeps source rows unchanged',async()=>{
 const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),f.db),input=manualOrdinaryFixture(775);input.website='https://source.example.test/';
 const saved=await withTransaction(f.db,()=>saveCandidate(ctx,input));if(!saved.ok)throw Error(saved.reason);
 const run=await seedManualPhoneRun(f.db,f.alpha.workspaceId,saved.value.id,manualLiteralPhoneFixture(input.sourceUrl));await f.db.query('UPDATE sourcing_qualification_runs SET facts=$2 WHERE id=$1',[run,JSON.stringify([{invalid:'model'}])]);
 const before=(await f.db.query('SELECT to_jsonb(r) row FROM sourcing_qualification_runs r ORDER BY id')).rows;
 try{
  const answer=await request(read,admin,{state:'all',offset:0});expect(answer.status).toBe(200);
  expect(manualProspectListSchema.parse(answer.body).prospects.find(row=>row.candidateId===saved.value.id)).toMatchObject({observedPhone:'+12145550123',qualification:'unverified',contactAuthority:'not_granted',phoneEvidence:{state:'observed',sources:[{method:'retained_original_literal',authority:{kind:'candidate_source'}}],coverage:{state:'complete'}}});
  expect(manualProspectListSchema.parse((await request(read,beta,{state:'all',offset:0})).body).prospects).toEqual([]);
  expect((await request(read,sales,{state:'all',offset:0})).status).toBe(403);
  expect((await f.db.query('SELECT to_jsonb(r) row FROM sourcing_qualification_runs r ORDER BY id')).rows).toEqual(before);
  for(const table of ['jobs','provider_reservations','firms','contacts','phone_routes','sequence_enrollments','outbound_messages'])expect((await f.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
 }finally{await f.db.query('DELETE FROM sourcing_candidates WHERE id=$1',[saved.value.id]);}
});
