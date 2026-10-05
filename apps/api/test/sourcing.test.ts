import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {dispatch,type ApiRequest} from '../src/server.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
let f:AuthFixture,admin:string,sales:string,beta:string;
const input={firmName:'API PM',website:'https://api-pm.test',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Residential manager; need unknown.',sourceUrl:'https://api-pm.test/about',observedOn:'2026-10-01',preparedBy:'Manual research'};
const envelope=(body:object)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
async function request(path:string,token:string|null,body:unknown,method='POST') {
 return await dispatch({method,path,query:new URLSearchParams(),headers:token===null?{}:{authorization:`Bearer ${token}`},body} as ApiRequest,{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:localNoopSuppressionJournal()});
}
beforeAll(async()=>{f=await createAuthFixture();admin=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;sales=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;beta=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;});
afterAll(async()=>{await f.stop();});
it('authenticates the review list and refuses wrong methods and salespeople',async()=>{
 expect((await request('/sourcing/candidates/list',null,{status:'needs_review',offset:0})).status).toBe(401);
 expect((await request('/sourcing/candidates/list',sales,{status:'needs_review',offset:0})).status).toBe(403);
 expect((await request('/sourcing/candidates/list',admin,{},'GET')).status).toBe(405);
});
it('persists a candidate once across receipt replay and never exposes it in another workspace',async()=>{
 const command=envelope(input);
 const first=await request('/sourcing/candidates/save',admin,command);
 expect(first.status).toBe(200);
 expect(first.body).toMatchObject({status:'accepted',result:{duplicate:false}});
 const replay=await request('/sourcing/candidates/save',admin,command);
 expect(replay.body).toMatchObject({replayed:true});
 const list=await request('/sourcing/candidates/list',admin,{status:'needs_review',offset:0});
 expect(list.body).toMatchObject({candidates:[{firmName:'API PM',status:'needs_review'}]});
 expect((await request('/sourcing/candidates/list',beta,{status:'needs_review',offset:0})).body).toMatchObject({candidates:[]});
 const id=(first.body as {result:{id:string}}).result.id;
 expect((await request('/sourcing/candidates/review',beta,envelope({id,expectedRevision:1,status:'kept'}))).body).toMatchObject({reason:'not_found'});
 expect((await request('/sourcing/candidates/review',admin,envelope({id,expectedRevision:1,status:'kept'}))).status).toBe(200);
 expect((await request('/sourcing/candidates/delete',admin,envelope({id,expectedRevision:2}))).status).toBe(200);
});
it('refuses malformed evidence before saving it',async()=>{
 expect((await request('/sourcing/candidates/save',admin,envelope({...input,sourceUrl:'javascript:alert(1)'}))).status).toBe(400);
 expect((await request('/sourcing/candidates/save',sales,envelope(input))).body).toMatchObject({reason:'admin_only'});
});

it('queues a source check once and returns only its candidate id',async()=>{
 const first=await request('/sourcing/candidates/save',admin,envelope(input));
 const id=(first.body as {result:{id:string}}).result.id;
 const check=envelope({id,expectedRevision:1});
 expect((await request('/sourcing/candidates/check',sales,envelope({id,expectedRevision:1}))).body).toMatchObject({reason:'admin_only'});
 expect((await request('/sourcing/candidates/check',admin,check)).body).toMatchObject({status:'accepted',result:{id}});
 expect((await request('/sourcing/candidates/check',admin,check)).body).toMatchObject({replayed:true});
});
it('exposes revision-bound qualification and reviewed admission through authenticated receipts',async()=>{
 const saved=await request('/sourcing/candidates/save',admin,envelope({...input,firmName:'Qualified API PM'}));const candidateId=(saved.body as {result:{id:string}}).result.id;
 expect((await request('/sourcing/qualification/read',null,{candidateId})).status).toBe(401);
 const command=envelope({candidateId,expectedRevision:1});
 const queued=await request('/sourcing/qualification/request',admin,command);expect(queued.body).toMatchObject({status:'accepted'});
 expect((await request('/sourcing/qualification/request',admin,command)).body).toMatchObject({replayed:true});
 const runId=(queued.body as {result:{runId:string}}).result.runId;
 expect((await request('/sourcing/qualification/read',admin,{candidateId})).body).toMatchObject({runId,status:'pending'});
 expect((await request('/sourcing/qualification/read',beta,{candidateId})).status).toBe(404);
 expect((await request('/sourcing/qualification/read',sales,{candidateId})).status).toBe(404);
 expect((await request('/sourcing/qualification/admit',admin,envelope({candidateId,expectedRevision:1,qualificationRunId:runId,mode:'reviewed'}))).body).toMatchObject({reason:'evidence_unavailable'});
 expect((await request('/sourcing/qualification/admit',admin,envelope({candidateId,expectedRevision:1,qualificationRunId:runId,mode:'automatic'}))).status).toBe(400);
});
