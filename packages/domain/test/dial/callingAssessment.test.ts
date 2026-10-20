import {randomUUID} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {ownerRiskFixture,riskEndpoint,type OwnerRiskFixture} from './phoneOwnerRiskFixtures.ts';
import {withTransaction} from '../../db/queryable.ts';
import {assessCallingOffice} from '../../sourcing/callingAdmission.ts';
import {CALLING_ASSESSMENT_ACTION} from '../../research/callingAssessmentStore.ts';
import {readPhoneOfficeProof} from '../../dial/phoneOfficeProof.ts';
import {readPhoneHandoffResult} from '../../dial/phoneHandoff.ts';
import {adviseDial} from '../../dial/advise.ts';
import {recordStatePosture} from '../../policy/postures.ts';
import {POSTURE_STATEMENTS} from '../../src/rules/statePosture.ts';
import {connection,pid,waitsOn} from './phoneOfficeRiskFixtures.ts';
import {runFirmResearch} from '../../research/enrichment.ts';
import {officeHtml,officeProviders} from '../support/officeProviders.ts';
let f:OwnerRiskFixture|undefined;
afterEach(async()=>{await f?.database.drop();f=undefined;});
async function fixture(){
 f=await ownerRiskFixture(false);const value=f;
 await value.database.session.query("UPDATE firms SET locality='Dallas',region_code='TX' WHERE id=$1",[value.crm.alpha.firmId]);
 await withTransaction(value.runtime,()=>recordStatePosture(value.context,{state:'TX',effectiveFrom:new Date(Date.now()-60000).toISOString(),confirmedStatements:Object.keys(POSTURE_STATEMENTS)}));
 await value.assess('<main><h1>Northwind Test Holdings</h1><p>We manage residential properties.</p><p>Dallas, TX</p><p>Office: (212) 555-0187</p></main>'.replace('We manage residential','Northwind Test Holdings manages residential'));
 const parent=(await value.database.session.query<{id:string}>('SELECT id FROM firm_office_assessments WHERE firm_id=$1',[value.crm.alpha.firmId])).rows[0]!;
 const before=(await value.database.session.query('SELECT * FROM firm_office_assessments WHERE id=$1',[parent.id])).rows[0];
 const assessed=await withTransaction(value.runtime,()=>assessCallingOffice(value.context,{firmId:value.crm.alpha.firmId,officeAssessmentId:parent.id}));
 expect(assessed,JSON.stringify(assessed)).toMatchObject({ok:true});if(!assessed.ok)throw new Error(assessed.reason);
 expect((await value.database.session.query('SELECT * FROM firm_office_assessments WHERE id=$1',[parent.id])).rows[0]).toEqual(before);
 return {value,parentId:parent.id,auditId:assessed.value.assessmentId};
}
const proof=(value:OwnerRiskFixture,id?:string)=>withTransaction(value.runtime,()=>readPhoneOfficeProof(value.context,{...value.request(),e164:riskEndpoint,at:new Date().toISOString(),...(id?{expected:{kind:'office_assessment' as const,id}}:{})}));
it('retains strict result independently, binds audit UUID through real advice, claim and publication',async()=>{
 const {value,parentId,auditId}=await fixture();expect(auditId).not.toBe(parentId);
 expect(await proof(value)).toMatchObject({kind:'office_assessment',id:auditId,callingPolicyVersion:'calling-first-party-tx-v1',auditEventId:auditId});
 expect((await adviseDial(value.context,value.request()))?.nationalDnc).toMatchObject({status:'not_checked_owner_risk',receiptId:value.receiptId});
 const again=await withTransaction(value.runtime,()=>assessCallingOffice(value.context,{firmId:value.crm.alpha.firmId,officeAssessmentId:parentId}));expect(again).toMatchObject({ok:true,value:{assessmentId:auditId}});
 const reserved=await value.reserve();expect(reserved,JSON.stringify(reserved)).toMatchObject({ok:true});if(!reserved.ok)throw new Error(reserved.reason);
 expect((await value.database.session.query('SELECT office_proof_id,office_proof_kind FROM phone_handoff_attempts WHERE id=$1',[reserved.value.attemptId])).rows[0]).toEqual({office_proof_id:auditId,office_proof_kind:'office_assessment'});
 expect(await readPhoneHandoffResult(value.context,reserved.value.attemptId,false)).toMatchObject({actionable:true});
 await value.database.session.query('DELETE FROM evidence_items WHERE workspace_id=$1',[value.w]);
 expect(await proof(value,auditId)).toBeNull();
 expect(await readPhoneHandoffResult(value.context,reserved.value.attemptId,false)).toMatchObject({actionable:false});
});
it.each([
 "UPDATE evidence_items SET retention_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",
 "UPDATE evidence_items SET terms_allow_retention=false,retention_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",
 "UPDATE firm_office_assessments SET expected_source_count=expected_source_count+1 WHERE workspace_id=$1",
 "UPDATE firm_office_assessments SET assessment_version='other-policy' WHERE workspace_id=$1",
 "UPDATE firm_office_assessment_sources SET observation=jsonb_set(observation,'{contentHash}',to_jsonb(repeat('d',64))) WHERE workspace_id=$1",
 "UPDATE firms SET name='Different identity' WHERE workspace_id=$1",
 "UPDATE phone_routes SET version=version+1 WHERE workspace_id=$1",
 "UPDATE phone_routes SET known_personal_cell_at=clock_timestamp() WHERE workspace_id=$1",
 "UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=(SELECT assigned_user_id FROM firms WHERE workspace_id=$1 AND name='Northwind Test Holdings')",
])('invalidates the exact calling event on source/safety drift: %s',async(sql)=>{
 const {value,auditId}=await fixture();await value.database.session.query(sql,[value.w]);expect(await proof(value,auditId)).toBeNull();expect((await value.reserve()).ok).toBe(false);
});
it.each(['wrong_action','wrong_version','wrong_parent','missing_selector'] as const)('never falls back from an expected malformed %s audit to legacy proof',async(kind)=>{
 const {value,auditId,parentId}=await fixture();
 const row=(await value.database.session.query<{detail:Record<string,unknown>}>('SELECT detail FROM audit_events WHERE id=$1',[auditId])).rows[0]!;
 const detail={...row.detail};if(kind==='wrong_version')detail['policyVersion']='other';if(kind==='wrong_parent')detail['parentId']=randomUUID();if(kind==='missing_selector')detail['audit']=[];
 const bad=(await value.database.session.query<{id:string}>("INSERT INTO audit_events(workspace_id,actor_kind,actor_user_id,action,subject_kind,subject_id,detail) VALUES($1,'user',$2,$3,'firm',$4,$5::jsonb) RETURNING id",[value.w,value.owner.userId,kind==='wrong_action'?'unrelated.action':CALLING_ASSESSMENT_ACTION,value.crm.alpha.firmId,JSON.stringify(detail)])).rows[0]!;
 expect(await proof(value,bad.id)).toBeNull();expect(await proof(value,parentId)).toBeNull();
});
it.each(['claim','publication'] as const)('revalidates exact calling sources after an actual %s lock wait',async(stage)=>{
 const {value}=await fixture();
 const initial=stage==='publication'?await value.reserve():null;
 if(initial&&!initial.ok)throw new Error(initial.reason);
 const blocker=await connection(value),waiter=await pid(value.runtime);
 await blocker.session.query('BEGIN');
 await blocker.session.query('SELECT id FROM evidence_items WHERE workspace_id=$1 FOR UPDATE',[value.w]);
 const pending=stage==='claim'?value.reserve():readPhoneHandoffResult(value.context,initial!.ok?initial!.value.attemptId:'',false);
 try{
  await waitsOn(value,waiter,blocker.pid);
  await blocker.session.query("UPDATE evidence_items SET terms_allow_retention=false,retention_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",[value.w]);
  await blocker.session.query('COMMIT');
  const result=await pending;
  expect(result).toMatchObject(stage==='claim'?{ok:false}:{actionable:false});
 }finally{await blocker.session.query('ROLLBACK');await pending;}
});
it('never substitutes calling evidence for the explicit uncovered-code owner receipt',async()=>{
 const {value}=await fixture();
 expect(await value.reserve({expectedNationalDncReceiptId:randomUUID()})).toMatchObject({ok:false});
 expect((await value.database.session.query('SELECT id FROM phone_handoff_attempts')).rows).toEqual([]);
});
it.each(['old_route','superseded_parent'] as const)('keeps independent current strict proof discoverable beside %s calling history',async(kind)=>{
 const {value,auditId}=await fixture();
 const routeVersion=kind==='old_route'?2:value.policy.alpha.phoneRouteVersion;
 if(kind==='old_route')await value.database.session.query('UPDATE phone_routes SET version=$2 WHERE id=$1',[value.policy.alpha.phoneRouteId,routeVersion]);
 const providers=officeProviders({html:officeHtml.replaceAll('Providence','Dallas').replaceAll('RI','TX').replace('02903','75201').replace('(401)','(212)')});
 const research=await runFirmResearch(value.context,{firmId:value.crm.alpha.firmId,revision:2,trigger:'user_request',requestedByUserId:value.owner.userId,purpose:'office_evidence',at:new Date().toISOString(),...providers});
 expect(research,JSON.stringify(research)).toMatchObject({ok:true});
 const strict=(await value.database.session.query<{id:string;result:string}>('SELECT id,result FROM firm_office_assessments WHERE firm_id=$1 ORDER BY captured_at DESC LIMIT 1',[value.crm.alpha.firmId])).rows[0]!;
 expect(strict.result).toBe('supported');expect(strict.id).not.toBe(auditId);
 const request={...value.request(),routeVersion};
 const read=(expected?:string)=>withTransaction(value.runtime,()=>readPhoneOfficeProof(value.context,{...request,e164:riskEndpoint,at:new Date().toISOString(),...(expected?{expected:{kind:'office_assessment' as const,id:expected}}:{})}));
 expect(await read(auditId)).toBeNull();
 expect(await read()).toEqual({kind:'office_assessment',id:strict.id,expiresAt:expect.any(String)});
 expect((await adviseDial(value.context,request))?.nationalDnc).toMatchObject({status:'not_checked_owner_risk',receiptId:value.receiptId});
 const reserved=await value.reserve({routeVersion});expect(reserved,JSON.stringify(reserved)).toMatchObject({ok:true});if(!reserved.ok)throw new Error(reserved.reason);
 expect((await value.database.session.query('SELECT office_proof_id FROM phone_handoff_attempts WHERE id=$1',[reserved.value.attemptId])).rows[0]).toEqual({office_proof_id:strict.id});
 expect(await readPhoneHandoffResult(value.context,reserved.value.attemptId,false)).toMatchObject({actionable:true});
 await value.database.session.query('UPDATE phone_routes SET known_personal_cell_at=clock_timestamp() WHERE id=$1',[value.policy.alpha.phoneRouteId]);
 expect(await read()).toBeNull();expect((await value.reserve({routeVersion})).ok).toBe(false);
});
