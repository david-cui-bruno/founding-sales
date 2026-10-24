import {beforeAll,afterAll,it,expect} from 'vitest';
import {dispatch,type ApiRequest} from '../src/server.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {createAuthFixture,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {manualProspectListSchema} from '@fss/contracts';
import {manualOrdinaryFixture} from '../../../packages/domain/test/sourcing/support/manualProspectFixture.ts';
import {manualPhoneFixture,seedManualPhoneRun} from '../../../packages/domain/test/sourcing/support/manualPhoneFixture.ts';
let f:AuthFixture,admin:string,beta:string,sales:string,id:string,run:string;
const input=manualOrdinaryFixture(767),evidence=manualPhoneFixture(input.sourceUrl);
async function read(token:string){return dispatch({method:'POST',path:'/sourcing/candidates/prospects/list',query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body:{state:'all',offset:0}} as ApiRequest,{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:localNoopSuppressionJournal()});}
beforeAll(async()=>{
 f=await createAuthFixture();admin=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;beta=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;sales=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;
 const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),f.db);
 const saved=await withTransaction(f.db,()=>saveCandidate(ctx,{...input,firmName:'Home | Boston Property Management - Contact'}));if(!saved.ok)throw Error(saved.reason);id=saved.value.id;
 run=await seedManualPhoneRun(f.db,f.alpha.workspaceId,id,evidence);
});
afterAll(async()=>{await f.stop();});
it('composes retained phone provenance and name suggestions through authenticated API without canonical/qualification gates',async()=>{
 const snapshot=(await f.db.query('SELECT to_jsonb(c) row FROM sourcing_candidates c')).rows;
 const response=await read(admin);expect(response.status).toBe(200);const p=manualProspectListSchema.parse(response.body).prospects[0]!;
 expect(p).toMatchObject({candidateId:id,observedName:'Home | Boston Property Management - Contact',presentation:{label:'Boston Property Management',basis:'retained_name',kind:'apparent_company'},observedPhone:'+12145550123',phoneEvidence:{state:'observed',sources:[{runId:run,url:input.sourceUrl,observationId:evidence.observations[0]!.id,blockId:'phone-0',retrievedAt:evidence.observations[0]!.retrievedAt}]},qualification:'unverified',contactAuthority:'not_granted'});
 expect((await read(beta)).body).toEqual({prospects:[],hasMore:false});expect((await read(sales)).status).toBe(403);
 expect((await f.db.query('SELECT to_jsonb(c) row FROM sourcing_candidates c')).rows).toEqual(snapshot);
 for(const table of ['jobs','provider_reservations','firms','contacts','phone_routes','sourcing_admissions','outbound_messages'])expect((await f.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});
it('stale revision, deleted optional source association and malformed facts do not remove the raw authenticated queue',async()=>{
 await f.db.query('UPDATE sourcing_qualification_runs SET candidate_revision=2 WHERE id=$1',[run]);
 expect(manualProspectListSchema.parse((await read(admin)).body).prospects[0]).toMatchObject({candidateId:id,observedPhone:null,phoneEvidence:{state:'not_extracted'}});
 await f.db.query('UPDATE sourcing_qualification_runs SET candidate_revision=1,observations=$2 WHERE id=$1',[run,JSON.stringify([{...evidence.observations[0],url:'https://optional.example.test/not-retained'}])]);
 expect(manualProspectListSchema.parse((await read(admin)).body).prospects[0]).toMatchObject({candidateId:id,observedPhone:null});
 await f.db.query('UPDATE sourcing_qualification_runs SET observations=$2,facts=$3 WHERE id=$1',[run,JSON.stringify(evidence.observations),JSON.stringify([{...evidence.facts[0],blockId:'missing'}])]);
 expect(manualProspectListSchema.parse((await read(admin)).body).prospects[0]).toMatchObject({candidateId:id,observedPhone:null});
});
