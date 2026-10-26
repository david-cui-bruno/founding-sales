import {createHash} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestProspectPhoneDiscovery,readProspectPhoneDiscovery,runProspectPhoneDiscovery} from '../../sourcing/prospectPhoneDiscovery.ts';
import {manualOrdinaryFixture} from './support/manualProspectFixture.ts';
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
it.each(['page_budget_reached','robots_disallowed','url_not_permitted','address_not_public','url_has_query','status_404'] as const)('SPEC S2 intentional bound or unrelated policy skip %s does not reject current bounded originals',async reason=>{
 const f=await fixture(),result=await request(f.input);if(!result.ok)throw Error(result.reason);
 await runProspectPhoneDiscovery(worker(),{runId:result.value.runId},{pageFetch:provider(f.website,{[reason]:1})});
 expect(await read(f.input)).toMatchObject({ok:true,value:{state:'complete',phoneEvidence:{state:'observed',value:'+12145550123'}}});
});
