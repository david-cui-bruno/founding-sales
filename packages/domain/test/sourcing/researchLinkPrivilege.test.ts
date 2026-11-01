import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {QualificationFact,QualifiedResearchSelection} from '@fss/contracts';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type QueryResultRowLike,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {createFirm} from '../../crm/firms.ts';
import {seedDiscoveryCandidate} from './support/discoverySeed.ts';
import {prepareDiscoveryCandidate,readDiscoveryPreparation} from '../../sourcing/discoveryPromotion.ts';
import {linkDiscoveryResearchFirm,readDiscoveryResearchFirm} from '../../sourcing/discoveryResearchFirm.ts';
import {createQualifiedResearchFirm,readQualifiedResearchFirm} from '../../sourcing/qualifiedResearch.ts';
import {requestQualification,finishQualification} from '../../sourcing/qualificationStore.ts';
import {evaluateQualification} from '../../sourcing/qualificationDecision.ts';
import {deleteCandidate} from '../../sourcing/candidates.ts';

// Real migrated PostgreSQL and real app_runtime sessions. Privileged fixture setup
// is separate from every target creation/link/deletion transaction. No providers.
let db:TestDatabase,seeded:TwoWorkspaces;
const context=(session:SessionQueryable,user=seeded.alpha.admin,workspace=seeded.alpha.workspaceId,role:'admin'|'salesperson'='admin')=>repositoryContext(workspaceScope(workspace,{kind:'user',userId:user.userId,role}),session);
beforeAll(async()=>{db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);});
afterAll(async()=>{if(db)await db.drop();});
async function runtime(){
 const session=await db.appRuntimeSession();
 expect((await session.query('SELECT current_user')).rows).toEqual([{current_user:'app_runtime'}]);
 await session.query("SET lock_timeout='5s'");await session.query("SET statement_timeout='10s'");
 return session;
}
async function fixture(qualified=false){
 const suffix=randomUUID(),name=`FICTIONAL research link privilege ${suffix}`,website=`https://research-link-${suffix}.example.test/`;
 const source={provider:'overture_places' as const,release:'fictional-research-link-privilege',recordId:suffix,retrievedAt:null,sourceUrl:'https://source.example.test/retained'};
 const ctx=context(db.session),tx=<T>(work:()=>Promise<T>)=>withTransaction(db.session,work);
 const raw=await tx(()=>seedDiscoveryCandidate(ctx,{row:{source,observations:[source],firmName:name,website,locality:'Dallas',region:'TX',sourceConfidence:null,residentialFit:'unknown',websiteAssociation:'unknown',officePhoneEvidence:'unknown',probableGroupKey:null},origins:[{source,sourceMetadata:{sourcesJson:'[]'},licenses:['fictional-fixture'],notices:[{label:'Fictional fixture',url:'https://source.example.test/license',sha256:'a'.repeat(64)}]}]}));
 const prepared=await tx(()=>prepareDiscoveryCandidate(ctx,{discoveryCandidateId:raw.id,expectedRevision:1,source:{provider:source.provider,release:source.release,recordId:source.recordId},candidate:{firmName:name,website,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Fictional human preparation, not native evidence.',sourceUrl:website,observedOn:new Date().toISOString().slice(0,10),preparedBy:'Fictional privilege regression'}}));
 assert(prepared.ok);
 const preparation=await readDiscoveryPreparation(ctx,prepared.value.promotionId);assert(preparation);
 let selection:QualifiedResearchSelection|null=null;
 if(qualified){
  await db.session.query('INSERT INTO research_settings(workspace_id,enabled) VALUES($1,true) ON CONFLICT(workspace_id) DO UPDATE SET enabled=true',[seeded.alpha.workspaceId]);
  const requested=await tx(()=>requestQualification(ctx,{candidateId:preparation.qualificationCandidateId,expectedRevision:1},{enqueue:false}));assert(requested.ok);
  const observationId=randomUUID(),text=`${name} provides residential property management in Dallas, TX.`,email=`${name} Dallas TX office info@${new URL(website).hostname}`;
  const facts:QualificationFact[]=(['firm_identity','service_area','residential_management'] as const).map(kind=>({kind,value:text,observationId,blockId:'native'}));
  facts.push({kind:'business_email',value:email,observationId,blockId:'email'});
  const finished=await tx(()=>finishQualification(ctx,{runId:requested.value.runId,reason:null,observations:[{id:observationId,url:website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:new Date().toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'native',text},{id:'email',text:email}]}],facts}));assert(finished.ok);
  const evaluated=await tx(()=>evaluateQualification(ctx,{runId:requested.value.runId}));assert(evaluated.ok);
  selection={discoveryCandidateId:raw.id,discoveryRevision:1,candidateId:preparation.qualificationCandidateId,candidateRevision:1,runId:requested.value.runId};
 }
 await db.session.query('INSERT INTO research_settings(workspace_id,enabled) VALUES($1,false) ON CONFLICT(workspace_id) DO UPDATE SET enabled=false',[seeded.alpha.workspaceId]);
 return {name,website,rawId:raw.id,legacyId:preparation.qualificationCandidateId,promotionId:prepared.value.promotionId,selection};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function ordinaryFirm(f:Fixture){
 const made=await withTransaction(db.session,()=>createFirm(context(db.session),{name:f.name,website:f.website,assignedUserId:seeded.alpha.admin.userId}));assert(made.ok);return made.value.id;
}
const input=(f:Fixture,firmId:string)=>({discoveryCandidateId:f.rawId,expectedRevision:1,qualificationCandidateId:f.legacyId,firmId});
const link=(session:SessionQueryable,f:Fixture,firmId:string)=>withTransaction(session,()=>linkDiscoveryResearchFirm(context(session),input(f,firmId)));
async function countLinks(f:Fixture){return (await db.session.query('SELECT count(*)::int AS n FROM sourcing_discovery_research_firms WHERE workspace_id=$1 AND promotion_id=$2',[seeded.alpha.workspaceId,f.promotionId])).rows[0];}
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
function paused(session:SessionQueryable,when:(sql:string)=>boolean,entered:ReturnType<typeof gate>,resume:ReturnType<typeof gate>,before=false):SessionQueryable {
 let once=false;
 return {query:async<Row extends QueryResultRowLike=QueryResultRowLike>(sql:string,values?:readonly unknown[])=>{
  const hit=!once&&when(sql);if(hit)once=true;
  if(hit&&before){entered.release();await resume.promise;}
  const result=await session.query<Row>(sql,values);
  if(hit&&!before){entered.release();await resume.promise;}
  return result;
 }};
}
async function reached(entered:ReturnType<typeof gate>,pending:Promise<unknown>){await Promise.race([entered.promise,pending.then(()=>{throw new Error('Command finished before the expected real SQL barrier');})]);}
async function pid(session:SessionQueryable){return Number((await session.query('SELECT pg_backend_pid() AS pid')).rows[0]?.['pid']);}
async function blockedBy(waiter:number,holder:number){await expect.poll(async()=>Boolean((await db.session.query<{blocked:boolean}>('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked',[waiter,holder])).rows[0]?.blocked),{timeout:3000}).toBe(true);}
async function eraseOrigin(session:SessionQueryable,f:Fixture){return withTransaction(session,()=>session.query('DELETE FROM sourcing_candidate_discovery_origins WHERE workspace_id=$1 AND candidate_id=$2',[seeded.alpha.workspaceId,f.rawId]));}

it('creates and concurrently reuses one qualified research Firm as app_runtime without UPDATE on append-only lineage',async()=>{
 const f=await fixture(true);assert(f.selection);
 const a=await runtime(),b=await runtime();
 expect((await a.query("SELECT has_table_privilege(current_user,'sourcing_discovery_promotions','UPDATE') AS promotion_update,has_table_privilege(current_user,'sourcing_candidate_discovery_origins','UPDATE') AS origin_update")).rows).toEqual([{promotion_update:false,origin_update:false}]);
 const create=(session:SessionQueryable)=>withTransaction(session,()=>createQualifiedResearchFirm(context(session),f.selection!));
 const results=await Promise.all([create(a),create(b)]);for(const result of results)expect(result).toMatchObject({ok:true});
 const first=results[0];assert(first?.ok);
 expect(results[1]).toEqual(first);expect(await countLinks(f)).toEqual({n:1});
 expect((await db.session.query('SELECT count(*)::int AS n FROM firms WHERE workspace_id=$1 AND website=$2',[seeded.alpha.workspaceId,f.website])).rows).toEqual([{n:1}]);
 expect(await readQualifiedResearchFirm(context(a),first.value.firmId)).toMatchObject({firmId:first.value.firmId,selection:f.selection,channelAuthority:'not_granted'});
 expect((await a.query("SELECT (SELECT count(*)::int FROM jobs WHERE workspace_id=$1 AND kind IN ('research.firm','sourcing.qualify')) AS acquisition_jobs,(SELECT count(*)::int FROM sourcing_admissions WHERE workspace_id=$1) AS admissions",[seeded.alpha.workspaceId])).rows).toEqual([{acquisition_jobs:0,admissions:0}]);
});

it('serializes duplicate app_runtime links and preserves promotion bytes without an UPDATE grant',async()=>{
 const f=await fixture(),firmId=await ordinaryFirm(f),a=await runtime(),b=await runtime();
 const before=(await a.query('SELECT * FROM sourcing_discovery_promotions WHERE workspace_id=$1 AND id=$2',[seeded.alpha.workspaceId,f.promotionId])).rows;
 const results=await Promise.all([link(a,f,firmId),link(b,f,firmId)]);
 expect(results).toEqual(expect.arrayContaining([{ok:true,value:{promotionId:f.promotionId,alreadyLinked:false}},{ok:true,value:{promotionId:f.promotionId,alreadyLinked:true}}]));
 expect(await countLinks(f)).toEqual({n:1});
 expect((await a.query('SELECT * FROM sourcing_discovery_promotions WHERE workspace_id=$1 AND id=$2',[seeded.alpha.workspaceId,f.promotionId])).rows).toEqual(before);
});

it('refuses a real origin deletion winning between fresh preparation read and INSERT while preserving transaction usability',async()=>{
 const f=await fixture(),firmId=await ordinaryFirm(f),a=await runtime(),b=await runtime(),entered=gate(),resume=gate();
 const watched=paused(a,sql=>sql.startsWith('INSERT INTO sourcing_discovery_research_firms'),entered,resume,true);
 const pending=link(watched,f,firmId);
 try {await reached(entered,pending);await eraseOrigin(b,f);} finally {resume.release();await Promise.allSettled([pending]);}
 expect(await pending).toEqual({ok:false,reason:'preparation_unavailable'});
 expect(await countLinks(f)).toEqual({n:0});expect(await readDiscoveryResearchFirm(context(a),f.promotionId)).toBeNull();
 expect((await a.query('SELECT current_user')).rows).toEqual([{current_user:'app_runtime'}]);
 // A second ordinary command on the same session must still commit after FK refusal.
 const next=await fixture(),nextFirm=await ordinaryFirm(next);expect(await link(a,next,nextFirm)).toMatchObject({ok:true});
});

it('makes source deletion wait for a committed link then cascades it without deleting the ordinary Firm',async()=>{
 const f=await fixture(),firmId=await ordinaryFirm(f),a=await runtime(),b=await runtime(),entered=gate(),resume=gate(),aPid=await pid(a),bPid=await pid(b);
 const watched=paused(a,sql=>sql.startsWith('INSERT INTO sourcing_discovery_research_firms'),entered,resume);
 const pending=link(watched,f,firmId);let deleting:Promise<unknown>|undefined;
 try {await reached(entered,pending);deleting=eraseOrigin(b,f);await blockedBy(bPid,aPid);} finally {resume.release();await Promise.allSettled([pending,...(deleting?[deleting]:[])]);}
 expect(await pending).toMatchObject({ok:true});await deleting;
 expect(await countLinks(f)).toEqual({n:0});expect(await readDiscoveryResearchFirm(context(a),f.promotionId)).toBeNull();
 expect((await a.query('SELECT id FROM firms WHERE workspace_id=$1 AND id=$2',[seeded.alpha.workspaceId,firmId])).rows).toEqual([{id:firmId}]);
});

it('preserves candidate-deletion serialization while link owns the existing candidate locks',async()=>{
 const f=await fixture(),firmId=await ordinaryFirm(f),a=await runtime(),b=await runtime(),entered=gate(),resume=gate(),aPid=await pid(a),bPid=await pid(b);
 const watched=paused(a,sql=>sql.startsWith('INSERT INTO sourcing_discovery_research_firms'),entered,resume);
 const pending=link(watched,f,firmId);let deleting:ReturnType<typeof deleteCandidate>|undefined;
 try {await reached(entered,pending);deleting=withTransaction(b,()=>deleteCandidate(context(b),{id:f.rawId,expectedRevision:1}));await blockedBy(bPid,aPid);} finally {resume.release();await Promise.allSettled([pending,...(deleting?[deleting]:[])]);}
 expect(await pending).toMatchObject({ok:true});expect(await deleting).toMatchObject({ok:true});expect(await countLinks(f)).toEqual({n:0});
});

it('refuses changed source, revision, owner and workspace rather than using historical promotion authority',async()=>{
 const f=await fixture(),firmId=await ordinaryFirm(f),a=await runtime();
 const attempt=(value=input(f,firmId))=>withTransaction(a,()=>linkDiscoveryResearchFirm(context(a),value));
 expect(await attempt({...input(f,firmId),expectedRevision:2})).toEqual({ok:false,reason:'candidate_changed'});
 expect(await withTransaction(a,()=>linkDiscoveryResearchFirm(context(a,seeded.beta.admin,seeded.beta.workspaceId),input(f,firmId)))).toEqual({ok:false,reason:'not_found'});
 expect(await withTransaction(a,()=>linkDiscoveryResearchFirm(context(a,seeded.alpha.salesperson,seeded.alpha.workspaceId,'salesperson'),input(f,firmId)))).toEqual({ok:false,reason:'admin_only'});
 await db.session.query('UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2',[seeded.alpha.workspaceId,firmId,seeded.alpha.salesperson.userId]);
 expect(await attempt()).toEqual({ok:false,reason:'firm_assigned_elsewhere'});
 await db.session.query('UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2',[seeded.alpha.workspaceId,firmId,seeded.alpha.admin.userId]);
 await eraseOrigin(a,f);expect(await attempt()).toEqual({ok:false,reason:'preparation_unavailable'});expect(await countLinks(f)).toEqual({n:0});
});
