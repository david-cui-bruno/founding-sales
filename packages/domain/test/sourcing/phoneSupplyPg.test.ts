import {createHash} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestProspectPhoneDiscovery,runProspectPhoneDiscovery,readProspectPhoneDiscovery} from '../../sourcing/prospectPhoneDiscovery.ts';
import {listManualProspects} from '../../sourcing/manualProspects.ts';
import {rememberExpiredManualSources} from '../../sourcing/manualProspectSourceLoss.ts';
import {manualOrdinaryFixture} from './support/manualProspectFixture.ts';
import type {PageFetchProvider,PageFetchRequest} from '../../research/providers.ts';
import {phoneSupplyObservation as observation,phoneSupplyHtml as html,PHONE_SUPPLY_SITE as website} from './phoneSupplyFixtures.ts';
import {REQUIRED_SCHEMA} from '../../db/schemaRange.ts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
let serial=0;
const ctx=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),runtime);
const worker=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),runtime);
beforeAll(async()=>{db=await createTestDatabase();expect((await db.session.query<{version:number}>('SELECT max(version) version FROM schema_versions')).rows[0]!.version).toBe(REQUIRED_SCHEMA);seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM jobs');await db.session.query('DELETE FROM research_settings');});
afterAll(async()=>{await db.drop();});
async function valid(texts:string[]){
 const content={website,sourceUrls:[website],observations:[observation(texts)]};
 return (await runtime.query<{valid:boolean}>('SELECT prospect_phone_content_valid($1::jsonb) valid',[JSON.stringify(content)])).rows[0]!.valid;
}
async function candidate(){
 const input=manualOrdinaryFixture(++serial);input.sourceUrl=input.website+'about';
 const saved=await withTransaction(runtime,()=>saveCandidate(ctx(),input));if(!saved.ok)throw Error(saved.reason);
 const requested=await withTransaction(runtime,()=>requestProspectPhoneDiscovery(ctx(),{candidateId:saved.value.id,expectedRevision:1}));if(!requested.ok)throw Error(requested.reason);
 return {id:saved.value.id,runId:requested.value.runId,input};
}
function provider(site:string,texts:string[],before?:((request:PageFetchRequest)=>Promise<void>)):PageFetchProvider{
 return {providerKey:'controlled-phone-capacity',fetchPages:async input=>{
  await before?.(input);
  const body=new TextEncoder().encode(html(texts)),url=site+'contact';
  if(!await input.shouldContinue?.()||!await input.mayFetchUrl?.(url))return {ok:true,value:{pages:[],skipped:{source_authority_refused:1}},costCents:0};
  return {ok:true,value:{pages:[{url,body,contentType:'text/html',contentHash:createHash('sha256').update(body).digest('hex'),retrievedAt:new Date().toISOString(),firstParty:true}],skipped:{}},costCents:0};
 }};
}
const read=(id:string)=>withTransaction(runtime,()=>readProspectPhoneDiscovery(ctx(),{candidateId:id,expectedRevision:1}));
it('actual app_runtime validator accepts exact phone capacities and rejects each one-over with UTF16/separator parity',async()=>{
 expect(await valid(Array.from({length:256},()=> 'Published text'))).toBe(true);
 expect(await valid(Array.from({length:257},()=> 'Published text'))).toBe(false);
 expect(await valid(['a'.repeat(16000)])).toBe(true);expect(await valid(['a'.repeat(16001)])).toBe(false);
 expect(await valid(['🏠'.repeat(8000)])).toBe(true);expect(await valid(['🏠'.repeat(8000)+'a'])).toBe(false);
 const exact=['a'.repeat(16000),'b'.repeat(16000),'c'.repeat(16000),'d'.repeat(1994)];
 expect(await valid(exact)).toBe(true);expect(await valid([...exact.slice(0,3),exact[3]+'a'])).toBe(false);
});
it('actual app_runtime validator retains hash/shape/host/unique/aggregate rejection',async()=>{
 const source=observation(['a'.repeat(4100)+' Phone: 214-555-0123']);
 for(const change of [{relevantTextHash:'b'.repeat(64)},{url:'https://other.example.test/'},{firstParty:false},{truncated:true},{extra:'not allowed'},
  {blocks:[source.blocks[0],source.blocks[0]]}]){
  const content={website,sourceUrls:[website],observations:[{...source,...change}]};
  expect((await runtime.query<{valid:boolean}>('SELECT prospect_phone_content_valid($1::jsonb) valid',[JSON.stringify(content)])).rows[0]!.valid).toBe(false);
 }
 const large=Array.from({length:3},(_,index)=>observation(['a'.repeat(16000),'b'.repeat(16000),'c'.repeat(12000)],index+2));
 expect((await runtime.query<{valid:boolean}>('SELECT prospect_phone_content_valid($1::jsonb) valid',[JSON.stringify({website,sourceUrls:[website],observations:large})])).rows[0]!.valid).toBe(false);
});
it.each([
 ['whole block',['a'.repeat(4100)+' Office phone: 214-555-0123']],
 ['101 blocks',['Office phone: 214-555-0123',...Array.from({length:100},()=> 'Published text')]],
 ['over12000 chars',['Office phone: 214-555-0123',...Array.from({length:4},()=> 'a'.repeat(3000))]],
] as const)('request/worker/save/read/list persist complete %s through current app_runtime guards',async(_label,texts)=>{
 const c=await candidate();
 await runProspectPhoneDiscovery(worker(),{runId:c.runId},{pageFetch:provider(c.input.website!,[...texts])});
 expect(await read(c.id)).toMatchObject({ok:true,value:{state:'complete',phoneEvidence:{state:'observed',value:'+12145550123',coverage:{state:'complete',blocks:texts.length}},channelAuthority:'not_granted'}});
 const raw=(await runtime.query<{content:{observations:ReturnType<typeof observation>[]}}>('SELECT content FROM sourcing_prospect_phone_discoveries WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,c.runId])).rows[0]!.content;
 expect(raw.observations[0]!.blocks).toEqual(texts.map((text,index)=>({id:`b${index+1}`,text})));
 expect(raw.observations[0]!.relevantTextHash).toBe(createHash('sha256').update(JSON.stringify(raw.observations[0]!.blocks)).digest('hex'));
 expect(await withTransaction(runtime,()=>listManualProspects(ctx(),{state:'all',offset:0}))).toMatchObject({ok:true,value:{prospects:[{candidateId:c.id,observedPhone:'+12145550123',qualification:'unverified',contactAuthority:'not_granted'}]}});
 for(const table of ['sourcing_qualification_runs','sourcing_admissions','firms','phone_routes','provider_reservations','outbound_messages','sequence_enrollments'])expect((await runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});
it('long-block fax context is persisted whole and remains conflicting through read/list',async()=>{
 const c=await candidate(),text=`Fax ${'a'.repeat(4100)} Office phone: 214-555-0123`;
 await runProspectPhoneDiscovery(worker(),{runId:c.runId},{pageFetch:provider(c.input.website!,[text])});
 expect(await read(c.id)).toMatchObject({ok:true,value:{state:'complete',phoneEvidence:{state:'conflicting',sources:[{normalizedValue:null}]}}});
 expect(await withTransaction(runtime,()=>listManualProspects(ctx(),{state:'all',offset:0}))).toMatchObject({ok:true,value:{prospects:[{observedPhone:null,phoneBasis:'unknown'}]}});
});
it.each([
 ['block length',['Office phone: 214-555-0123','a'.repeat(16001)]],
 ['block count',['Office phone: 214-555-0123',...Array.from({length:256},()=> 'Published text')]],
 ['page text',['a'.repeat(16000),'b'.repeat(16000),'c'.repeat(16000),'d'.repeat(1995)]],
] as const)('worker refuses complete %s overflow without persisting a selected prefix',async(_label,texts)=>{
 const c=await candidate();
 await runProspectPhoneDiscovery(worker(),{runId:c.runId},{pageFetch:provider(c.input.website!,[...texts])});
 expect(await read(c.id)).toMatchObject({ok:true,value:{state:'unavailable',reason:'bounded_capture_incomplete',phoneEvidence:{state:'not_extracted'}}});
 const raw=(await runtime.query<{content:unknown}>('SELECT content FROM sourcing_prospect_phone_discoveries WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,c.runId])).rows[0]!;
 expect(raw.content).toBeNull();
 expect(await withTransaction(runtime,()=>listManualProspects(ctx(),{state:'all',offset:0}))).toMatchObject({ok:true,value:{prospects:[{observedPhone:null,phoneBasis:'unknown'}]}});
});
it.each(['byte','page'] as const)('current lower %s budget during fetch refuses full larger capture before save',async kind=>{
 const c=await candidate();
 const before=async()=>{await runtime.query(kind==='byte'?'INSERT INTO research_settings(workspace_id,max_page_bytes) VALUES($1,10000)':'INSERT INTO research_settings(workspace_id,max_pages_per_firm) VALUES($1,1)',[seed.alpha.workspaceId]);};
 await runProspectPhoneDiscovery(worker(),{runId:c.runId},{pageFetch:provider(c.input.website!,['a'.repeat(4100)+' Office phone: 214-555-0123'],before)});
 expect(await read(c.id)).toMatchObject({ok:true,value:{state:'unavailable',reason:'bounded_capture_incomplete'}});
 const raw=(await runtime.query<{content:unknown}>('SELECT content FROM sourcing_prospect_phone_discoveries WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,c.runId])).rows[0]!;expect(raw.content).toBeNull();
});
it('source loss erases the whole larger original and never replays the completed capture',async()=>{
 const c=await candidate();let fetches=0;
 const p=provider(c.input.website!,['a'.repeat(4100)+' Office phone: 214-555-0123'],async()=>{fetches++;});
 await runProspectPhoneDiscovery(worker(),{runId:c.runId},{pageFetch:p});
 expect(await read(c.id)).toMatchObject({ok:true,value:{state:'complete'}});
 await withTransaction(runtime,()=>rememberExpiredManualSources(ctx(),[c.input.website+'contact']));
 const raw=(await runtime.query<{state:string;content:unknown}>('SELECT state,content FROM sourcing_prospect_phone_discoveries WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,c.runId])).rows[0]!;
 expect(raw).toMatchObject({state:'unavailable',content:null});
 await runProspectPhoneDiscovery(worker(),{runId:c.runId},{pageFetch:p});expect(fetches).toBe(1);
 expect(await read(c.id)).toMatchObject({ok:true,value:{state:'unavailable',phoneEvidence:{state:'not_extracted'}}});
});
