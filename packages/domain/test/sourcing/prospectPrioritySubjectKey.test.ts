import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {saveDiscoveryCandidate} from '../../sourcing/discoveryIntake.ts';
import {manualOrdinaryFixture,manualDiscoveryFixture} from './support/manualProspectFixture.ts';
import {MANUAL_ACTIVITY_RAW_SQL,manualActivityRaw,currentManualActivityAuthority} from '../../sourcing/manualProspectActivityAccess.ts';
import {prioritySourceKey} from '../../sourcing/prospectPriorityAccess.ts';
import {projectManualProspect,type ManualProspectRow} from '../../sourcing/manualProspectProjection.ts';
import {MANUAL_SOURCE_LOSS_ACTION} from '../../sourcing/manualProspectSourceLoss.ts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable,serial=90000;
const ctx=(session=runtime,workspace:'alpha'|'beta'='alpha')=>repositoryContext(workspaceScope(seed[workspace].workspaceId,{kind:'user',userId:seed[workspace].admin.userId,role:'admin'}),session);
async function ordinary(){const input=manualOrdinaryFixture(++serial),saved=await withTransaction(runtime,()=>saveCandidate(ctx(),input));if(!saved.ok)throw Error(saved.reason);return {id:saved.value.id,input};}
async function discovery(){const input=manualDiscoveryFixture(randomUUID());input.row.website='https://synthetic.example.test/';const saved=await withTransaction(runtime,()=>saveDiscoveryCandidate(ctx(),input));if(!saved.ok)throw Error(saved.reason);return {id:saved.value.id,input};}
async function parity(id:string,revision=1,workspace:'alpha'|'beta'='alpha'){
 const context=ctx(runtime,workspace),values=[context.scope.workspaceId,'all',id,revision];
 const previous=(await runtime.query<ManualProspectRow>(`SELECT * FROM (${MANUAL_ACTIVITY_RAW_SQL}) p WHERE id=$3 AND revision=$4`,values)).rows[0];
 const oldKey=(await runtime.query<{key:string}>(`SELECT encode(sha256(convert_to(p.payload::text||COALESCE(p.origins::text,'')||COALESCE(p.source_check::text,''),'UTF8')),'hex') key FROM (${MANUAL_ACTIVITY_RAW_SQL}) p WHERE id=$3 AND revision=$4`,values)).rows[0]?.key??null;
 const key=await prioritySourceKey(context,id,revision);
 expect(key).toBe(oldKey);expect(await manualActivityRaw(context,id,revision)).toBe(!!previous&&projectManualProspect(previous)!==null);
 return key;
}
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();expect((await runtime.query('SELECT current_user')).rows).toEqual([{current_user:'app_runtime'}]);});
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM evidence_items');await db.session.query('DELETE FROM audit_events WHERE action=$1',[MANUAL_SOURCE_LOSS_ACTION]);});
afterAll(async()=>{await db?.drop();});
it('preserves standalone source-key bytes for ordinary, discovery and nonwinning duplicates',async()=>{
 const a=await ordinary(),b=await discovery(),duplicate=await discovery();
 await runtime.query("UPDATE sourcing_candidates SET payload=jsonb_set(payload,'{row,firmName}',to_jsonb('Same company'::text)),created_at=statement_timestamp()-interval '1 minute' WHERE id=ANY($1::uuid[])",[[b.id,duplicate.id]]);
 await runtime.query('UPDATE sourcing_candidates SET created_at=statement_timestamp() WHERE id=$1',[duplicate.id]);
 for(const f of [a,b,duplicate])expect(await parity(f.id)).toMatch(/^[a-f0-9]{64}$/u);
 expect(await parity(a.id,2)).toBeNull();expect(await parity(a.id,1,'beta')).toBeNull();
});
it.each(['identity','notices','metadata'] as const)('hashes SQL-permitted nonprojectable discovery: %s',async mode=>{
 const f=await discovery();
 if(mode==='identity')await db.session.query("UPDATE sourcing_candidate_discovery_origins SET source=jsonb_set(source,'{retrievedAt}',to_jsonb('2026-10-01T00:00:00Z'::text)) WHERE candidate_id=$1",[f.id]);
 if(mode==='notices')await db.session.query("UPDATE sourcing_candidate_discovery_origins SET notices=jsonb_set(notices,'{0,label}',to_jsonb($2::text)) WHERE candidate_id=$1",[f.id,'x'.repeat(301)]);
 if(mode==='metadata')await db.session.query("UPDATE sourcing_candidate_discovery_origins SET source_metadata=jsonb_build_object('sourcesJson','not-json') WHERE candidate_id=$1",[f.id]);
 expect(await manualActivityRaw(ctx(),f.id,1)).toBe(false);expect(await parity(f.id)).toMatch(/^[a-f0-9]{64}$/u);
});
it('preserves SQL NULL versus JSON null and PostgreSQL JSONB canonical text',async()=>{
 const f=await ordinary(),sqlNull=await parity(f.id);expect(sqlNull).not.toBeNull();
 await runtime.query("UPDATE sourcing_candidates SET source_check='{\"state\":null}'::jsonb WHERE id=$1",[f.id]);
 const jsonNull=await parity(f.id);expect(jsonNull).not.toBe(sqlNull);
 await runtime.query("UPDATE sourcing_candidates SET source_check='{\"z\":2,\"state\":null,\"a\":1}'::jsonb WHERE id=$1",[f.id]);const first=await parity(f.id);
 await runtime.query("UPDATE sourcing_candidates SET source_check='{ \"a\" : 1, \"state\" : null, \"z\" : 2 }'::jsonb WHERE id=$1",[f.id]);expect(await parity(f.id)).toBe(first);
 await runtime.query('UPDATE sourcing_candidates SET source_check=NULL WHERE id=$1',[f.id]);expect(await parity(f.id)).toBe(sqlNull);
});
it('retains the global dismissed-candidate source-loss veto and does not cache recovery',async()=>{
 const target=await ordinary(),other=await ordinary();expect(await parity(target.id)).not.toBeNull();
 await runtime.query(`UPDATE sourcing_candidates SET payload=jsonb_set(payload,'{sourceUrl}',to_jsonb($2::text)),status='dismissed',source_check='{"state":"unavailable","reason":"source_not_permitted"}' WHERE id=$1`,[other.id,target.input.sourceUrl+'/']);
 expect(await parity(target.id)).toBeNull();await runtime.query('DELETE FROM sourcing_candidates WHERE id=$1',[other.id]);expect(await parity(target.id)).not.toBeNull();
});
it('rechecks changed revision and source identity after authority waits',async()=>{
 const f=await ordinary(),before=await prioritySourceKey(ctx(),f.id,1);
 await currentManualActivityAuthority(ctx(),f.id,1,async()=>{await runtime.query('SELECT pg_sleep(0.01)');await runtime.query("UPDATE sourcing_candidates SET source_check='{\"state\":\"available\",\"lastSuccess\":{\"contentHash\":\"changed\"}}' WHERE id=$1",[f.id]);return true;});
 expect(await prioritySourceKey(ctx(),f.id,1)).not.toBe(before);
 await expect(currentManualActivityAuthority(ctx(),f.id,1,async()=>{await runtime.query('SELECT pg_sleep(0.01)');await runtime.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE id=$1',[f.id]);return true;})).rejects.toThrow('candidate_unavailable');
 expect(await parity(f.id)).toBeNull();
});
it('uses fresh source-retention clock after an authority wait',async()=>{
 const f=await ordinary();const firm=(await runtime.query<{id:string}>('INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,$2,$3) RETURNING id',[seed.alpha.workspaceId,'Synthetic source',seed.alpha.admin.userId])).rows[0]!.id;
 await runtime.query("INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at) VALUES($1,$2,'website',$3,$4,true,clock_timestamp()+interval '200 milliseconds')",[seed.alpha.workspaceId,firm,f.input.sourceUrl,'a'.repeat(64)]);
 expect(await prioritySourceKey(ctx(),f.id,1)).not.toBeNull();
 await expect(currentManualActivityAuthority(ctx(),f.id,1,async()=>{await runtime.query('SELECT pg_sleep(0.25)');return true;})).rejects.toThrow('candidate_unavailable');
 expect(await parity(f.id)).toBeNull();
});
