import {randomUUID,createHash} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {manualOrdinaryFixture} from '../sourcing/support/manualProspectFixture.ts';
import {captureProspectPhonePages,requestProspectPhoneDiscovery} from '../../sourcing/prospectPhoneDiscovery.ts';
import {PROSPECT_PHONE_DISCOVERY_CONSTRAINT_CASES} from './prospectPhoneDiscoveryConstraints.ts';
import {TABLE_RETENTION_COVERAGE} from '../../retention/coverage.ts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable,serial=1000;
beforeAll(async()=>{db=await createTestDatabase({throughVersion:138});seed=await seedTwoWorkspaces(db.session);await applyMigrations(db.session,{throughVersion:139});expect(await readAppliedSchemaVersion(db.session)).toBe(139);runtime=await db.appRuntimeSession();});
afterAll(async()=>db?.drop());
it.each(PROSPECT_PHONE_DISCOVERY_CONSTRAINT_CASES)('new strict SQL constraint $constraint refuses its isolated invalid row',async entry=>{
 await db.session.query('BEGIN');try{await expect(entry.run({session:db.session,seeded:seed})).rejects.toMatchObject({constraint:entry.constraint});}finally{await db.session.query('ROLLBACK');}
});
it('new table exact constraint and retention catalogs cover every temporary original boundary',async()=>{
 const names=(await db.session.query<{name:string}>("SELECT conname AS name FROM pg_constraint WHERE conrelid='sourcing_prospect_phone_discoveries'::regclass AND contype IN ('c','u','f','p','t','x')")).rows.map(row=>row.name).sort();
 expect(names).toEqual(PROSPECT_PHONE_DISCOVERY_CONSTRAINT_CASES.map(entry=>entry.constraint).sort());
 expect(TABLE_RETENTION_COVERAGE['sourcing_prospect_phone_discoveries']?.dispositions).toEqual(['deletion_removes','swept','departure_revokes']);
});
async function fixture(){
 const ctx=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),runtime),input=manualOrdinaryFixture(++serial);input.sourceUrl=`${input.website}about`;
 const saved=await withTransaction(runtime,()=>saveCandidate(ctx,input));if(!saved.ok)throw Error(saved.reason);
 const result=await withTransaction(runtime,()=>requestProspectPhoneDiscovery(ctx,{candidateId:saved.value.id,expectedRevision:1}));if(!result.ok)throw Error(result.reason);
 const row=(await runtime.query('SELECT * FROM sourcing_prospect_phone_discoveries WHERE id=$1',[result.value.runId])).rows[0]!;
 return {id:result.value.runId,candidateId:saved.value.id,website:input.website!,content:row['content'] as Record<string,unknown>};
}
async function rejected(sql:string,params:unknown[],code='23514'){
 await runtime.query('BEGIN');try{await expect(runtime.query(sql,params)).rejects.toMatchObject({code});}finally{await runtime.query('ROLLBACK');}
}
it('app_runtime cannot extend, substitute, skip dispatch, erase tombstones or reopen a run',async()=>{
 const f=await fixture();
 for(const change of ["expires_at=expires_at+interval '1 second'","candidate_revision=2","creator_user_id=gen_random_uuid()","method='other'","state='complete',dispatched_at=clock_timestamp(),dispatch_finished_at=clock_timestamp(),checked_at=clock_timestamp()"])
  await rejected(`UPDATE sourcing_prospect_phone_discoveries SET ${change} WHERE id=$1`,[f.id]);
 await runtime.query("UPDATE sourcing_prospect_phone_discoveries SET state='running',dispatched_at=clock_timestamp() WHERE id=$1",[f.id]);
 await rejected("UPDATE sourcing_prospect_phone_discoveries SET state='pending',dispatched_at=NULL WHERE id=$1",[f.id]);
 await runtime.query("UPDATE sourcing_prospect_phone_discoveries SET state='unavailable',reason='source_unavailable',content=NULL,checked_at=clock_timestamp() WHERE id=$1",[f.id]);
 await rejected("UPDATE sourcing_prospect_phone_discoveries SET state='running',reason=NULL,content=$2::jsonb,checked_at=NULL WHERE id=$1",[f.id,JSON.stringify(f.content)]);
 await rejected('DELETE FROM sourcing_prospect_phone_discoveries WHERE id=$1',[f.id],'42501');
 await runtime.query('DELETE FROM sourcing_candidates WHERE id=$1',[f.candidateId]);
 expect((await runtime.query('SELECT id FROM sourcing_prospect_phone_discoveries WHERE id=$1',[f.id])).rows).toHaveLength(0);
});
it('database validates exact original hashes, shapes, same-site binding, byte bounds and source association',async()=>{
 const f=await fixture(),body=new TextEncoder().encode('Office phone: (214) 555-0123');
 const capture=captureProspectPhonePages([{url:`${f.website}contact`,body,contentType:'text/plain',contentHash:createHash('sha256').update(body).digest('hex'),retrievedAt:new Date().toISOString(),firstParty:true}],f.website,4,1000000,Date.now());
 if(!capture.ok)throw Error(capture.reason);
 const content={...f.content,observations:capture.value};
 const valid=async(value:unknown)=>(await runtime.query<{valid:boolean}>('SELECT prospect_phone_content_valid($1::jsonb) valid',[JSON.stringify(value)])).rows[0]?.valid;
 expect(await valid(content)).toBe(true);
 for(const value of [null,{}, {...content,extra:true},{...content,sourceUrls:[]},{...content,observations:[{...capture.value[0],url:'https://foreign.example.test/contact'}]},{...content,observations:[{...capture.value[0],relevantTextHash:'0'.repeat(64)}]},{...content,observations:[{...capture.value[0],blocks:[{id:'b1',text:'😀'.repeat(2001)}]}]}])expect(await valid(value)).toBe(false);
 await rejected("UPDATE sourcing_prospect_phone_discoveries SET content=$2::jsonb WHERE id=$1",[f.id,JSON.stringify({...f.content,sourceUrls:['https://other.example.test']})]);
 await runtime.query("UPDATE sourcing_prospect_phone_discoveries SET state='running',dispatched_at=clock_timestamp() WHERE id=$1",[f.id]);
 await runtime.query("UPDATE sourcing_prospect_phone_discoveries SET state='complete',checked_at=clock_timestamp(),dispatch_finished_at=clock_timestamp(),content=$2::jsonb WHERE id=$1",[f.id,JSON.stringify(content)]);
 await rejected("UPDATE sourcing_prospect_phone_discoveries SET content=$2::jsonb WHERE id=$1",[f.id,JSON.stringify({...content,observations:[]})]);
});
it('same workspace candidate and creator are mandatory and the unique revision fence is durable',async()=>{
 const f=await fixture();
 for(const [workspace,creator] of [[seed.beta.workspaceId,seed.beta.admin.userId],[seed.alpha.workspaceId,seed.beta.admin.userId],[seed.alpha.workspaceId,seed.alpha.salesperson.userId]])
  await rejected(`INSERT INTO sourcing_prospect_phone_discoveries(workspace_id,id,candidate_id,candidate_revision,creator_user_id,creator_ref,method,requested_at,deadline_at,expires_at,content) VALUES($1,$2,$3,1,$4,$4,'company-public-phone-v1',clock_timestamp(),clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '1 day',$5::jsonb)`,[workspace,randomUUID(),f.candidateId,creator,JSON.stringify(f.content)]);
 await rejected(`INSERT INTO sourcing_prospect_phone_discoveries SELECT workspace_id,$2,candidate_id,candidate_revision,creator_user_id,creator_ref,method,state,reason,requested_at,deadline_at,checked_at,expires_at,dispatched_at,dispatch_finished_at,content FROM sourcing_prospect_phone_discoveries WHERE id=$1`,[f.id,randomUUID()],'23505');
});
