import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {dispatch,type ApiRequest} from '../src/server.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
let f:AuthFixture,admin:string,sales:string,beta:string;
const source={provider:'overture_places',recordId:'synthetic-api',release:'fixture',retrievedAt:null,sourceUrl:'https://example.test/source'};
const input={row:{source,observations:[source],firmName:'Synthetic discovery',website:null,locality:null,region:'CA',sourceConfidence:null,residentialFit:'unknown',websiteAssociation:'unknown',officePhoneEvidence:'unknown',probableGroupKey:null},origins:[{source,sourceMetadata:{sourcesJson:'[]'},licenses:['fixture'],notices:[{label:'Fixture',url:'https://example.test/license',sha256:'a'.repeat(64)}]}]};
const envelope=(body:object)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
async function request(path:string,token:string|null,body:unknown,method='POST'){return dispatch({method,path,query:new URLSearchParams(),headers:token===null?{}:{authorization:`Bearer ${token}`},body} as ApiRequest,{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:localNoopSuppressionJournal()});}
const save='/sourcing/candidates/discovery/save-v1',list='/sourcing/candidates/discovery/list-v1';
beforeAll(async()=>{f=await createAuthFixture();admin=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;sales=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;beta=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;});
afterAll(async()=>{await f.stop();});
it('authenticates versioned discovery and refuses unsupported methods or roles',async()=>{
 expect((await request(save,null,envelope(input))).status).toBe(401);expect((await request(list,sales,{status:'needs_review',offset:0})).status).toBe(403);expect((await request(list,admin,{},'GET')).status).toBe(405);
 expect((await request(save,sales,envelope(input))).body).toMatchObject({reason:'admin_only'});
});
it('persists nullable nationwide discovery through receipt replay with isolated provenance and no legacy exposure',async()=>{
 const command=envelope(input),first=await request(save,admin,command);expect(first.status).toBe(200);expect(first.body).toMatchObject({status:'accepted',result:{newlyPersisted:1,observationsAttached:1}});
 expect((await request(save,admin,command)).body).toMatchObject({replayed:true});expect((await request(save,admin,envelope(input))).body).toMatchObject({result:{exactDuplicates:1,newlyPersisted:0}});
 expect((await request(list,admin,{status:'needs_review',offset:0})).body).toMatchObject({candidates:[{payload:{kind:'discovery-v1',row:input.row},origins:input.origins}],hasMore:false});
 expect((await request(list,beta,{status:'needs_review',offset:0})).body).toMatchObject({candidates:[]});expect((await request('/sourcing/candidates/list',admin,{status:'needs_review',offset:0})).body).toMatchObject({candidates:[]});
 const id=(first.body as {result:{id:string}}).result.id;
 expect((await request('/sourcing/candidates/review',admin,envelope({id,expectedRevision:1,status:'kept'}))).body).toMatchObject({reason:'candidate_format_not_supported'});
 expect((await request('/sourcing/candidates/check',admin,envelope({id,expectedRevision:1}))).body).toMatchObject({reason:'candidate_format_not_supported'});
});
it('rejects forged fit and unrelated contact fields before command execution',async()=>{
 expect((await request(save,admin,envelope({...input,row:{...input.row,residentialFit:'supported'}}))).status).toBe(400);
 expect((await request(save,admin,envelope({...input,row:{...input.row,email:'person@example.test'}}))).status).toBe(400);
 expect((await request(list,admin,{status:'needs_review',offset:-1})).status).toBe(400);
});
