import {createHash,randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../../db/workspaceScope.ts';
import {saveCandidate} from '../../../sourcing/candidates.ts';
import {recordManualProspectFeedback} from '../../../sourcing/manualProspects.ts';
import {confirmCallingPreparation} from '../../../calling/preparation.ts';
import {lockPreparationCleanup} from '../../../calling/preparationLifecycle.ts';
import {seedPolicy} from './policyFixtures.ts';
import {publishTestRegistrySnapshot} from '../../support/nationalRegistry.ts';
import {manualOrdinaryFixture} from '../../sourcing/support/manualProspectFixture.ts';
import type {TwoWorkspaces} from './fixtures.ts';
import type {SeededCrm} from './crmFixtures.ts';
type Fixture={session:SessionQueryable;seeded:TwoWorkspaces;crm:SeededCrm;holdId:string};
type Row=Record<string,unknown>;
type Case={constraint:string;error?:{code:string;message:string};run:(f:Fixture)=>Promise<unknown>};
const missing='00000000-0000-4000-8000-000000000144';
const insert=(f:Fixture,table:string,row:Row)=>f.session.query(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
const runtime=(f:Fixture)=>f.session.query('SET LOCAL ROLE app_runtime');
const context=(f:Fixture)=>repositoryContext(workspaceScope(f.seeded.alpha.workspaceId,{kind:'user',userId:f.seeded.alpha.admin.userId,role:'admin'}),f.session);
async function route(f:Fixture){return (await f.session.query<{id:string}>('SELECT id FROM phone_routes WHERE workspace_id=$1 AND firm_id=$2',[f.seeded.alpha.workspaceId,f.crm.alpha.firmId])).rows[0]!.id;}
async function row(f:Fixture):Promise<Row>{const run=randomUUID(),now=new Date();return {workspace_id:f.seeded.alpha.workspaceId,id:randomUUID(),candidate_ref:randomUUID(),candidate_revision:1,discovery_run_ref:run,source_creator_ref:f.seeded.alpha.admin.userId,prepared_by_ref:f.seeded.alpha.admin.userId,firm_ref:f.crm.alpha.firmId,route_ref:await route(f),firm_id:f.crm.alpha.firmId,phone_route_id:await route(f),choice:JSON.stringify({runId:run}),source_url_hashes:['a'.repeat(64)],profile_hash:'a'.repeat(64),created_at:now,updated_at:now,source_expires_at:new Date(now.getTime()+3600000)};}
/** Only the privileged, rolled-back catalog harness isolates NEW BEFORE guards
 * where they otherwise preempt a declarative CHECK/FK. The named target and all
 * deferred triggers remain enabled; every failing DML executes as app_runtime.
 * Registered guard behavior remains covered by the real preparation workflow tests. */
async function isolate(f:Fixture,table:string,guard:string){await f.session.query(`ALTER TABLE ${table} DISABLE TRIGGER ${guard}`);}
const bad=(constraint:string,patch:Row|(()=>Row),isolateCheck?:string):Case=>({constraint,run:async f=>{const value={...await row(f),...typeof patch==='function'?patch():patch};await isolate(f,'calling_preparations','calling_preparation_identity_guard');if(isolateCheck)await f.session.query(`ALTER TABLE calling_preparations DROP CONSTRAINT ${isolateCheck}`);await runtime(f);return insert(f,'calling_preparations',value);}});
const duplicate=(constraint:string,change:(r:Row)=>Row):Case=>({constraint,run:async f=>{const value=await row(f);await runtime(f);await insert(f,'calling_preparations',value);return insert(f,'calling_preparations',{...value,...change(value)});}});
async function ticket(f:Fixture,firmId=f.crm.alpha.firmId,routeId?:string):Promise<Row>{
 const policy=await seedPolicy(f.session,f.seeded,f.crm,{registry:false});return {workspace_id:f.seeded.alpha.workspaceId,id:randomUUID(),command_id:randomUUID(),firm_id:firmId,phone_route_id:routeId??await route(f),route_version:1,posture_id:policy.alpha.postureId,posture_revision:1,calling_identity_id:policy.alpha.otherCallingIdentityId,actor_user_id:f.seeded.alpha.admin.userId,device_id:f.seeded.alpha.admin.deviceId,assigned_user_id:f.seeded.alpha.admin.userId,e164:'+14015550123',firm_time_zone:'America/New_York',expires_at:new Date(Date.now()+30000)};
}
async function handoff(f:Fixture,firmId=f.crm.alpha.firmId,routeId?:string):Promise<Row>{
 const now=new Date().toISOString(),snapshot=await publishTestRegistrySnapshot(f.session,f.seeded.alpha.workspaceId,{downloadedAt:now,publishedAt:now});return {workspace_id:f.seeded.alpha.workspaceId,id:randomUUID(),firm_id:firmId,actor_user_id:f.seeded.alpha.admin.userId,device_id:f.seeded.alpha.admin.deviceId,command_id:randomUUID(),phone_route_id:routeId??await route(f),route_version:1,e164:'+14015550123',registry_snapshot_id:snapshot,registry_scrubbed_at:now,reserved_at:now,expires_at:new Date(Date.parse(now)+15000)};
}
/** A real current retained choice and normal confirmation inside the caller's
 * transaction. No nested BEGIN/COMMIT, provider, qualification or acquisition. */
async function prepared(f:Fixture){
 await runtime(f);const ctx=context(f),raw=manualOrdinaryFixture(144),saved=await saveCandidate(ctx,raw);if(!saved.ok)throw Error(saved.reason);
 const runId=randomUUID(),observationId=randomUUID(),text='Office phone: (401) 555-0144',blocks=[{id:'office',text}],hash=(s:string)=>createHash('sha256').update(s).digest('hex');
 const observation={id:observationId,url:raw.website+'contact',contentHash:hash(text),relevantTextHash:hash(JSON.stringify(blocks)),retrievedAt:new Date().toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks};
 const content={website:raw.website,sourceUrls:[raw.sourceUrl],observations:[]};
 await f.session.query(`INSERT INTO sourcing_prospect_phone_discoveries(workspace_id,id,candidate_id,candidate_revision,creator_user_id,creator_ref,method,state,requested_at,deadline_at,expires_at,content)
 VALUES($1,$2,$3,1,$4,$4,'company-public-phone-v1','pending',clock_timestamp()-interval '1 second',clock_timestamp()+interval '29 minutes',clock_timestamp()+interval '59 minutes',$5::jsonb)`,[f.seeded.alpha.workspaceId,runId,saved.value.id,f.seeded.alpha.admin.userId,JSON.stringify(content)]);
 await f.session.query("UPDATE sourcing_prospect_phone_discoveries SET state='running',dispatched_at=clock_timestamp() WHERE id=$1",[runId]);
 await f.session.query("UPDATE sourcing_prospect_phone_discoveries SET state='complete',checked_at=clock_timestamp(),dispatch_finished_at=clock_timestamp(),content=$2::jsonb WHERE id=$1",[runId,JSON.stringify({...content,observations:[observation]})]);
 const choice={runId,observationId,blockId:'office',labelStart:0,labelEnd:12,start:14,end:text.length,contentHash:observation.contentHash,relevantTextHash:observation.relevantTextHash};
 const kept=await recordManualProspectFeedback(ctx,{candidateId:saved.value.id,expectedRevision:1,state:'kept',phoneChoice:choice});if(!kept.ok)throw Error(kept.reason);
 const p=await confirmCallingPreparation(ctx,{selection:{candidateId:saved.value.id,expectedCandidateRevision:1,choice},expected:{state:'absent'},reviewedProfile:{companyName:raw.firmName,website:raw.website,addressLine:null,locality:'Providence',regionCode:'RI',postalCode:null,countryCode:'US',timeZone:{kind:'reviewed',timeZone:'America/New_York'}},acknowledgeUnqualifiedSourceOwnership:true},async()=>true);if(!p.ok)throw Error(p.reason);
 await f.session.query('SET CONSTRAINTS ALL IMMEDIATE');await f.session.query('SET CONSTRAINTS ALL DEFERRED');return p.value;
}
const deferred=(constraint:string,mutate:(f:Fixture,p:Awaited<ReturnType<typeof prepared>>)=>Promise<unknown>):Case=>({constraint,error:{code:'23514',message:'Preparation needs exact current source, owned profile, route and research pause'},run:async f=>{const p=await prepared(f);await mutate(f,p);return f.session.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`);}});
export const CALLING_PREPARATION_CONSTRAINT_CASES:readonly Case[]=[
 bad('calling_preparations_candidate_revision_check',{candidate_revision:0}),
 bad('calling_preparations_revision_check',{revision:0}),
 bad('calling_preparations_route_version_check',{route_version:0}),
 bad('calling_preparations_state_check',{state:'rebound'},'calling_preparations_check2'),
 bad('calling_preparations_check',{firm_id:missing}),
 bad('calling_preparations_check1',{updated_at:'2000-01-01T00:00:00Z'}),
 bad('calling_preparations_check2',{choice:'{}'}),
 bad('calling_preparations_erase_reason_check',()=>({state:'erased',choice:null,source_url_hashes:null,profile_hash:null,erased_at:new Date(Date.now()+1000),erase_reason:'rebound'})),
 duplicate('calling_preparations_pkey',()=>({})),
 duplicate('calling_preparations_workspace_id_candidate_ref_key',()=>({id:randomUUID()})),
 duplicate('calling_preparations_workspace_id_firm_ref_key',()=>({id:randomUUID(),candidate_ref:randomUUID()})),
 duplicate('calling_preparations_workspace_id_route_ref_key',()=>({id:randomUUID(),candidate_ref:randomUUID(),firm_ref:missing,firm_id:missing})),
 bad('calling_preparations_workspace_id_fkey',{workspace_id:missing}),
 {constraint:'calling_preparations_workspace_id_firm_id_fkey',run:async f=>{const p=await row(f);await runtime(f);await insert(f,'calling_preparations',{...p,firm_ref:missing,firm_id:missing});return f.session.query('SET CONSTRAINTS calling_preparations_workspace_id_firm_id_fkey IMMEDIATE');}},
 {constraint:'calling_preparations_workspace_id_phone_route_id_fkey',run:async f=>{const p=await row(f);await runtime(f);await insert(f,'calling_preparations',{...p,route_ref:missing,phone_route_id:missing});return f.session.query('SET CONSTRAINTS calling_preparations_workspace_id_phone_route_id_fkey IMMEDIATE');}},
 bad('calling_preparations_workspace_id_research_hold_id_fkey',{research_hold_id:missing}),
 {constraint:'firms_workspace_id_calling_preparation_id_fkey',run:async f=>{await isolate(f,'firms','firms_preparation_copy_guard');await runtime(f);return f.session.query('UPDATE firms SET calling_preparation_id=$2 WHERE id=$1',[f.crm.alpha.firmId,missing]);}},
 {constraint:'phone_routes_workspace_id_calling_preparation_id_fkey',run:async f=>{await isolate(f,'phone_routes','routes_preparation_copy_guard');await runtime(f);return f.session.query('UPDATE phone_routes SET calling_preparation_id=$2 WHERE firm_id=$1',[f.crm.alpha.firmId,missing]);}},
 {constraint:'dial_tickets_workspace_id_calling_preparation_id_fkey',run:async f=>{const t=await ticket(f);await isolate(f,'dial_tickets','tickets_preparation_copy_guard');await runtime(f);return insert(f,'dial_tickets',{...t,calling_preparation_id:missing});}},
 {constraint:'phone_handoff_attempts_workspace_id_calling_preparation_id_fkey',run:async f=>{const h=await handoff(f);await isolate(f,'phone_handoff_attempts','handoffs_preparation_copy_guard');await runtime(f);return insert(f,'phone_handoff_attempts',{...h,calling_preparation_id:missing});}},
 {constraint:'firms_preparation_erasure',run:async f=>{await runtime(f);return f.session.query('UPDATE firms SET calling_preparation_erased_at=clock_timestamp() WHERE id=$1',[f.crm.alpha.firmId]);}},
 {constraint:'phone_routes_preparation_erasure',run:async f=>{await runtime(f);return f.session.query('UPDATE phone_routes SET e164=NULL WHERE firm_id=$1',[f.crm.alpha.firmId]);}},
 {constraint:'dial_tickets_preparation_erasure',run:async f=>{const t=await ticket(f);await runtime(f);return insert(f,'dial_tickets',{...t,e164:null});}},
 {constraint:'phone_handoff_prepared_outcome_once',run:async f=>{const h=await handoff(f);await runtime(f);return insert(f,'phone_handoff_attempts',{...h,calling_preparation_outcome_recorded_at:new Date()});}},
 deferred('preparation_consistency',(f,p)=>f.session.query('UPDATE calling_preparations SET revision=revision+1,profile_hash=$2 WHERE id=$1',[p.preparationId,'b'.repeat(64)])),
 deferred('firm_preparation_consistency',(f,p)=>f.session.query("UPDATE firms SET name='Unreviewed replacement' WHERE id=$1",[p.firmId])),
 deferred('route_preparation_consistency',(f,p)=>f.session.query('UPDATE phone_routes SET version=version+1 WHERE id=$1',[p.routeId])),
 deferred('ticket_preparation_consistency',async(f,p)=>{const t=await ticket(f,p.firmId,p.routeId);return insert(f,'dial_tickets',{...t,calling_preparation_id:p.preparationId});}),
 deferred('handoff_preparation_consistency',async(f,p)=>{await lockPreparationCleanup(context(f));return insert(f,'phone_handoff_attempts',{...await handoff(f,p.firmId,p.routeId),calling_preparation_id:p.preparationId});}),
];
