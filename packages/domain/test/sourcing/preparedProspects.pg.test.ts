import {createHash} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {preparedProspectBriefSchema,preparedProspectListSchema} from '@fss/contracts';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {listPreparedProspects,readPreparedProspect} from '../../sourcing/preparedProspects.ts';
import {saveProspectPriority} from '../../sourcing/prospectPriority.ts';
import {seedPreparedProspect,preparedProspectsBusinessSnapshot} from './preparedProspectsPgFixture.ts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const ctx=(workspace:'alpha'|'beta'='alpha',role:'admin'|'salesperson'='admin')=>repositoryContext(workspaceScope(seed[workspace].workspaceId,{kind:'user',userId:seed[workspace][role].userId,role}),runtime);
const list=(offset=0,viewRevision?:string)=>withTransaction(runtime,()=>listPreparedProspects(ctx(),{offset,...(viewRevision?{viewRevision}:{})}));
const target=(value:{candidateId:string;candidateRevision:number;runId:string|null})=>({candidateId:value.candidateId,candidateRevision:value.candidateRevision,runId:value.runId});
const read=(value:Parameters<typeof target>[0])=>withTransaction(runtime,()=>readPreparedProspect(ctx(),target(value)));
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM evidence_items');await db.session.query('DELETE FROM firms');});
afterAll(async()=>db?.drop());

it('prepares a source-backed company brief from an identity-refused SEO label without contact, strict review or writes',async()=>{
 const f=await seedPreparedProspect(ctx());
 expect(await withTransaction(runtime,()=>saveProspectPriority(ctx(),{candidateId:f.candidateId,expectedCandidateRevision:1,expectedAssessmentRevision:0,fit:'positive',value:'unknown',timing:'unknown',roles:[],sourceUrl:f.website}))).toMatchObject({ok:true});
 const before=await preparedProspectsBusinessSnapshot(ctx());
 expect((await runtime.query('SELECT current_user')).rows).toEqual([{current_user:'app_runtime'}]);
 const page=await list();expect(page.ok).toBe(true);if(!page.ok)throw Error(page.reason);
 expect(preparedProspectListSchema.parse(page.value).prospects).toEqual([expect.objectContaining({target:target(f),discoveryLabel:f.label,state:'prepared'})]);
 const result=await read(f);expect(result.ok).toBe(true);if(!result.ok)throw Error(result.reason);
 const brief=preparedProspectBriefSchema.parse(result.value);
 expect(brief).toMatchObject({target:target(f),discoveryLabel:f.label,state:'prepared',coverage:'complete_retained_pages',contactAuthority:'not_granted'});
 expect(brief.passages).toContainEqual(expect.objectContaining({observationId:f.observations[0]!.id,blockId:'residential',url:f.website,retrievedAt:f.observations[0]!.retrievedAt,quote:`${f.name} manages residential homes in Boston, Massachusetts.`}));
 expect(brief.unknowns.join(' ')).toMatch(/contact|phone|email/iu);
 expect(brief.unknowns.join(' ')).toMatch(/need|pain|value|timing/iu);
 expect(brief.passages.map(p=>p.quote).join(' ')).toContain('independently operated franchise');
 for(const passage of brief.passages){const original=f.observations.find(source=>source.id===passage.observationId);expect(original?.blocks.find(block=>block.id===passage.blockId)?.text).toBe(passage.quote);}
 expect(brief.passages.filter(p=>p.kind==='contact'||p.kind==='person')).toEqual([]);
 expect(await preparedProspectsBusinessSnapshot(ctx())).toEqual(before);
});

it('shows missing and third-party pages as research gaps without inventing source-supported detail',async()=>{
 for(const [index,options] of [[1,{pages:false}],[3,{firstParty:false}]] as const){
  const f=await seedPreparedProspect(ctx(),index,options),answer=await read(f);expect(answer.ok).toBe(true);if(!answer.ok)throw Error(answer.reason);
  expect(answer.value).toMatchObject({state:'needs_research',coverage:'no_usable_retained_pages',passages:[],contactAuthority:'not_granted'});
 }
});

it('shows dated people and published contact context without converting them to a buyer or usable route',async()=>{
 const f=await seedPreparedProspect(ctx(),1,{extraBlocks:[{id:'person',text:'Our founder Mira Cedar leads the local residential property team.'},
  {id:'contact',text:'Resident emergency response line: (617) 555-0123. General office: hello@cedar.example.test.'}]});
 const before=await preparedProspectsBusinessSnapshot(ctx()),answer=await read(f);if(!answer.ok)throw Error(answer.reason);
 expect(answer.value.passages).toEqual(expect.arrayContaining([
  expect.objectContaining({kind:'person',blockId:'person',quote:'Our founder Mira Cedar leads the local residential property team.'}),
  expect.objectContaining({kind:'contact',blockId:'contact',quote:'Resident emergency response line: (617) 555-0123. General office: hello@cedar.example.test.'})]));
 expect(answer.value.contactAuthority).toBe('not_granted');expect(answer.value.unknowns.join(' ')).toMatch(/purpose|ownership|buying authority/iu);
 expect(await preparedProspectsBusinessSnapshot(ctx())).toEqual(before);
});

it.each([
 'Our software helps property managers manage residential homes and tenant requests more efficiently.',
 'Property management is the operation and oversight of residential homes by professional property managers.',
])('does not treat vendor or educational context as the observed company managing homes: %s',async businessText=>{
 const f=await seedPreparedProspect(ctx(),1,{businessText,omitBrand:true});
 // This negative has no independent positive operations passage from the shared fixture.
 const observations=f.observations.map(source=>{const blocks=source.blocks.filter(block=>block.id!=='workflow');const hash=createHash('sha256').update(JSON.stringify(blocks)).digest('hex');return {...source,blocks,contentHash:hash,relevantTextHash:hash};});
 await runtime.query('UPDATE sourcing_qualification_runs SET observations=$2::jsonb WHERE id=$1',[f.runId,JSON.stringify(observations)]);
 expect(await read(f)).toMatchObject({ok:true,value:{state:'needs_research',contactAuthority:'not_granted'}});
});

it('prepares an own-management paragraph without a standalone literal name, contact or rigid geography sentence',async()=>{
 const businessText='Our property management office manages residential homes for owners, coordinating tenant requests and maintenance.';
 const f=await seedPreparedProspect(ctx(),1,{businessText,omitBrand:true}),answer=await read(f);if(!answer.ok)throw Error(answer.reason);
 expect(answer.value).toMatchObject({state:'prepared',discoveryLabel:f.label,contactAuthority:'not_granted'});
 expect(answer.value.passages).toContainEqual(expect.objectContaining({kind:'business',blockId:'residential',quote:businessText}));
});

it('preserves dated retained evidence beyond the contact horizon while refusing future captures',async()=>{
 const old=await seedPreparedProspect(ctx(),1,{sourceAgeMs:30*86400000}),future=await seedPreparedProspect(ctx(),2,{sourceAgeMs:-86400000});
 expect(await read(old)).toMatchObject({ok:true,value:{state:'prepared',validUntil:null}});
 expect(await read(future)).toMatchObject({ok:true,value:{state:'needs_research',passages:[]}});
});

it('erased originals never fall back to a strict verdict or stale copied source passages',async()=>{
 const f=await seedPreparedProspect(ctx());expect(await read(f)).toMatchObject({ok:true,value:{state:'prepared'}});
 await runtime.query("UPDATE sourcing_qualification_runs SET observations='[]',facts='[]' WHERE id=$1",[f.runId]);
 expect(await read(f)).toMatchObject({ok:true,value:{state:'needs_research',passages:[],coverage:'no_usable_retained_pages'}});
});

it('rejects stale revision and latest-run targets and isolates foreign and nonadministrator principals',async()=>{
 const f=await seedPreparedProspect(ctx());
 expect(await withTransaction(runtime,()=>readPreparedProspect(ctx('beta'),target(f)))).toMatchObject({ok:false,reason:'candidate_unavailable'});
 expect(await withTransaction(runtime,()=>listPreparedProspects(ctx('alpha','salesperson'),{offset:0}))).toMatchObject({ok:false,reason:'authority_changed'});
 expect(await withTransaction(runtime,()=>readPreparedProspect(ctx(),target(f),async()=>false))).toMatchObject({ok:false,reason:'authority_changed'});
 await runtime.query('UPDATE sourcing_candidates SET revision=2 WHERE id=$1',[f.candidateId]);
 expect(await read(f)).toMatchObject({ok:false});
 const current=await read({...f,candidateRevision:2});if(current.ok)expect(current.value).toMatchObject({state:'needs_research',passages:[]});
});

it('known same-source loss elsewhere vetoes both navigation and exact reads',async()=>{
 const f=await seedPreparedProspect(ctx()),lost=await seedPreparedProspect(ctx(),2,{pages:false});
 await runtime.query(`UPDATE sourcing_candidates SET payload=jsonb_set(payload,'{sourceUrl}',to_jsonb($2::text)),source_check='{"state":"unavailable","reason":"source_not_permitted"}' WHERE id=$1`,[lost.candidateId,f.website]);
 expect(await list()).toMatchObject({ok:true,value:{prospects:[]}});
 expect(await read(f)).toMatchObject({ok:false,reason:'candidate_unavailable'});
});

it('bounds continuation to fifty companies and requires a fresh view after source changes',async()=>{
 for(let i=0;i<51;i++)await seedPreparedProspect(ctx(),i,{pages:false});
 const a=await list();if(!a.ok)throw Error(a.reason);expect(a.value.prospects).toHaveLength(50);expect(a.value.hasMore).toBe(true);
 const b=await list(50,a.value.viewRevision);if(!b.ok)throw Error(b.reason);expect(b.value.prospects).toHaveLength(1);expect(b.value.hasMore).toBe(false);
 expect(b.value.prospects.some(row=>a.value.prospects.some(old=>old.target.candidateId===row.target.candidateId))).toBe(false);
 expect(await list(50)).toMatchObject({ok:false});
 await runtime.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE id=$1',[a.value.prospects[0]!.target.candidateId]);
 expect(await list(50,a.value.viewRevision)).toMatchObject({ok:false,reason:'view_changed'});
});

it('navigation dedup does not transfer permission between equal names and websites',async()=>{
 const a=await seedPreparedProspect(ctx(),1),b=await seedPreparedProspect(ctx(),2);
 // Distinct retained candidate keys are historical evidence, not permission to merge.
 await runtime.query('UPDATE sourcing_candidates SET payload=jsonb_set(jsonb_set(payload,\'{firmName}\',to_jsonb($2::text)),\'{website}\',to_jsonb($3::text)) WHERE id=$1',[b.candidateId,a.label,a.website]);
 const page=await list();if(!page.ok)throw Error(page.reason);expect(page.value.prospects).toHaveLength(1);
 expect(await read(a)).toMatchObject({ok:true,value:{target:target(a),state:'prepared'}});
 const other=await read(b);expect(other.ok).toBe(true);if(!other.ok)throw Error(other.reason);
 expect(other.value.passages.every(p=>p.observationId!==a.observations[0]!.id)).toBe(true);
});

it('rejects an old run target when a newer qualification exists without replaying either attempt',async()=>{
 const f=await seedPreparedProspect(ctx());
 const next=(await runtime.query<{id:string}>(`INSERT INTO sourcing_qualification_runs(workspace_id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,requested_at,deadline_at)
 VALUES($1,$2,1,repeat('f',64),'qualification-context-v7','qualification-v5','none',clock_timestamp()+interval '1 second',clock_timestamp()+interval '31 minutes') RETURNING id`,[seed.alpha.workspaceId,f.candidateId])).rows[0]!.id;
 const before=await preparedProspectsBusinessSnapshot(ctx());
 expect(await read(f)).toMatchObject({ok:false,reason:'candidate_changed'});
 expect(await read({...f,runId:next})).toMatchObject({ok:true,value:{state:'needs_research',passages:[]}});
 expect(await preparedProspectsBusinessSnapshot(ctx())).toEqual(before);
});

it.each([true,false])('freshly rechecks explicit evidence expiry after an authority wait with retained pages=%s',async pages=>{
 const f=await seedPreparedProspect(ctx(),1,{pages}),page=f.observations[0];
 const firm=(await runtime.query<{id:string}>('INSERT INTO firms(workspace_id,name) VALUES($1,$2) RETURNING id',[seed.alpha.workspaceId,'Fictional evidence custodian'])).rows[0]!.id;
 const expiry=Date.now()+1500;
 await runtime.query(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,retrieved_at,terms_allow_retention,retention_expires_at,content_hash)
 VALUES($1,$2,'fixture',$3,$4,false,$5,$6)`,[seed.alpha.workspaceId,firm,f.website,page?.retrievedAt??new Date().toISOString(),new Date(expiry),page?.contentHash??'a'.repeat(64)]);
 const initial=await read(f);expect(initial).toMatchObject({ok:true,value:{state:pages?'prepared':'needs_research',validUntil:new Date(expiry).toISOString()}});
 let waits=0;
 const answer=await withTransaction(runtime,()=>readPreparedProspect(ctx(),target(f),async()=>{waits++;if(waits===2)await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiry-Date.now()+40)));return true;}));
 expect(waits).toBeGreaterThanOrEqual(2);expect(answer).toMatchObject({ok:false,reason:'source_expired'});expect(JSON.stringify(answer)).not.toContain(f.label);
});

it('withholds detail when actual administrator membership is revoked during the final authority wait',async()=>{
 const f=await seedPreparedProspect(ctx());
 await db.session.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);
 let calls=0;
 try{
  const answer=await withTransaction(runtime,()=>readPreparedProspect(ctx(),target(f),async()=>{
   if(++calls===2)await runtime.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);return true;
  }));
  expect(calls).toBe(2);expect(answer).toMatchObject({ok:false,reason:'authority_changed'});expect(JSON.stringify(answer)).not.toContain(f.observations[0]!.blocks[1]!.text);
 }finally{
  await db.session.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);
  await db.session.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);
 }
});

it.each(['observation','block'] as const)('rejects duplicate %s IDs rather than borrowing source or passage authority',async kind=>{
 const f=await seedPreparedProspect(ctx()),home=f.observations[0]!;
 const blocks=[{id:'private',text:'Our property management office manages residential homes with confidential private-page-only instructions.'}];
 const privatePage={...home,url:`${f.website}private-detail`,blocks,relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex')};
 const duplicateBlocks=[...home.blocks,{...blocks[0]!,id:'residential'}];
 const observations=kind==='observation'?[home,privatePage]:[{...home,blocks:duplicateBlocks,relevantTextHash:createHash('sha256').update(JSON.stringify(duplicateBlocks)).digest('hex')}];
 await runtime.query('UPDATE sourcing_qualification_runs SET observations=$2::jsonb WHERE id=$1',[f.runId,JSON.stringify(observations)]);
 const before=await preparedProspectsBusinessSnapshot(ctx()),answer=await read(f);if(!answer.ok)throw Error(answer.reason);
 expect(answer.value).toMatchObject({state:'needs_research',passages:[],coverage:'no_usable_retained_pages'});
 expect(JSON.stringify(answer.value)).not.toContain('private-page-only');expect(await preparedProspectsBusinessSnapshot(ctx())).toEqual(before);
});

it('an overlong retained denial prevents a prepared brief even alongside a short positive business paragraph',async()=>{
 const denial='we do not manage residential homes. '+('Additional retained business context. '.repeat(65));
 expect(denial.length).toBeGreaterThan(2000);expect(denial.length).toBeLessThanOrEqual(4000);
 const f=await seedPreparedProspect(ctx(),1,{extraBlocks:[{id:'long-denial',text:denial}]}),answer=await read(f);if(!answer.ok)throw Error(answer.reason);
 expect(answer.value).toMatchObject({state:'needs_research',contactAuthority:'not_granted'});
 expect(answer.value.unknowns.join(' ')).toMatch(/contrary|conflict/iu);
 expect(answer.value.passages.every(p=>p.quote.length<=2000)).toBe(true);
 expect(answer.value.passages.some(p=>p.blockId==='long-denial')).toBe(false);
 expect(answer.value.passages).toContainEqual(expect.objectContaining({blockId:'residential',quote:`${f.name} manages residential homes in Boston, Massachusetts.`}));
});
