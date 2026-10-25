import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {saveDiscoveryCandidate} from '../../sourcing/discoveryIntake.ts';
import {manualOrdinaryFixture,manualDiscoveryFixture} from './support/manualProspectFixture.ts';
import {saveManualProspectActivity,listManualProspectActivity,readManualProspectActivity} from '../../sourcing/manualProspectActivity.ts';
import type {ManualProspectActivitySaveInput} from '@fss/contracts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const ctx=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),runtime);
const authority=async()=>true;
const content={performedByUser:true as const,channel:'manual_phone' as const,occurrence:{kind:'unknown' as const},result:'unknown' as const,note:'Synthetic report only',callback:null};
async function parent(discovery=false){const saved=discovery?await withTransaction(runtime,()=>saveDiscoveryCandidate(ctx(),manualDiscoveryFixture(randomUUID()))):await withTransaction(runtime,()=>saveCandidate(ctx(),manualOrdinaryFixture(Math.floor(Math.random()*1e8))));if(!saved.ok)throw Error(saved.reason);return saved.value.id;}
const save=(input:ManualProspectActivitySaveInput)=>withTransaction(runtime,()=>saveManualProspectActivity(ctx(),input,authority));
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
afterAll(async()=>db?.drop());
it.each([false,true])('records unknown-phone ordinary/discovery=%s, metadata-only list, current read, CAS correction/callback clear and terminal withdrawal',async discovery=>{
 const candidateId=await parent(discovery),attemptId=randomUUID(),base={candidateId,expectedCandidateRevision:1,attemptId};
 const saved=await save({...base,...content,operation:'create'});expect(saved).toMatchObject({ok:true,value:{attemptId,activityRevision:1}});
 expect(await save({...base,...content,operation:'create'})).toMatchObject({ok:false,reason:'already_exists'});
 const list=await withTransaction(runtime,()=>listManualProspectActivity(ctx(),{candidateId,expectedCandidateRevision:1},authority));expect(list.activities).toHaveLength(1);expect(JSON.stringify(list)).not.toContain(content.note);
 expect(await withTransaction(runtime,()=>readManualProspectActivity(ctx(),base,authority))).toMatchObject({availability:'available',result:'unknown',occurrence:{kind:'unknown'},contactAuthority:'not_granted'});
 const callback={note:'Intention only',timing:{kind:'confirmed' as const,localDate:'2026-10-26',localTime:'09:30',sourceTimeZone:'America/New_York',dueAt:'2026-10-26T13:30:00.000Z'}};
 expect(await save({...base,...content,operation:'update',expectedActivityRevision:1,result:'callback_requested',callback})).toMatchObject({ok:true,value:{activityRevision:2}});
 expect(await save({...base,...content,operation:'update',expectedActivityRevision:1})).toMatchObject({ok:false,reason:'stale_revision'});
 expect(await save({...base,...content,operation:'update',expectedActivityRevision:2,result:'wrong_number'})).toMatchObject({ok:true,value:{activityRevision:3}});
 expect(await withTransaction(runtime,()=>readManualProspectActivity(ctx(),base,authority))).toMatchObject({result:'wrong_number',callback:null});
 expect(await save({...base,...content,operation:'update',expectedActivityRevision:3})).toMatchObject({ok:true,value:{activityRevision:4}});
 expect(await save({...base,operation:'withdraw',expectedActivityRevision:4})).toMatchObject({ok:true,value:{activityRevision:5}});
 expect((await runtime.query('SELECT content,reason FROM sourcing_manual_prospect_attempts WHERE id=$1',[attemptId])).rows).toEqual([{content:null,reason:'withdrawn'}]);
 expect(await save({...base,...content,operation:'update',expectedActivityRevision:5})).toMatchObject({ok:false,reason:'removed'});
 for(const table of ['firms','contacts','phone_routes','call_logs','callbacks','today_items','sequence_enrollments','outbound_messages','provider_reservations','phone_handoff_attempts','sourcing_qualification_runs','sourcing_manual_prospect_states'])expect((await runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});
it('keeps multiple attempts and bounded keyset pages, never outcome/time/prose in metadata',async()=>{
 const candidateId=await parent();for(let n=0;n<21;n++)expect(await save({...content,candidateId,expectedCandidateRevision:1,attemptId:randomUUID(),operation:'create'})).toMatchObject({ok:true});
 const page=await withTransaction(runtime,()=>listManualProspectActivity(ctx(),{candidateId,expectedCandidateRevision:1},authority));expect(page.activities).toHaveLength(20);expect(page.nextAfterId).not.toBeNull();expect(Object.keys(page.activities[0]!)).toEqual(['candidateId','candidateRevision','attemptId','activityRevision','recordedAt','updatedAt','availability']);
 const next=await withTransaction(runtime,()=>listManualProspectActivity(ctx(),{candidateId,expectedCandidateRevision:1,afterId:page.nextAfterId!},authority));expect(next.activities).toHaveLength(1);expect(next.nextAfterId).toBeNull();
});
it('final principal refusal after write rolls back content and audit atomically',async()=>{
 const candidateId=await parent(),attemptId=randomUUID();let checks=0;
 await expect(withTransaction(runtime,()=>saveManualProspectActivity(ctx(),{...content,candidateId,expectedCandidateRevision:1,attemptId,operation:'create'},async()=>++checks===1))).rejects.toThrow();
 expect((await runtime.query('SELECT id FROM sourcing_manual_prospect_attempts WHERE id=$1',[attemptId])).rows).toEqual([]);expect((await runtime.query('SELECT id FROM audit_events WHERE subject_id=$1',[attemptId])).rows).toEqual([]);
});
it('rejects future occurrence, nonexistent/fold callback and mismatched instants without writes',async()=>{
 const candidateId=await parent();
 for(const timing of [
 {localDate:'2026-03-08',localTime:'02:30',sourceTimeZone:'America/New_York',dueAt:'2026-03-08T07:30:00Z'},
 {localDate:'2026-11-01',localTime:'01:30',sourceTimeZone:'America/New_York',dueAt:'2026-11-01T05:30:00Z'},
 {localDate:'2026-10-26',localTime:'09:30',sourceTimeZone:'America/New_York',dueAt:'2026-10-26T14:30:00Z'},
 ])expect(await save({...content,candidateId,expectedCandidateRevision:1,attemptId:randomUUID(),operation:'create',result:'callback_requested',callback:{note:null,timing:{kind:'confirmed',...timing}}})).toMatchObject({ok:false,reason:'invalid_time'});
 expect(await save({...content,candidateId,expectedCandidateRevision:1,attemptId:randomUUID(),operation:'create',occurrence:{kind:'known',occurredAt:'2099-01-01T00:00:00Z'}})).toMatchObject({ok:false,reason:'invalid_time'});
 expect((await runtime.query('SELECT id FROM sourcing_manual_prospect_attempts WHERE candidate_id=$1',[candidateId])).rows).toEqual([]);
});
