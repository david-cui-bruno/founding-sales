import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {saveDiscoveryCandidate} from '../../sourcing/discoveryIntake.ts';
import {manualOrdinaryFixture,manualDiscoveryFixture} from './support/manualProspectFixture.ts';
import {manualPhoneFixture,seedManualPhoneRun} from './support/manualPhoneFixture.ts';
import {saveManualProspectActivity,readManualProspectActivity} from '../../sourcing/manualProspectActivity.ts';
import {previewDeletion,commitDeletion} from '../../retention/deletion.ts';
import {recordingSuppressionJournal} from '../../suppression/journal.ts';
import {runRetentionBatch} from '../../retention/runs.ts';
import {lockDiscoveryReviewSources} from '../../sourcing/discoveryReviewVisibility.ts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable,index=1800;
const ctx=(session=runtime,workspace:'alpha'|'beta'='alpha')=>repositoryContext(workspaceScope(seed[workspace].workspaceId,{kind:'user',userId:seed[workspace].admin.userId,role:'admin'}),session);
const content={performedByUser:true as const,channel:'manual_phone' as const,occurrence:{kind:'unknown' as const},result:'unknown' as const,note:'Synthetic R777-1 private current body',callback:null};
const tx=<T>(work:()=>Promise<T>,session=runtime)=>withTransaction(session,work);
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
afterAll(async()=>db?.drop());
async function fixture(association:'ordinary'|'lastSuccess'|'discovery'='ordinary',workspace:'alpha'|'beta'='alpha'){
 const input=manualOrdinaryFixture(++index),raw=manualDiscoveryFixture(randomUUID());
 const saved=association==='discovery'?await tx(()=>saveDiscoveryCandidate(ctx(runtime,workspace),raw)):await tx(()=>saveCandidate(ctx(runtime,workspace),input));if(!saved.ok)throw Error(saved.reason);
 const candidateId=saved.value.id,attemptId=randomUUID(),source=association==='discovery'?raw.row.source.sourceUrl:input.sourceUrl;
 const evidenceSource=association==='lastSuccess'?`https://source.example.test/check-${randomUUID()}`:source;
 if(association==='lastSuccess')await runtime.query(`UPDATE sourcing_candidates SET source_check=jsonb_build_object('state','idle','lastSuccess',jsonb_build_object('url',$2::text)) WHERE id=$1`,[candidateId,evidenceSource]);
 expect(await tx(()=>saveManualProspectActivity(ctx(runtime,workspace),{...content,operation:'create',candidateId,expectedCandidateRevision:1,attemptId},async()=>true))).toMatchObject({ok:true});
 const firmId=(await runtime.query<{id:string}>('INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,$2,$3) RETURNING id',[seed[workspace].workspaceId,'Synthetic deletion source parent',seed[workspace].admin.userId])).rows[0]!.id;
 return {candidateId,attemptId,source:evidenceSource,firmId,workspace,base:{candidateId,expectedCandidateRevision:1,attemptId}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function evidence(f:Fixture,source=f.source,workspace=f.workspace,denied:'expired'|'permitted'='expired'){
 const firmId=workspace===f.workspace?f.firmId:(await runtime.query<{id:string}>('INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,$2,$3) RETURNING id',[seed[workspace].workspaceId,'Synthetic foreign evidence parent',seed[workspace].admin.userId])).rows[0]!.id;
 return (await runtime.query<{id:string}>(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at) VALUES($1,$2,'website',$3,$4,true,CASE WHEN $5='permitted' THEN clock_timestamp()+interval '1 day' ELSE clock_timestamp()-interval '1 second' END) RETURNING id`,[seed[workspace].workspaceId,firmId,source+'/', createHash('sha256').update(randomUUID()).digest('hex'),denied])).rows[0]!.id;
}
async function preview(f:Fixture){const p=await tx(()=>previewDeletion(ctx(runtime,f.workspace),{targetKind:'firm',firmId:f.firmId}));if(!p.ok)throw Error(p.reason);return {requestId:p.value.requestId,previewHash:p.value.previewHash,commandId:randomUUID(),journal:recordingSuppressionJournal()};}
async function remove(f:Fixture){const p=await preview(f);expect(await tx(()=>commitDeletion(ctx(runtime,f.workspace),p))).toMatchObject({ok:true});}
async function available(f:Fixture){expect(await tx(()=>readManualProspectActivity(ctx(runtime,f.workspace),f.base,async()=>true))).toMatchObject({availability:'available',note:content.note});}
it.each(['ordinary','lastSuccess','discovery'] as const)('R777-1 normal preview/commit erases expired %s source before denial disappears',async association=>{
 const f=await fixture(association),id=await evidence(f);
 await expect(tx(()=>readManualProspectActivity(ctx(),f.base,async()=>true))).rejects.toMatchObject({reason:'candidate_unavailable'});
 await remove(f);
 expect((await runtime.query('SELECT id FROM evidence_items WHERE id=$1',[id])).rows).toEqual([]);
 expect((await runtime.query('SELECT content,reason,revision FROM sourcing_manual_prospect_attempts WHERE id=$1',[f.attemptId])).rows).toEqual([{content:null,reason:'source_changed_or_unavailable',revision:2}]);
 await expect(tx(()=>readManualProspectActivity(ctx(),f.base,async()=>true))).rejects.toMatchObject({reason:'candidate_unavailable'});
 await tx(()=>runRetentionBatch(ctx(),{dataKind:'research_evidence',period:association==='ordinary'?'2026-10-21':association==='lastSuccess'?'2026-10-22':'2026-10-23',limit:50}));
 await expect(tx(()=>readManualProspectActivity(ctx(),f.base,async()=>true))).rejects.toMatchObject({reason:'candidate_unavailable'});
 expect((await runtime.query('SELECT detail FROM audit_events WHERE action=$1 AND subject_kind=$2 AND workspace_id=$3',['sourcing.manual_source_retention_expired','sourcing_source_hash',seed.alpha.workspaceId])).rows.every(r=>JSON.stringify(r['detail'])==='{}')).toBe(true);
});
it('normal deletion preserves unrelated, foreign workspace, permitted and optional-phone-only independence',async()=>{
 const f=await fixture(),foreign=await fixture('ordinary','beta');
 await evidence(f,'https://source.example.test/unrelated');await evidence(f,f.source,'beta');await evidence(f,f.source,'alpha','permitted');
 const phone='https://source.example.test/optional-phone-only';await seedManualPhoneRun(runtime,seed.alpha.workspaceId,f.candidateId,manualPhoneFixture(phone));await evidence(f,phone);
 await remove(f);await available(f);await available(foreign);
 expect((await runtime.query('SELECT subject_id FROM audit_events WHERE workspace_id=$1 AND action=$2 AND subject_id=encode(sha256(convert_to($3,\'UTF8\')),\'hex\')',[seed.alpha.workspaceId,'sourcing.manual_source_retention_expired',phone])).rows).toEqual([]);
});
it('normal deletion waits for source lifecycle before Ask/rows, then refused save cannot restore content',async()=>{
 const f=await fixture();await evidence(f);const p=await preview(f),blocker=await db.appRuntimeSession(),deletion=await db.appRuntimeSession();
 await blocker.query('BEGIN');await lockDiscoveryReviewSources(ctx(blocker));
 const pid=(await deletion.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 const pending=tx(()=>commitDeletion(ctx(deletion),p),deletion);
 try{
  await expect.poll(async()=>String((await db.session.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.['wait_event_type'])).toBe('Lock');
  // No request/firm row lock or Ask advisory lock can precede the source owner.
  expect(Number((await db.session.query("SELECT count(*)::int n FROM pg_locks WHERE pid=$1 AND granted AND locktype='advisory'",[pid])).rows[0]?.['n'])).toBe(0);
 }finally{await blocker.query('COMMIT');}
 expect(await pending).toMatchObject({ok:true});
 await expect(tx(()=>saveManualProspectActivity(ctx(),{...content,operation:'update',...f.base,expectedActivityRevision:1},async()=>true))).rejects.toMatchObject({reason:'candidate_unavailable'});
 expect((await runtime.query('SELECT content FROM sourcing_manual_prospect_attempts WHERE id=$1',[f.attemptId])).rows).toEqual([{content:null}]);
});
it('a real accepted save holds deletion outside its hierarchy, then deletion clears both attempts without touching same-URL foreign content',async()=>{
 const f=await fixture(),foreign=await fixture('ordinary','beta'),e=await evidence(f,f.source,'alpha','permitted');
 await runtime.query(`UPDATE sourcing_candidates SET payload=jsonb_set(payload,'{sourceUrl}',to_jsonb($2::text)) WHERE id=$1`,[foreign.candidateId,f.source]);await available(foreign);
 const writer=await db.appRuntimeSession(),deletion=await db.appRuntimeSession(),attemptId=randomUUID();
 await writer.query('BEGIN');
 expect(await saveManualProspectActivity(ctx(writer),{...content,operation:'create',candidateId:f.candidateId,expectedCandidateRevision:1,attemptId},async()=>true)).toMatchObject({ok:true});
 await runtime.query("UPDATE evidence_items SET retention_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[e]);
 const p=await preview(f),pid=(await deletion.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid,pending=tx(()=>commitDeletion(ctx(deletion),p),deletion);
 try{await expect.poll(async()=>String((await db.session.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.['wait_event_type'])).toBe('Lock');}
 finally{await writer.query('COMMIT');}
 expect(await pending).toMatchObject({ok:true});
 expect((await runtime.query('SELECT content,reason FROM sourcing_manual_prospect_attempts WHERE id=ANY($1::uuid[])',[ [attemptId,f.attemptId] ])).rows).toEqual([{content:null,reason:'source_changed_or_unavailable'},{content:null,reason:'source_changed_or_unavailable'}]);
 await available(foreign);
});
