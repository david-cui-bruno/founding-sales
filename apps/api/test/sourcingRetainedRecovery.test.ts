import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {dispatch,type ApiRequest} from '../src/server.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {seedRetainedRecovery} from '../../../packages/domain/test/sourcing/retainedRecoveryFixture.ts';
let f:AuthFixture,admin:string,sales:string,beta:string;
const envelope=<T extends object>(body:T)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
async function request(path:string,token:string|null,body:unknown,method='POST'){
 return await dispatch({method,path,query:new URLSearchParams(),headers:token===null?{}:{authorization:`Bearer ${token}`},body} as ApiRequest,{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:localNoopSuppressionJournal()});
}
beforeAll(async()=>{f=await createAuthFixture();admin=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;sales=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;beta=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;});
afterAll(async()=>{await f.stop();});
it('authenticates strict reference-only recovery, preserves immutable originals and receipt replay',async()=>{
 const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),f.db);
 const fixture=await withTransaction(f.db,()=>seedRetainedRecovery(ctx));
 const path='/sourcing/qualification/recovery/identity',command=envelope(fixture.identity);
 expect((await request(path,null,command)).status).toBe(401);
 expect((await request(path,sales,envelope(fixture.identity))).body).toMatchObject({reason:'admin_only'});
 expect((await request(path,beta,envelope(fixture.identity))).body).toMatchObject({reason:'not_found'});
 expect((await request(path,admin,{...command,firmName:'Untrusted override'})).status).toBe(400);
 expect((await request(path,admin,command,'GET')).status).toBe(405);
 const old=(await f.db.query('SELECT * FROM sourcing_qualification_runs WHERE id=$1',[fixture.runId])).rows[0];
 const first=await request(path,admin,command);expect(first.body,JSON.stringify(first.body)).toMatchObject({status:'accepted',replayed:false,result:{candidateId:fixture.candidateId,revision:2}});
 expect((await request(path,admin,command)).body).toMatchObject({status:'accepted',replayed:true});
 expect((await request(path,admin,{...command,nameEnd:command.nameEnd-1})).status).toBe(409);
 const decisionId=(first.body as {result:{decisionId:string}}).result.decisionId;
 const interpret=envelope(fixture.interpretation(decisionId));
 const made=await request('/sourcing/qualification/recovery/interpret',admin,interpret);expect(made.body).toMatchObject({status:'accepted',replayed:false});
 expect((await request('/sourcing/qualification/recovery/interpret',admin,interpret)).body).toMatchObject({status:'accepted',replayed:true});
 expect((await request('/sourcing/qualification/read',admin,{candidateId:fixture.candidateId})).body).toMatchObject({status:'eligible',interpretationOrigin:'human_retained',recovery:{originalRunId:fixture.runId,decisionId}});
 expect((await f.db.query('SELECT * FROM sourcing_qualification_runs WHERE id=$1',[fixture.runId])).rows[0]).toEqual(old);
 for(const table of ['jobs','provider_reservations','firms'])expect((await f.db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});
