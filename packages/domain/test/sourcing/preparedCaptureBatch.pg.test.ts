import {createHash,randomUUID} from 'node:crypto';
import {candidateInputSchema} from '@fss/contracts';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import type {ManualPhoneSnapshot} from '../../sourcing/manualProspectPhone.ts';
import {withPreparedCaptureSnapshots} from '../../sourcing/preparedCaptureStore.ts';
import {preparedCaptureAuthority,preparedCaptureManifest,type PreparedCapturePolicy} from '../../sourcing/preparedCapture.ts';
import {phoneDiscoverySourceLimit} from '../../sourcing/prospectPhoneDiscoveryAuthority.ts';
import {lockDiscoveryReviewSources} from '../../sourcing/discoveryReviewVisibility.ts';
import {MANUAL_PROSPECT_ROWS_SQL,PREPARED_PROSPECT_ROWS_SQL} from '../../sourcing/manualProspectRows.ts';
import {MANUAL_SOURCE_LOSS_ACTION,rememberExpiredManualSources} from '../../sourcing/manualProspectSourceLoss.ts';
import {listPreparedProspects} from '../../sourcing/preparedProspects.ts';
import {seedPreparedProspect,preparedProspectsBusinessSnapshot} from './preparedProspectsPgFixture.ts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const ctx=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),runtime);
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
afterAll(async()=>db?.drop());
type Fence='clear'|'future'|'expired'|'audit'|'candidate'|'pending';
/** Retained synthetic migration/guard states, not a source acquisition or yield fixture. */
async function input(policy:'legacy'|PreparedCapturePolicy,fence:Fence='clear'):Promise<ManualPhoneSnapshot>{
 const website=`https://batch-${randomUUID()}.example.test/`,sourceUrl=website+'source',middle=website+'redirect',url=policy==='prepared-source-association-v1'?sourceUrl+'/':website.replace('https://','https://www.')+'management';
 const payload={firmName:'Fictional batch authority',website,sourceUrl,locality:'Boston',region:'MA' as const,signal:'fit_only' as const,evidence:'Controlled retained metadata',observedOn:new Date().toISOString().slice(0,10),preparedBy:'Controlled batch source fence'};
 const saved=await saveCandidate(ctx(),payload);if(!saved.ok)throw Error(saved.reason);const candidate=saved.value.id,run=randomUUID(),id=randomUUID(),at=new Date(Date.now()-1000).toISOString(),blocks=[{id:'business',text:'Our property managers coordinate tenant maintenance requests for residential homes.'}],hash=createHash('sha256').update(JSON.stringify(blocks)).digest('hex');
 const source={id,url,contentHash:hash,relevantTextHash:hash,retrievedAt:at,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks};
 await runtime.query(`INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,capture_policy_version) VALUES($1,$2,$3,1,$4,'qualification-context-v7','qualification-v5','none',$5)`,[seed.alpha.workspaceId,run,candidate,createHash('sha256').update(run).digest('hex'),policy]);
 if(fence==='future'||fence==='expired'){
  const firm=(await runtime.query<{id:string}>("INSERT INTO firms(workspace_id,name) VALUES($1,'Fictional evidence fence') RETURNING id",[seed.alpha.workspaceId])).rows[0]!.id;
  await runtime.query(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at) VALUES($1,$2,'fixture',$3,$4,true,$5)`,[seed.alpha.workspaceId,firm,middle,hash,new Date(Date.now()+(fence==='future'?60_000:-1000))]);
 }
 if(fence==='audit')await runtime.query(`INSERT INTO audit_events(workspace_id,actor_kind,action,subject_kind,subject_id,detail) VALUES($1,'system','sourcing.manual_source_retention_expired','sourcing_source_hash',encode(sha256(convert_to(rtrim($2::text,'/'),'UTF8')),'hex'),'{}')`,[seed.alpha.workspaceId,middle]);
 if(fence==='candidate'){
  const lost=await saveCandidate(ctx(),{...payload,firmName:'Fictional unavailable same-source record',sourceUrl:middle});if(!lost.ok)throw Error(lost.reason);
  await runtime.query(`UPDATE sourcing_candidates SET source_check=$2::jsonb WHERE id=$1`,[lost.value.id,JSON.stringify({checkId:randomUUID(),jobId:randomUUID(),requestedAt:at,state:'unavailable',reason:'source_not_permitted',checkedAt:at,lastSuccess:null})]);
 }
 const manifest=policy==='legacy'?null:{version:policy,candidateId:candidate,candidateRevision:1,sourceUrl,pages:[{observationId:id,url,contentHash:hash,relevantTextHash:hash,retrievedAt:at,redirectUrls:policy==='prepared-source-association-v1'?[sourceUrl,url]:[sourceUrl,middle,url]}]};
 if(fence!=='pending')await runtime.query("UPDATE sourcing_qualification_runs SET state='unavailable',reason='invalid_evidence',observations=$2::jsonb,prepared_capture=$3::jsonb,finished_at=clock_timestamp() WHERE id=$1",[run,JSON.stringify([source]),manifest===null?null:JSON.stringify(manifest)]);
 return {id:run,candidate_id:candidate,candidate_revision:1,payload,origins:[],observations:fence==='pending'?[]:[source],facts:[],permitted_urls:policy==='prepared-source-association-v1'?[url]:[]};
}
it('matches each unchanged shared source-limit result in a mixed batch without borrowing another run or workspace evidence',async()=>{
 const rows:ManualPhoneSnapshot[]=[];
 for(const policy of ['legacy','prepared-source-association-v1'] as const)rows.push(await input(policy));
 for(const fence of ['clear','future','expired','audit','candidate','pending'] as const)rows.push(await input('prepared-source-association-v2',fence));
 const otherFirm=(await runtime.query<{id:string}>("INSERT INTO firms(workspace_id,name) VALUES($1,'Other workspace retained fence') RETURNING id",[seed.beta.workspaceId])).rows[0]!.id;
 await runtime.query("INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at) VALUES($1,$2,'fixture',$3,$4,false,clock_timestamp()-interval '1 second')",[seed.beta.workspaceId,otherFirm,candidateInputSchema.parse(rows[2]!.payload).website+'redirect','c'.repeat(64)]);
 const originalPermissions=rows.map(row=>[...row.permitted_urls]);
 const current=await withTransaction(runtime,async()=>{
  await lockDiscoveryReviewSources(ctx());const batched=await withPreparedCaptureSnapshots(ctx(),rows);
  for(const row of batched){
   const manifest=preparedCaptureManifest(row);if(manifest?.version!=='prepared-source-association-v2'){expect(row['prepared_capture_authority']).toBeUndefined();continue;}
   const urls=[...new Set(manifest.pages.flatMap(page=>page.redirectUrls))].sort(),limit=await phoneDiscoverySourceLimit(ctx(),urls),groups=urls.map(url=>url.replace(/\/+$/u,''));
   const evidence=(await runtime.query("SELECT id,source_reference,content_hash,retrieved_at,terms_allow_retention,retention_expires_at FROM evidence_items WHERE workspace_id=$1 AND rtrim(source_reference,'/')=ANY($2::text[]) ORDER BY id",[seed.alpha.workspaceId,groups])).rows;
   expect(row['prepared_capture_authority']).toEqual({dependencyUrls:urls,denied:limit.denied,validUntil:limit.expiresAt?.toISOString()??null,evidence});
  }
  return batched;
 });
 expect(current.map(row=>row.permitted_urls)).toEqual(originalPermissions);
 expect(current.map(row=>preparedCaptureAuthority(row).observationIds.size)).toEqual([0,1,1,1,0,0,0,0]);
 expect(current[2]!['prepared_capture_authority']).toMatchObject({evidence:[],validUntil:null,denied:false});
 expect(current[3]!['prepared_capture_authority']).toMatchObject({denied:false});expect(current[4]!['prepared_capture_authority']).toMatchObject({denied:true});
 const noCustody=await withPreparedCaptureSnapshots(ctx(),[rows[2]!]);expect(preparedCaptureAuthority(noCustody[0]!).observationIds.size).toBe(0);
 const stale=await withTransaction(runtime,async()=>{await lockDiscoveryReviewSources(ctx());return withPreparedCaptureSnapshots(ctx(),[{...rows[2]!,candidate_revision:2}]);});expect(preparedCaptureAuthority(stale[0]!).observationIds.size).toBe(0);
 await runtime.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);
 try{
  await runtime.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);
  const inactive=await withTransaction(runtime,async()=>{await lockDiscoveryReviewSources(ctx());return withPreparedCaptureSnapshots(ctx(),[rows[2]!]);});expect(preparedCaptureAuthority(inactive[0]!).observationIds.size).toBe(0);
 }finally{
  await runtime.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);
  await runtime.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);
 }
});
it.each(['source','lastSuccess','origin'] as const)('keeps prepared permission/dedup rows equal when another record loses their shared %s reference',async reference=>{
 const target=await input('prepared-source-association-v2'),payload=candidateInputSchema.parse(target.payload);
 const compare=async()=>{
  const shared=(await runtime.query(MANUAL_PROSPECT_ROWS_SQL,[seed.alpha.workspaceId,'all'])).rows;
  const prepared=(await runtime.query(PREPARED_PROSPECT_ROWS_SQL,[seed.alpha.workspaceId,'all'])).rows;
  expect(prepared).toEqual(shared);return prepared;
 };
 expect((await compare()).some(row=>row['id']===target.candidate_id)).toBe(true);
 await withTransaction(runtime,async()=>{
  await lockDiscoveryReviewSources(ctx());
  const sibling=await saveCandidate(ctx(),{...payload,firmName:'Independent shared-source loss',sourceUrl:reference==='source'?payload.sourceUrl:payload.website+'unrelated-source'});if(!sibling.ok)throw Error(sibling.reason);
  const at=new Date().toISOString();
  if(reference==='origin'){
   const recordId=randomUUID(),source={provider:'first_party',release:'controlled-source-loss',recordId,retrievedAt:at,sourceUrl:payload.sourceUrl};
   await runtime.query(`INSERT INTO sourcing_candidate_discovery_origins(workspace_id,candidate_id,provider,release,record_id,source,source_metadata,licenses,notices) VALUES($1,$2,'first_party','controlled-source-loss',$3,$4::jsonb,'{"sourcesJson":"[]"}','["Controlled fixture"]','[{"label":"Controlled source notice","url":null}]')`,[seed.alpha.workspaceId,sibling.value.id,recordId,JSON.stringify(source)]);
  }
  const reason={source:'source_unavailable',lastSuccess:'no_readable_text',origin:'source_not_permitted'}[reference];
  const lastSuccess=reference==='lastSuccess'?{url:payload.sourceUrl,contentHash:'a'.repeat(64),retrievedAt:at,firstParty:true,excerpt:'Controlled source context',quoteMatched:false,truncated:false}:null;
  await runtime.query("UPDATE sourcing_candidates SET source_check=$2::jsonb,status=$3 WHERE id=$1",[sibling.value.id,JSON.stringify({checkId:randomUUID(),jobId:randomUUID(),requestedAt:at,state:'unavailable',reason,checkedAt:at,lastSuccess}),reference==='origin'?'dismissed':'needs_review']);
  expect((await compare()).some(row=>row['id']===target.candidate_id)).toBe(false);
 });
});

it('keeps audit-loss scope identical and invalidates global prepared continuation after actual same-workspace source loss',async()=>{
 const targets:Awaited<ReturnType<typeof seedPreparedProspect>>[]=[];
 for(let i=0;i<51;i++)targets.push(await seedPreparedProspect(ctx(),1000+i));
 const list=(offset=0,viewRevision?:string)=>withTransaction(runtime,()=>listPreparedProspects(ctx(),{offset,...(viewRevision?{viewRevision}:{})}));
 const first=await list();if(!first.ok)throw Error(first.reason);expect(first.value.hasMore).toBe(true);
 const second=await list(50,first.value.viewRevision);if(!second.ok)throw Error(second.reason);
 const offPage=second.value.prospects.find(p=>targets.some(t=>t.candidateId===p.target.candidateId));expect(offPage).toBeDefined();if(!offPage)throw Error('Expected off-page fixture');
 const target=targets.find(t=>t.candidateId===offPage.target.candidateId)!;
 // Same hash with wrong action/kind/workspace, and an unrelated correct loss
 // hash, cannot veto this source or change its current prepared continuation.
 for(const [workspace,action,kind,url] of [[seed.alpha.workspaceId,'fixture.unrelated','sourcing_source_hash',target.website],[seed.alpha.workspaceId,MANUAL_SOURCE_LOSS_ACTION,'fixture',target.website],[seed.beta.workspaceId,MANUAL_SOURCE_LOSS_ACTION,'sourcing_source_hash',target.website],[seed.alpha.workspaceId,MANUAL_SOURCE_LOSS_ACTION,'sourcing_source_hash',target.website+'unrelated']] as const)
  await runtime.query(`INSERT INTO audit_events(workspace_id,actor_kind,action,subject_kind,subject_id,detail) VALUES($1,'system',$2,$3,encode(sha256(convert_to(rtrim($4::text,'/'),'UTF8')),'hex'),'{}')`,[workspace,action,kind,url]);
 const compare=async()=>{
  const shared=(await runtime.query(MANUAL_PROSPECT_ROWS_SQL,[seed.alpha.workspaceId,'all'])).rows;
  const prepared=(await runtime.query(PREPARED_PROSPECT_ROWS_SQL,[seed.alpha.workspaceId,'all'])).rows;
  expect(prepared).toEqual(shared);return prepared;
 };
 expect((await compare()).some(row=>row['id']===target.candidateId)).toBe(true);
 const before=await preparedProspectsBusinessSnapshot(ctx()),continued=await list(50,first.value.viewRevision);
 expect(continued).toMatchObject({ok:true});if(!continued.ok)throw Error(continued.reason);
 expect(continued.value.prospects).toEqual(second.value.prospects);expect(await preparedProspectsBusinessSnapshot(ctx())).toEqual(before);
 await withTransaction(runtime,()=>rememberExpiredManualSources(ctx(),[target.website+'///']));
 expect((await compare()).some(row=>row['id']===target.candidateId)).toBe(false);
 expect(await list(50,first.value.viewRevision)).toEqual({ok:false,reason:'view_changed'});
 const refreshed=await list();if(!refreshed.ok)throw Error(refreshed.reason);expect(refreshed.value.viewRevision).not.toBe(first.value.viewRevision);
});
