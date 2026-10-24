import assert from 'node:assert/strict';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {saveDiscoveryCandidate} from '@fss/domain/sourcing/discoveryIntake.ts';
import {manualDiscoveryFixture,manualOrdinaryFixture} from '../../../../packages/domain/test/sourcing/support/manualProspectFixture.ts';
import {manualPhoneFixture,seedManualPhoneRun} from '../../../../packages/domain/test/sourcing/support/manualPhoneFixture.ts';
import type {ManualProspectApp} from './manualProspectApp.ts';
export async function seedCompactManualProspects(app:ManualProspectApp){
 const f=app.fixture,w=f.alpha.workspaceId,runtime=await f.database.appRuntimeSession(),ctx=repositoryContext(workspaceScope(w,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),runtime);
 async function discovery(key:string,name=`Unresolved retained ${key}`){const input=manualDiscoveryFixture(`compact-${key}`);input.row.firmName=name;const saved=await withTransaction(runtime,()=>saveDiscoveryCandidate(ctx,input));assert(saved.ok);return {id:saved.value.id,input};}
 for(let i=0;i<47;i++)await discovery(`page-${i}`);
 const memberA=await discovery('member-a','Home | Boston Property Management - Contact'),memberB=await discovery('member-b','Boston Property Management | Services');
 for(const member of [memberA,memberB])await f.db.query(`UPDATE sourcing_candidates SET payload=jsonb_set(jsonb_set(jsonb_set(payload,'{row,website}','"https://boston.example.test/"'),'{row,locality}','"Boston"'),'{row,region}','"MA"') WHERE id=$1`,[member.id]);
 const nonCompany=await discovery('certificate','Property Management Certificate'),unsafe=await discovery('hostile','<img src=x onerror=alert(1)> Retained raw title');
 await f.db.query(`UPDATE sourcing_candidates SET payload=jsonb_set(payload,'{row,website}','"javascript:alert(1)"') WHERE id=$1`,[unsafe.id]);
 const absent=await discovery('absent'),conflicting=await discovery('conflicting');
 await f.db.query(`UPDATE sourcing_candidates SET payload=jsonb_set(payload,'{row,officePhoneEvidence}','"absent"') WHERE id=$1`,[absent.id]);
 await seedManualPhoneRun(f.db,w,conflicting.id,manualPhoneFixture(conflicting.input.row.source.sourceUrl,['2145550123','2145550124']));
 const ordinary=manualOrdinaryFixture(767),saved=await withTransaction(runtime,()=>saveCandidate(ctx,ordinary));assert(saved.ok);
 const observedEvidence=manualPhoneFixture('https://phone-source.example.test/contact'),observedRun=await seedManualPhoneRun(f.db,w,saved.value.id,observedEvidence);
 const firm=(await f.db.query<{id:string}>(`INSERT INTO firms(workspace_id,name,assigned_user_id,website,locality,region_code,postal_code,time_zone,time_zone_confidence,time_zone_source,time_zone_rule_version)
 VALUES($1,'Synthetic retained source owner',$2,'https://retained-owner.example.test/','Boston','MA','02108','America/New_York','medium','state_default','firm-zone.1') RETURNING id`,[w,f.alpha.admin.userId])).rows[0]!;
 const source=observedEvidence.observations[0]!;
 await f.db.query(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,retrieved_at) VALUES($1,$2,'website',$3,$4,$5)`,[w,firm.id,source.url,source.contentHash,source.retrievedAt]);
 return {memberA,memberB,nonCompany,unsafe,absent,conflicting,observedId:saved.value.id,observedRun,source};
}
