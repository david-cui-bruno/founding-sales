import {createHash} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestProspectPhoneDiscovery,readProspectPhoneDiscovery,runProspectPhoneDiscovery} from '../../sourcing/prospectPhoneDiscovery.ts';
import {manualOrdinaryFixture,manualDiscoveryFixture} from './support/manualProspectFixture.ts';
import {manualPhoneFixture,seedManualPhoneRun} from './support/manualPhoneFixture.ts';
import {saveDiscoveryCandidate} from '../../sourcing/discoveryIntake.ts';
import {listManualProspects} from '../../sourcing/manualProspects.ts';
import {MANUAL_SOURCE_LOSS_ACTION} from '../../sourcing/manualProspectSourceLoss.ts';
import type {PageFetchProvider,PageFetchRequest} from '../../research/providers.ts';
let db:TestDatabase,runtime:SessionQueryable,seed:TwoWorkspaces,serial=2000;
const ctx=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),runtime);
const worker=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),runtime);
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
afterAll(async()=>db?.drop());
async function fixture(){
 const input=manualOrdinaryFixture(++serial);input.sourceUrl=`${input.website}about`;
 const saved=await withTransaction(runtime,()=>saveCandidate(ctx(),input));if(!saved.ok)throw Error(saved.reason);
 const id=saved.value.id;
 return {id,website:input.website!,sourceUrl:input.sourceUrl,input:{candidateId:id,expectedRevision:1}};
}
async function deny(url:string){
 // An already retained native source-loss audit, without relying on erasure as a
 // substitute for the fresh acquisition checks under test.
 await runtime.query("INSERT INTO audit_events(workspace_id,actor_kind,actor_user_id,action,subject_kind,subject_id,detail) VALUES($1,'user',$2,$3,'sourcing_source_hash',$4,'{}')",
 [seed.alpha.workspaceId,seed.alpha.admin.userId,MANUAL_SOURCE_LOSS_ACTION,createHash('sha256').update(url.replace(/\/+$/u,'')).digest('hex')]);
}
async function evidence(url:string,expiresAt:Date){
 const firm=(await runtime.query<{id:string}>('INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,$2,$3) RETURNING id',[seed.alpha.workspaceId,'Synthetic website expiry fixture',seed.alpha.admin.userId])).rows[0]!.id;
 await runtime.query("INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at) VALUES($1,$2,'website',$3,$4,false,$5)",[seed.alpha.workspaceId,firm,url,'a'.repeat(64),expiresAt]);
}
function provider(website:string,skipped:Record<string,number>={},before?:((request:PageFetchRequest)=>Promise<void>)):PageFetchProvider{
 return {providerKey:'controlled-review-page',fetchPages:async input=>{
  await before?.(input);
  const body=new TextEncoder().encode('Office phone: (214) 555-0123');
  return {ok:true,value:{pages:[{url:`${website}contact`,body,contentHash:createHash('sha256').update(body).digest('hex'),contentType:'text/plain',firstParty:true,retrievedAt:new Date().toISOString()}],skipped},costCents:0};
 }};
}
const request=(input:{candidateId:string;expectedRevision:number})=>withTransaction(runtime,()=>requestProspectPhoneDiscovery(ctx(),input));
const read=(input:{candidateId:string;expectedRevision:number})=>withTransaction(runtime,()=>readProspectPhoneDiscovery(ctx(),input));
it.each(['audit','expired_evidence'] as const)('SPEC S1 denied explicit website with distinct sourceUrl refuses before request and dispatch: %s',async mode=>{
 const f=await fixture();expect(f.website).not.toBe(f.sourceUrl);
 if(mode==='audit')await deny(f.website);else await evidence(f.website,new Date(Date.now()-1000));
 let calls=0;const result=await request(f.input);
 if(result.ok)await runProspectPhoneDiscovery(worker(),{runId:result.value.runId},{pageFetch:provider(f.website,{},async()=>{calls++;})});
 expect(calls).toBe(0);expect(result).toEqual({ok:false,reason:'source_not_permitted'});
});
it('SPEC S1 website denial after request but before claim performs zero provider IO',async()=>{
 const f=await fixture(),result=await request(f.input);if(!result.ok)throw Error(result.reason);
 await deny(f.website);let calls=0;
 await runProspectPhoneDiscovery(worker(),{runId:result.value.runId},{pageFetch:provider(f.website,{},async()=>{calls++;})});
 expect(calls).toBe(0);expect(await read(f.input)).toMatchObject({ok:true,value:{state:'unavailable',reason:'source_not_permitted'}});
});
it('SPEC S1 website denial at a provider continuation refuses any further capture and erases the prefix',async()=>{
 const f=await fixture(),result=await request(f.input);if(!result.ok)throw Error(result.reason);
 await runProspectPhoneDiscovery(worker(),{runId:result.value.runId},{pageFetch:provider(f.website,{},async input=>{
  await deny(f.website);expect(await input.shouldContinue?.()).toBe(false);
 })});
 expect(await read(f.input)).toMatchObject({ok:true,value:{state:'unavailable',reason:'source_not_permitted'}});
 expect((await runtime.query('SELECT content FROM sourcing_prospect_phone_discoveries WHERE id=$1',[result.value.runId])).rows[0]?.['content']).toBeNull();
});
it('SPEC S1 website shorter expiry is preserved without treating an unrelated same-host denied URL as a grant or denial',async()=>{
 const f=await fixture(),expiry=new Date(Date.now()+3600000);
 await evidence(f.website,expiry);await deny(`${f.website}unrelated-private-path`);
 const result=await request(f.input);if(!result.ok)throw Error(result.reason);
 const stored=(await runtime.query<{expires_at:Date;content:{sourceUrls:string[]}}>('SELECT expires_at,content FROM sourcing_prospect_phone_discoveries WHERE id=$1',[result.value.runId])).rows[0]!;
 expect(stored.expires_at.toISOString()).toBe(expiry.toISOString());expect(stored.content.sourceUrls).toEqual([f.sourceUrl.replace(/\/+$/u,'')]);
 await runProspectPhoneDiscovery(worker(),{runId:result.value.runId},{pageFetch:provider(f.website)});
 expect(await read(f.input)).toMatchObject({ok:true,value:{state:'complete',expiresAt:expiry.toISOString(),phoneEvidence:{state:'observed'}}});
});
it('SPEC S2 actual provider pages plus skipped.page_over_bound cannot persist a selected-prefix phone',async()=>{
 const f=await fixture(),result=await request(f.input);if(!result.ok)throw Error(result.reason);
 await runProspectPhoneDiscovery(worker(),{runId:result.value.runId},{pageFetch:provider(f.website,{page_over_bound:1})});
 expect(await read(f.input)).toMatchObject({ok:true,value:{state:'unavailable',reason:'bounded_capture_incomplete'}});
 expect((await runtime.query('SELECT content FROM sourcing_prospect_phone_discoveries WHERE id=$1',[result.value.runId])).rows[0]?.['content']).toBeNull();
});
it.each([503,500,599])('STD2 HTTP5xx published contact status_%i cannot select the surviving good homepage',async status=>{
 const f=await fixture(),result=await request(f.input);if(!result.ok)throw Error(result.reason);
 const contact=`${f.website}contact`,attempted:string[]=[];
 const pageFetch:PageFetchProvider={providerKey:'controlled-published-contact-http-failure',fetchPages:async input=>{
  // Match the actual adapter's successful pages/skipped envelope: the homepage
  // publishes an in-scope contact link, whose attempted request fails with 5xx.
  for(const url of [f.website,contact]){
   if(!input.mayFetchUrl||!await input.mayFetchUrl(url))throw Error('missing current destination authority');
   attempted.push(url);
  }
  const body=new TextEncoder().encode('<html><body><p>Office phone: (214) 555-0123</p><a href="/contact">Contact us</a></body></html>');
  return {ok:true,value:{pages:[{url:f.website,body,contentHash:createHash('sha256').update(body).digest('hex'),contentType:'text/html',firstParty:true,retrievedAt:new Date().toISOString()}],skipped:{[`status_${status}`]:1}},costCents:0};
 }};
 await runProspectPhoneDiscovery(worker(),{runId:result.value.runId},{pageFetch});
 expect(attempted).toEqual([f.website,contact]);
 expect(await read(f.input)).toMatchObject({ok:true,value:{state:'unavailable',reason:'discovery_interrupted',phoneEvidence:{state:'not_extracted'}}});
 const stored=(await runtime.query<{state:string;content:unknown;dispatch_finished_at:Date|null}>('SELECT state,content,dispatch_finished_at FROM sourcing_prospect_phone_discoveries WHERE id=$1',[result.value.runId])).rows[0]!;
 expect(stored.state).toBe('unavailable');expect(stored.content).toBeNull();expect(stored.dispatch_finished_at).toBeInstanceOf(Date);
});
it('STD4 explicit read and retained list both refuse competing qualification124 and discovery123',async()=>{
 const f=await fixture();await seedManualPhoneRun(db.session,seed.alpha.workspaceId,f.id,manualPhoneFixture(f.sourceUrl,['2145550124']));
 const result=await request(f.input);if(!result.ok)throw Error(result.reason);
 await runProspectPhoneDiscovery(worker(),{runId:result.value.runId},{pageFetch:provider(f.website)});
 const current=await read(f.input),listed=await withTransaction(runtime,()=>listManualProspects(ctx(),{state:'all',offset:0}));
 if(!listed.ok)throw Error(listed.reason);
 const prospect=listed.value.prospects.find(row=>row.candidateId===f.id)!;
 expect(prospect.observedPhone).toBeNull();expect(prospect.phoneEvidence).toMatchObject({state:'conflicting',sources:[{},{}]});
 expect(current).toMatchObject({ok:true,value:{state:'complete',phoneEvidence:prospect.phoneEvidence}});
});
it.each(['ambiguous','absent'] as const)('STD4 explicit read preserves current raw %s declaration instead of selecting discovery phone',async declaration=>{
 const f=await fixture(),raw=manualDiscoveryFixture(`std4-${++serial}`);raw.row.website=f.website;
 const saved=await withTransaction(runtime,()=>saveDiscoveryCandidate(ctx(),raw));if(!saved.ok)throw Error(saved.reason);
 // Intake cannot assert first-party support. Seed the already-retained declaration
 // directly to exercise current-read composition, not the intake command contract.
 await db.session.query("UPDATE sourcing_candidates SET payload=jsonb_set(payload,'{row,officePhoneEvidence}',to_jsonb($2::text)) WHERE id=$1",[saved.value.id,declaration]);
 const input={candidateId:saved.value.id,expectedRevision:1},result=await request(input);if(!result.ok)throw Error(result.reason);
 await runProspectPhoneDiscovery(worker(),{runId:result.value.runId},{pageFetch:provider(f.website)});
 expect(await read(input)).toMatchObject({ok:true,value:{state:'complete',phoneEvidence:{state:'conflicting',reason:'retained_source_ambiguous'}}});
});
it.each([false,true])('STD4 explicit read keeps supported standalone or matching current evidence with honest provenance, matching=%s',async matching=>{
 const f=await fixture();if(matching)await seedManualPhoneRun(db.session,seed.alpha.workspaceId,f.id,manualPhoneFixture(f.sourceUrl,['2145550123']));
 const result=await request(f.input);if(!result.ok)throw Error(result.reason);
 await runProspectPhoneDiscovery(worker(),{runId:result.value.runId},{pageFetch:provider(f.website)});
 const value=await read(f.input);expect(value).toMatchObject({ok:true,value:{phoneEvidence:{state:'observed',value:'+12145550123'}}});
 if(!value.ok||!value.value)throw Error('missing STD4 view');
 if(value.value.phoneEvidence.state!=='observed')throw Error('missing observed evidence');
 expect(value.value.phoneEvidence.sources).toHaveLength(matching?2:1);
});
it('STD4 explicit read waits on retained source custody and cannot choose discovery after that dependency disappears',async()=>{
 const f=await fixture(),legacy=manualPhoneFixture(`https://optional-source.example.test/phone-${++serial}`,['2145550124']);
 await seedManualPhoneRun(db.session,seed.alpha.workspaceId,f.id,legacy);
 const source=legacy.observations[0]!;
 const firm=(await runtime.query<{id:string}>('INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,$2,$3) RETURNING id',[seed.alpha.workspaceId,'STD4 synthetic original parent',seed.alpha.admin.userId])).rows[0]!.id;
 const evidenceId=(await runtime.query<{id:string}>("INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,retrieved_at) VALUES($1,$2,'website',$3,$4,$5) RETURNING id",[seed.alpha.workspaceId,firm,source.url,source.contentHash,source.retrievedAt])).rows[0]!.id;
 const result=await request(f.input);if(!result.ok)throw Error(result.reason);
 await runProspectPhoneDiscovery(worker(),{runId:result.value.runId},{pageFetch:provider(f.website)});
 const other=await db.appRuntimeSession(),pid=(await runtime.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 await other.query('BEGIN');await other.query('DELETE FROM evidence_items WHERE id=$1',[evidenceId]);
 let settled=false,waited=false;
 const reading=read(f.input).finally(()=>{settled=true;});
 try{
  for(let attempt=0;attempt<100&&!settled;attempt++){
   waited=(await db.session.query<{waiting:boolean}>("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting??false;
   if(waited)break;
   await new Promise(resolve=>setTimeout(resolve,5));
  }
 }finally{await other.query('COMMIT');}
 const value=await reading;expect(waited).toBe(true);
 expect(value).toMatchObject({ok:true,value:{state:'complete',phoneEvidence:{state:'not_extracted',reason:'optional_source_changed',coverage:{state:'changed'}}}});
});
it.each(['firm_timeout','paused','request_failed','robots_unreadable','source_authority_refused'] as const)('RISK R2 interrupted provider prefix %s cannot become complete evidence',async reason=>{
 const f=await fixture(),result=await request(f.input);if(!result.ok)throw Error(result.reason);
 await runProspectPhoneDiscovery(worker(),{runId:result.value.runId},{pageFetch:provider(f.website,{[reason]:1})});
 expect(await read(f.input)).toMatchObject({ok:true,value:{state:'unavailable',reason:reason==='source_authority_refused'?'source_not_permitted':'discovery_interrupted'}});
 expect((await runtime.query('SELECT content FROM sourcing_prospect_phone_discoveries WHERE id=$1',[result.value.runId])).rows[0]?.['content']).toBeNull();
});
it.each(['contact','redirect-destination','robots.txt'] as const)('RISK R1 exact denied discovered or redirect destination %s has zero body requests',async path=>{
 const f=await fixture(),destination=`${f.website}${path}`;await deny(destination);
 const result=await request(f.input);if(!result.ok)throw Error(result.reason);
 let bodies=0,hook=false;
 const pageFetch:PageFetchProvider={providerKey:'controlled-exact-destination',fetchPages:async input=>{
  hook=typeof input.mayFetchUrl==='function';
  if(!input.mayFetchUrl||await input.mayFetchUrl(destination)){bodies++;return provider(f.website).fetchPages(input);}
  const prefix=await provider(f.website).fetchPages(input);if(!prefix.ok)return prefix;
  return {...prefix,value:{...prefix.value,skipped:{source_authority_refused:1}}};
 }};
 await runProspectPhoneDiscovery(worker(),{runId:result.value.runId},{pageFetch});
 expect(hook).toBe(true);expect(bodies).toBe(0);
 expect(await read(f.input)).toMatchObject({ok:true,value:{state:'unavailable',reason:'source_not_permitted'}});
});
it('RISK R1 exact destination shorter expiry commits before the simulated HTTP body phase',async()=>{
 const f=await fixture(),destination=`${f.website}contact`,expiry=new Date(Date.now()+1800000);
 const result=await request(f.input);if(!result.ok)throw Error(result.reason);
 await evidence(destination,expiry);
 const pid=(await runtime.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 let permission:boolean|undefined,committedExpiry:string|undefined,idle=false;
 await runProspectPhoneDiscovery(worker(),{runId:result.value.runId},{pageFetch:provider(f.website,{},async input=>{
  permission=await input.mayFetchUrl?.(destination);
  committedExpiry=(await db.session.query<{expires_at:Date}>('SELECT expires_at FROM sourcing_prospect_phone_discoveries WHERE id=$1',[result.value.runId])).rows[0]!.expires_at.toISOString();
  idle=(await db.session.query<{state:string}>('SELECT state FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.state==='idle';
 })});
 expect(permission).toBe(true);expect(committedExpiry).toBe(expiry.toISOString());expect(idle).toBe(true);
 expect(await read(f.input)).toMatchObject({ok:true,value:{state:'complete',expiresAt:expiry.toISOString()}});
});
it.each(['page_budget_reached','robots_disallowed','url_not_permitted','address_not_public','url_has_query','status_404'] as const)('SPEC S2 intentional bound or unrelated policy skip %s does not reject current bounded originals',async reason=>{
 const f=await fixture(),result=await request(f.input);if(!result.ok)throw Error(result.reason);
 await runProspectPhoneDiscovery(worker(),{runId:result.value.runId},{pageFetch:provider(f.website,{[reason]:1})});
 expect(await read(f.input)).toMatchObject({ok:true,value:{state:'complete',phoneEvidence:{state:'observed',value:'+12145550123'}}});
});
