import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {withTransaction} from '../../db/queryable.ts';
import {seedTwoWorkspaces} from './support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {manualOrdinaryFixture} from '../sourcing/support/manualProspectFixture.ts';
// 0155 (ADR0034): calling_preparations.source_kind; a prepared own-site capture may be a preparation's phone source.
// Touches-existing, additive: one defaulted column, same-body assertion function except its source clause, two new guards.
let db:TestDatabase,w:string,pid:string,firmId:string,candidate:string,before:Record<string,unknown>;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
beforeAll(async()=>{
 db=await createTestDatabase({throughVersion:154});const seed=await seedTwoWorkspaces(db.session);w=seed.alpha.workspaceId;
 const admin=seed.alpha.admin.userId,ctx=repositoryContext(workspaceScope(w,{kind:'user',userId:admin,role:'admin'}),db.session);
 const raw=manualOrdinaryFixture(819);raw.sourceUrl=`${raw.website}about`;
 const saved=await saveCandidate(ctx,raw);if(!saved.ok)throw Error(saved.reason);candidate=saved.value.id;
 // A native schema154 phone-discovery preparation, written as the schema154 writer did (no source_kind).
 const runId=randomUUID(),observationId=randomUUID(),text='Office phone: (401) 555-0142',requestedAt=new Date(Date.now()-1000).toISOString();
 const blocks=[{id:'office',text}],content={website:raw.website,sourceUrls:[raw.sourceUrl],observations:[]};
 await db.session.query(`INSERT INTO sourcing_prospect_phone_discoveries(workspace_id,id,candidate_id,candidate_revision,creator_user_id,creator_ref,method,state,requested_at,deadline_at,expires_at,content)
  VALUES($1,$2,$3,1,$4,$4,'company-public-phone-v1','pending',$5,$5::timestamptz+interval '30 minutes',$5::timestamptz+interval '1 hour',$6::jsonb)`,[w,runId,candidate,admin,requestedAt,JSON.stringify(content)]);
 await db.session.query("UPDATE sourcing_prospect_phone_discoveries SET state='running',dispatched_at=clock_timestamp() WHERE id=$1",[runId]);
 const observation={id:observationId,url:`${raw.website}contact`,contentHash:sha(text),relevantTextHash:sha(JSON.stringify(blocks)),retrievedAt:new Date().toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks};
 await db.session.query("UPDATE sourcing_prospect_phone_discoveries SET state='complete',checked_at=clock_timestamp(),dispatch_finished_at=clock_timestamp(),content=$2::jsonb WHERE id=$1",[runId,JSON.stringify({...content,observations:[observation]})]);
 const choice={runId,observationId,blockId:'office',labelStart:0,labelEnd:12,start:14,end:text.length,contentHash:observation.contentHash,relevantTextHash:observation.relevantTextHash};
 await db.session.query("INSERT INTO sourcing_manual_prospect_states(workspace_id,candidate_id,candidate_revision,state,manual_phone_choice) VALUES($1,$2,1,'kept',$3::jsonb)",[w,candidate,JSON.stringify(choice)]);
 pid=randomUUID();firmId=randomUUID();const routeId=randomUUID();
 await withTransaction(db.session,async()=>{
  await db.session.query(`INSERT INTO calling_preparations(workspace_id,id,candidate_ref,candidate_revision,discovery_run_ref,source_creator_ref,prepared_by_ref,firm_ref,route_ref,firm_id,phone_route_id,choice,source_url_hashes,profile_hash,source_expires_at)
   VALUES($1,$2,$3,1,$4,$5,$5,$6,$7,$6,$7,$8::jsonb,$9::text[],repeat('a',64),clock_timestamp()+interval '30 minutes')`,[w,pid,candidate,runId,admin,firmId,routeId,JSON.stringify(choice),[sha(raw.website.replace(/\/+$/u,''))]]);
  await db.session.query("INSERT INTO firms(workspace_id,id,name,calling_preparation_id,country_code) VALUES($1,$2,'Upgrade Preparation Company',$3,'US')",[w,firmId,pid]);
  await db.session.query("INSERT INTO phone_routes(workspace_id,id,firm_id,e164,source,retrieved_at,technical_validation,eligibility,calling_preparation_id) VALUES($1,$2,$3,'+14015550142','website',now(),'unknown','candidate',$4)",[w,routeId,firmId,pid]);
  const hold=(await db.session.query<{id:string}>(`INSERT INTO active_holds(workspace_id,scope_kind,scope_key,reason_code,blocked_action_kinds,source_event_kind,source_event_id)
   VALUES($1,'firm',$2,'scoped_pause',ARRAY['research']::text[],'calling_preparation',$3) RETURNING id`,[w,firmId,pid])).rows[0]!.id;
  await db.session.query('UPDATE calling_preparations SET research_hold_id=$3,profile_hash=calling_preparation_profile_hash($1,$4) WHERE workspace_id=$1 AND id=$2',[w,pid,hold,firmId]);
 });
 before=(await db.session.query<Record<string,unknown>>('SELECT * FROM calling_preparations WHERE id=$1',[pid])).rows[0]!;
});
afterAll(async()=>{await db.drop();});
it('upgrades a populated schema154 to 155 leaving the phone-discovery preparation byte-identical apart from the defaulted kind',async()=>{
 expect(before).not.toHaveProperty('source_kind');
 await applyMigrations(db.session,{throughVersion:155});expect(await readAppliedSchemaVersion(db.session)).toBe(155);
 const after=(await db.session.query<Record<string,unknown>>('SELECT * FROM calling_preparations WHERE id=$1',[pid])).rows[0]!;
 expect(after).toEqual({...before,source_kind:'phone_discovery'});
 // The replaced assertion still accepts the existing discovery-run binding, and the discovery loss paths are untouched.
 await db.session.query('SELECT assert_calling_preparation_consistent($1,$2)',[w,pid]);
 expect((await db.session.query('SELECT name FROM firms WHERE id=$1',[firmId])).rows).toEqual([{name:'Upgrade Preparation Company'}]);
 const runtime=await db.appRuntimeSession();
 expect((await runtime.query("SELECT has_table_privilege(current_user,'calling_preparations','SELECT,INSERT,UPDATE') allowed")).rows).toEqual([{allowed:true}]);
});
it('holds the kind immutable and bounded, and installs the prepared-run loss guard',async()=>{
 await expect(db.session.query("UPDATE calling_preparations SET source_kind='prepared_capture' WHERE id=$1",[pid])).rejects.toMatchObject({code:'23514'});
 const def=(await db.session.query<{def:string}>("SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname='calling_preparations_source_kind'")).rows[0]!.def;
 expect(def).toMatch(/phone_discovery.*prepared_capture/u);expect(def).toMatch(/source_creator_ref = prepared_by_ref/u);
 expect((await db.session.query("SELECT tgname FROM pg_trigger WHERE tgname IN('calling_preparation_prepared_run_source','calling_preparation_source_kind_guard') ORDER BY 1")).rows)
  .toEqual([{tgname:'calling_preparation_prepared_run_source'},{tgname:'calling_preparation_source_kind_guard'}]);
});
it('leaves a phone-discovery preparation alone when an unrelated qualification run is updated',async()=>{
 await db.session.query("INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,capture_policy_version) VALUES($1,$2,$3,1,repeat('c',64),'qualification-context-v7','qualification-v5','claude-haiku-4-5','prepared-source-association-v2')",[w,randomUUID(),candidate]);
 await db.session.query("UPDATE sourcing_qualification_runs SET observations='[]'::jsonb WHERE candidate_id=$1",[candidate]);
 expect((await db.session.query("SELECT state,source_kind FROM calling_preparations WHERE id=$1",[pid])).rows).toEqual([{state:'live',source_kind:'phone_discovery'}]);
});
