import {readFileSync} from 'node:fs';
import {discoveryIntakeSaveInputSchema} from '@fss/contracts';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {dispatch,type ApiRequest} from '../src/server.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';

let f:AuthFixture,admin:string,sales:string,beta:string;
const prepare='/sourcing/candidates/discovery/prepare-v1',read='/sourcing/candidates/discovery/preparation-read-v1';
const envelope=<T extends object>(value:T)=>({...value,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
async function request(path:string,token:string|null,body:unknown,method='POST'){
 return dispatch({method,path,query:new URLSearchParams(),headers:token===null?{}:{authorization:`Bearer ${token}`},body} as ApiRequest,{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:localNoopSuppressionJournal()});
}
const seed={firmName:'Synthetic preparation',website:'https://preparation.example.test',locality:'Austin',region:'TX',signal:'fit_only',evidence:'Synthetic human-entered seed, not native evidence.',sourceUrl:'https://preparation.example.test/services',observedOn:'2026-10-20',preparedBy:'Controlled test'};
async function raw(changes:Record<string,unknown>={}){
 const source={provider:'overture_places',release:'fixture',recordId:randomUUID(),retrievedAt:null,sourceUrl:'https://example.test/source'};
 const row={source,observations:[source],firmName:seed.firmName,website:seed.website,locality:seed.locality,region:seed.region,sourceConfidence:null,residentialFit:'unknown',websiteAssociation:'unknown',officePhoneEvidence:'unknown',probableGroupKey:null,...changes};
 const input={row,origins:[{source,sourceMetadata:{sourcesJson:'[]'},licenses:['fixture'],notices:[{label:'Fixture',url:'https://example.test/license',sha256:'a'.repeat(64)}]}]};
 const saved=await request('/sourcing/candidates/discovery/save-v1',admin,envelope(input));expect(saved.body).toMatchObject({status:'accepted'});
 const id=(saved.body as {result:{id:string}}).result.id;
 return {id,input,command:envelope({discoveryCandidateId:id,expectedRevision:1,source:{provider:source.provider,release:source.release,recordId:source.recordId},candidate:{...seed,firmName:row.firmName,website:row.website,locality:row.locality,region:row.region}})};
}
beforeAll(async()=>{f=await createAuthFixture();admin=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;sales=(await issueSessionFor(f,f.alpha,f.alpha.salesperson)).accessToken;beta=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;});
afterAll(async()=>{await f.stop();});

const link='/sourcing/candidates/discovery/link-research-firm-v1',researchRead='/sourcing/candidates/discovery/research-firm-read-v1';
async function prepareAndCreate(name:string,site:string){
 const r=await raw({firmName:name,website:site});
 const prepared=await request(prepare,admin,r.command);expect(prepared.body).toMatchObject({status:'accepted'});
 const qualificationCandidateId=(prepared.body as {result:{qualificationCandidateId:string}}).result.qualificationCandidateId;
 const create=envelope({firm:{name,website:site}});
 const made=await request('/crm/firms/add',admin,create);expect(made.body).toMatchObject({status:'accepted',result:{contactId:null,routeIds:[]}});
 const firmId=(made.body as {result:{firmId:string}}).result.firmId;
 expect((await request('/crm/firms/add',admin,create)).body).toMatchObject({replayed:true,result:{firmId}});
 return {...r,firmId,linkCommand:envelope({discoveryCandidateId:r.id,expectedRevision:1,qualificationCandidateId,firmId})};
}

it('links an ordinary owner research draft and reads actual Today without phone, zone or DNC prerequisites',async()=>{
 const r=await prepareAndCreate('Synthetic research draft','https://research-draft.example.test');
 const first=await request(link,admin,r.linkCommand);expect(first.body).toMatchObject({status:'accepted',result:{firmId:r.firmId,qualified:false,admissionAuthorized:false,runtimeCallable:false,nextAction:'review_firm_research'}});
 expect((await request(link,admin,r.linkCommand)).body).toMatchObject({status:'accepted',replayed:true,result:{firmId:r.firmId}});
 expect((await request(link,admin,{...r.linkCommand,commandId:randomUUID()})).body).toMatchObject({result:{alreadyLinked:true}});
 expect((await request(researchRead,admin,{candidateId:r.id})).body).toMatchObject({firmId:r.firmId,qualified:false});
 const today=await request('/today',admin,undefined,'GET');expect(today.status).toBe(200);expect(today.body).toMatchObject({cards:expect.arrayContaining([expect.objectContaining({firmId:r.firmId})])});
 expect((await f.db.query('SELECT assigned_user_id,time_zone FROM firms WHERE workspace_id=$1 AND id=$2',[f.alpha.workspaceId,r.firmId])).rows[0]).toMatchObject({assigned_user_id:f.alpha.admin.userId,time_zone:null});
 expect((await f.db.query('SELECT count(*)::int AS n FROM phone_routes WHERE workspace_id=$1 AND firm_id=$2',[f.alpha.workspaceId,r.firmId])).rows[0]).toEqual({n:0});
 expect((await f.db.query('SELECT count(*)::int AS n FROM sourcing_admissions WHERE workspace_id=$1 AND firm_id=$2',[f.alpha.workspaceId,r.firmId])).rows[0]).toEqual({n:0});
});

it('refuses changed owner, duplicate identity, stale source and mismatched legacy or Firm links',async()=>{
 const r=await prepareAndCreate('Synthetic link fences','https://link-fences.example.test');
 expect((await request(link,beta,r.linkCommand)).body).toMatchObject({reason:'not_found'});
 expect((await request(link,admin,{...r.linkCommand,commandId:randomUUID(),qualificationCandidateId:randomUUID()})).body).toMatchObject({reason:'candidate_changed'});
 await f.db.query('UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2',[f.alpha.workspaceId,r.firmId,f.alpha.salesperson.userId]);
 expect((await request(link,admin,r.linkCommand)).body).toMatchObject({reason:'firm_assigned_elsewhere'});
 await f.db.query('UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2',[f.alpha.workspaceId,r.firmId,f.alpha.admin.userId]);
 const duplicate=(await f.db.query<{id:string}>('INSERT INTO firms(workspace_id,name,website,assigned_user_id) VALUES($1,$2,$3,$4) RETURNING id',[f.alpha.workspaceId,'Synthetic link fences','https://link-fences.example.test',f.alpha.admin.userId])).rows[0]!;
 expect((await request(link,admin,{...r.linkCommand,commandId:randomUUID()})).body).toMatchObject({reason:'firm_identity_ambiguous'});
 await f.db.query('DELETE FROM firms WHERE workspace_id=$1 AND id=$2',[f.alpha.workspaceId,duplicate.id]);
 const accepted=envelope({...r.linkCommand});expect((await request(link,admin,accepted)).body).toMatchObject({status:'accepted'});
 await f.db.query('UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2',[f.alpha.workspaceId,r.firmId,f.alpha.salesperson.userId]);
 expect((await request(link,admin,accepted)).body).toMatchObject({reason:'research_firm_unavailable',replayed:true});
 expect((await request(researchRead,admin,{candidateId:r.id})).status).toBe(404);
});

const retainedInputs=process.env['FSS_RETAINED_DISCOVERY_INPUTS'],retainedPage=process.env['FSS_RETAINED_DISCOVERY_PAGE'];
it.skipIf(!retainedInputs||!retainedPage)('actual retained Tree seed reaches normal owner research draft and Today while qualification stays unknown',async()=>{
 const inputs:unknown=JSON.parse(readFileSync(retainedInputs!,'utf8'));
 if(!Array.isArray(inputs))throw new Error('Expected retained discovery array');
 const selected=inputs.map(value=>discoveryIntakeSaveInputSchema.parse(value)).find(value=>value.row.source.recordId==='28ff4bbf-3596-4ce7-a6ab-92d5ae0dea2f');
 if(!selected)throw new Error('Retained Tree source missing');
 const page=JSON.parse(readFileSync(retainedPage!,'utf8')) as {recordId:string;contentHash:string;retrievedAt:string;sourceUrl:string;fitEvidence:{blockId:string;text:string}[]};
 expect(page.recordId).toBe(selected.row.source.recordId);expect(page.contentHash).toBe('1df9a012e6a2c3b8736e456d9895a66b2e3a20384c82c0cb039ab13e5b59f824');
 const quote=page.fitEvidence.find(block=>block.blockId==='b16')?.text;if(!quote)throw new Error('Actual retained service paragraph missing');
 const saved=await request('/sourcing/candidates/discovery/save-v1',admin,envelope(selected));expect(saved.body).toMatchObject({status:'accepted'});
 const discoveryCandidateId=(saved.body as {result:{id:string}}).result.id;
 const command=envelope({discoveryCandidateId,expectedRevision:1,source:{provider:selected.row.source.provider,release:selected.row.source.release,recordId:selected.row.source.recordId},candidate:{firmName:selected.row.firmName,website:selected.row.website,locality:selected.row.locality,region:selected.row.region,signal:'fit_only',evidence:quote,sourceUrl:page.sourceUrl,observedOn:page.retrievedAt.slice(0,10),preparedBy:'Retained public-business seed review, not native qualification'}});
 const prepared=await request(prepare,admin,command);expect(prepared.body).toMatchObject({status:'accepted',result:{qualificationRequested:false}});
 const qualificationCandidateId=(prepared.body as {result:{qualificationCandidateId:string}}).result.qualificationCandidateId;
 const made=await request('/crm/firms/add',admin,envelope({firm:{name:selected.row.firmName,website:selected.row.website}}));expect(made.body).toMatchObject({status:'accepted',result:{contactId:null,routeIds:[]}});
 const firmId=(made.body as {result:{firmId:string}}).result.firmId;
 expect((await request(link,admin,envelope({discoveryCandidateId,expectedRevision:1,qualificationCandidateId,firmId}))).body).toMatchObject({status:'accepted',result:{firmId,qualified:false}});
 expect((await request('/today',admin,undefined,'GET')).body).toMatchObject({cards:expect.arrayContaining([expect.objectContaining({firmId, lane:'new_firm'})])});
 expect((await f.db.query('SELECT payload FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[f.alpha.workspaceId,discoveryCandidateId])).rows[0]).toEqual({payload:{kind:'discovery-v1',row:selected.row}});
 expect((await request('/sourcing/qualification/read',admin,{candidateId:qualificationCandidateId})).status).toBe(404);
});

it('uses normal authentication, POST and admin boundaries',async()=>{
 const r=await raw();expect((await request(prepare,null,r.command)).status).toBe(401);expect((await request(prepare,admin,r.command,'GET')).status).toBe(405);
 expect((await request(prepare,sales,r.command)).body).toMatchObject({reason:'admin_only'});expect((await request(prepare,beta,r.command)).body).toMatchObject({reason:'not_found'});
});
it('removes source lineage and refuses link replay after source loss without deleting ordinary Firm or Today work',async()=>{
 const r=await prepareAndCreate('Synthetic source loss research','https://research-loss.example.test');
 expect((await request(link,admin,r.linkCommand)).body).toMatchObject({status:'accepted'});
 await f.db.query('DELETE FROM sourcing_candidate_discovery_origins WHERE workspace_id=$1 AND candidate_id=$2',[f.alpha.workspaceId,r.id]);
 expect((await request(link,admin,r.linkCommand)).body).toMatchObject({replayed:true,reason:'research_firm_unavailable'});
 expect((await request(researchRead,admin,{candidateId:r.id})).status).toBe(404);
 expect((await f.db.query('SELECT count(*)::int AS n FROM sourcing_discovery_research_firms WHERE workspace_id=$1 AND firm_id=$2',[f.alpha.workspaceId,r.firmId])).rows[0]).toEqual({n:0});
 expect((await f.db.query('SELECT count(*)::int AS n FROM firms WHERE workspace_id=$1 AND id=$2',[f.alpha.workspaceId,r.firmId])).rows[0]).toEqual({n:1});
 expect((await request('/today',admin,undefined,'GET')).body).toMatchObject({cards:expect.arrayContaining([expect.objectContaining({firmId:r.firmId})])});
});
it('prepares one normal draft, preserves raw and exact provenance, and replays without jobs or CRM writes',async()=>{
 const r=await raw({firmName:'Synthetic replay'}),before=await f.db.query('SELECT count(*)::int AS n FROM firms WHERE workspace_id=$1',[f.alpha.workspaceId]);
 const first=await request(prepare,admin,r.command);expect(first.body).toMatchObject({status:'accepted',result:{discoveryCandidateId:r.id,alreadyPrepared:false,qualificationRequested:false,admissionAuthorized:false,runtimeCallable:false}});
 const legacy=(first.body as {result:{qualificationCandidateId:string}}).result.qualificationCandidateId;
 expect(legacy).not.toBe(r.id);expect((await request(prepare,admin,r.command)).body).toMatchObject({status:'accepted',replayed:true,result:{qualificationCandidateId:legacy}});
 expect((await request(prepare,admin,{...r.command,commandId:randomUUID()})).body).toMatchObject({result:{alreadyPrepared:true,qualificationCandidateId:legacy}});
 expect((await request(read,admin,{candidateId:r.id})).body).toMatchObject({qualificationCandidateId:legacy});
 const retained=await f.db.query('SELECT payload,revision,status FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[f.alpha.workspaceId,r.id]);expect(retained.rows[0]).toEqual({payload:{kind:'discovery-v1',row:r.input.row},revision:1,status:'needs_review'});
 expect((await f.db.query('SELECT count(*)::int AS n FROM firms WHERE workspace_id=$1',[f.alpha.workspaceId])).rows).toEqual(before.rows);
 expect((await f.db.query("SELECT count(*)::int AS n FROM jobs WHERE workspace_id=$1 AND payload->>'candidateId'=$2",[f.alpha.workspaceId,legacy])).rows[0]).toEqual({n:0});
 expect((await request('/sourcing/candidates/list',admin,{status:'needs_review',offset:0})).body).toMatchObject({candidates:expect.arrayContaining([expect.objectContaining({id:legacy,firmName:'Synthetic replay',sourceCheck:null})])});
 expect((await request('/sourcing/qualification/request',admin,envelope({candidateId:legacy,expectedRevision:1}))).body).toMatchObject({status:'accepted'});
 expect((await request('/sourcing/qualification/read',admin,{candidateId:legacy})).body).toMatchObject({status:'pending',observations:[],facts:[],admission:null});
 expect((await request('/sourcing/candidates/check',admin,envelope({id:r.id,expectedRevision:1}))).body).toMatchObject({reason:'candidate_format_not_supported'});
});
it('refuses changed revisions, unknown context, unsupported states and silent HTTPS/city/name inference',async()=>{
 const r=await raw({firmName:'Synthetic mismatch'});
 expect((await request(prepare,admin,{...r.command,expectedRevision:2})).body).toMatchObject({reason:'candidate_changed'});
 expect((await request(prepare,admin,{...r.command,commandId:randomUUID(),candidate:{...r.command.candidate,locality:'Dallas'}})).body).toMatchObject({reason:'discovery_context_mismatch'});
 for(const changes of [{website:null},{locality:null},{website:'preparation.example.test'},{region:'CA'}]){
  const invalid=await raw(changes);expect((await request(prepare,admin,invalid.command)).status).toBe(400);
 }
});
it('refuses fresh conflicting seed and receipt payload conflicts without overwriting either draft',async()=>{
 const r=await raw({firmName:'Synthetic conflict'});expect((await request(prepare,admin,r.command)).body).toMatchObject({status:'accepted'});
 expect((await request(prepare,admin,{...r.command,candidate:{...r.command.candidate,evidence:'Conflicting seed'}})).body).toMatchObject({status:'refused'});
 expect((await request(prepare,admin,{...r.command,commandId:randomUUID(),candidate:{...r.command.candidate,evidence:'Conflicting seed'}})).body).toMatchObject({reason:'preparation_conflict'});
});
it('rehydrates replay under current source lifecycle and refuses deleted origins without historical text',async()=>{
 const r=await raw({firmName:'Synthetic source loss'});expect((await request(prepare,admin,r.command)).body).toMatchObject({status:'accepted'});
 await f.db.query('DELETE FROM sourcing_candidate_discovery_origins WHERE workspace_id=$1 AND candidate_id=$2',[f.alpha.workspaceId,r.id]);
 expect((await request(read,admin,{candidateId:r.id})).status).toBe(404);
 const replay=await request(prepare,admin,r.command);expect(replay.body).toMatchObject({status:'refused',reason:'preparation_unavailable',replayed:true});expect(JSON.stringify(replay.body)).not.toContain(seed.evidence);
 expect((await f.db.query('SELECT count(*)::int AS n FROM sourcing_discovery_promotions WHERE workspace_id=$1 AND raw_candidate_id=$2',[f.alpha.workspaceId,r.id])).rows[0]).toEqual({n:0});
});
it('refuses stale replay after raw dismissal and hides other owner/workspace preparation reads',async()=>{
 const r=await raw({firmName:'Synthetic dismissed'});expect((await request(prepare,admin,r.command)).body).toMatchObject({status:'accepted'});
 expect((await request(read,beta,{candidateId:r.id})).status).toBe(404);expect((await request(read,sales,{candidateId:r.id})).status).toBe(404);
 await request('/sourcing/candidates/review',admin,envelope({id:r.id,expectedRevision:1,status:'dismissed'}));
 expect((await request(prepare,admin,r.command)).body).toMatchObject({status:'refused',reason:'preparation_unavailable'});
});
