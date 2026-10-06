import type {NormalizedMetadata} from '../../mail/messages.ts';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestQualification,finishQualification} from '../../sourcing/qualificationStore.ts';
import {evaluateQualification} from '../../sourcing/qualificationDecision.ts';
import {assessEmailCandidate} from '../../outreach/selection.ts';
import {recordStatePosture} from '../../policy/postures.ts';
import {POSTURE_STATEMENTS} from '../../src/rules/statePosture.ts';
let db:TestDatabase;let seeded:TwoWorkspaces;
const ctx=()=>repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),db.session);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
beforeAll(async()=>{db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);await tx(()=>recordStatePosture(ctx(),{state:'TX',effectiveFrom:new Date(Date.now()-60000).toISOString(),confirmedStatements:Object.keys(POSTURE_STATEMENTS)}));});
afterAll(async()=>db.drop());
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM sourcing_discovery_settings');await db.session.query('DELETE FROM daily_counters');});
let phoneSerial=100;
async function qualified(name:string,options:{locality?:string;website?:string;need?:string;phone?:string}={}){
 const locality=options.locality??'Dallas',website=options.website??`https://${name.toLowerCase().replaceAll(' ','')}.example.test/`;
 const candidate=await tx(()=>saveCandidate(ctx(),{firmName:name,website,locality,region:'TX',signal:'fit_only',evidence:'Maintenance work',sourceUrl:website,observedOn:'2026-10-01',preparedBy:'Fixture'}));if(!candidate.ok)throw new Error(candidate.reason);
 const request=await tx(()=>requestQualification(ctx(),{candidateId:candidate.value.id,expectedRevision:1}));if(!request.ok)throw new Error(request.reason);
 const id=randomUUID(),date=new Date().toISOString().slice(0,10);
 const blocks=[{id:'firm',text:`${name} is a residential property management company in ${locality}, Texas.`},{id:'phone',text:`Contact ${name} at ${options.phone??`(214) 555-${String(phoneSerial++).padStart(4,'0')}`}.`},{id:'email',text:`${name} ${locality} TX office info@${new URL(website).hostname}`},{id:'need',text:options.need??'Our team is overwhelmed by maintenance calls.'},{id:'date',text:`Published ${date}`}];
 const facts=[['firm_identity','firm'],['residential_management','firm'],['service_area','firm'],['business_phone','phone'],['business_email','email'],['operational_burden','need']].map(([kind,blockId])=>({kind,blockId,observationId:id,value:blocks.find(b=>b.id===blockId)!.text}));
 const finished=await tx(()=>finishQualification(ctx(),{runId:request.value.runId,reason:null,observations:[{id,url:website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:new Date().toISOString(),publishedAt:`${date}T00:00:00Z`,publishedAtBlockId:'date',firstParty:true,truncated:false,blocks}],facts}));if(!finished.ok)throw new Error(finished.reason);
 await tx(()=>evaluateQualification(ctx(),{runId:request.value.runId}));
 return {candidateId:candidate.value.id,expectedRevision:1,qualificationRunId:request.value.runId,mode:'reviewed' as const};
}

it('assesses sourced email without requiring a phone and preserves fit-only review',async()=>{
 const input=await qualified('Email PM',{phone:'not supplied',need:'We provide maintenance service.'});
 const assessed=await assessEmailCandidate(ctx(),input);
 expect(assessed).toMatchObject({ok:true,value:{firmId:null,lane:'email_first',rank:'fit_only',reviewRequired:true,route:{identityKind:'role',address:'info@emailpm.example.test'}}});
 expect((await db.session.query('SELECT id FROM firms')).rows).toHaveLength(0);
});
it('selects call-first for explicit burden plus a callable route, and rejects stale or ambiguous evidence',async()=>{
 const input=await qualified('Burden PM');
 expect(await assessEmailCandidate(ctx(),input)).toMatchObject({ok:true,value:{lane:'call_first',rank:'operational_burden',reviewRequired:false}});
 await db.session.query("UPDATE sourcing_candidates SET revision=revision+1 WHERE id=$1",[input.candidateId]);
 expect(await assessEmailCandidate(ctx(),input)).toEqual({ok:false,reason:'candidate_changed'});
});
it('admits an email-only candidate as a sourced office contact without a deal or sequence',async()=>{
 const {admitEmailCandidate}=await import('../../outreach/emailAdmission.ts');
 const input=await qualified('Office PM',{phone:'not supplied',need:'We manage residential homes.'});
 const create={...input,expectedOwnerUserId:seeded.alpha.admin.userId,reviewed:true};
 const result=await tx(()=>admitEmailCandidate(ctx(),create));expect(result).toMatchObject({ok:true,value:{identityKind:'role',alreadyAdmitted:false}});if(!result.ok)throw new Error(result.reason);
 expect(await tx(()=>admitEmailCandidate(ctx(),create))).toMatchObject({ok:true,value:{firmId:result.value.firmId,contactId:result.value.contactId,alreadyAdmitted:true}});
 expect((await db.session.query('SELECT full_name,title FROM contacts WHERE id=$1',[result.value.contactId])).rows[0]).toMatchObject({full_name:'Office',title:'Office mailbox'});
 for(const table of ['opportunities','sequence_enrollments','phone_routes'])expect((await db.session.query(`SELECT id FROM ${table} WHERE firm_id=$1`,[result.value.firmId])).rows).toHaveLength(0);
 const {readFirmSourcing}=await import('../../sourcing/attribution.ts');expect((await readFirmSourcing(ctx(),result.value.firmId))?.sources[0]).toMatchObject({hypothesis:'fit_only',acquisition:'cold_sourced',sourceAvailable:true});
});
it('does not admit unreviewed fit-only evidence and commits no partial CRM rows',async()=>{
 const {admitEmailCandidate}=await import('../../outreach/emailAdmission.ts');const input=await qualified('Unreviewed PM',{phone:'unknown',need:'We provide maintenance.'});
 expect(await tx(()=>admitEmailCandidate(ctx(),{...input,expectedOwnerUserId:seeded.alpha.admin.userId,reviewed:false}))).toEqual({ok:false,reason:'qualification_requires_review'});
 expect((await db.session.query("SELECT id FROM firms WHERE name='Unreviewed PM'")).rows).toHaveLength(0);
});
it('keeps email source history on firm merge, hides wrong-identity attribution, and deletes contact associations',async()=>{
 const {admitEmailCandidate}=await import('../../outreach/emailAdmission.ts');const {createFirm}=await import('../../crm/firms.ts');const {mergeFirms}=await import('../../crm/merges.ts');
 const {recordingSuppressionJournal}=await import('../../suppression/journal.ts');const {recordSourcingFeedback}=await import('../../sourcing/feedback.ts');const {readFirmSourcing}=await import('../../sourcing/attribution.ts');
 const {previewDeletion,commitDeletion}=await import('../../retention/deletion.ts');
 const input=await qualified('Merge Email PM',{phone:'unknown'});const admitted=await tx(()=>admitEmailCandidate(ctx(),{...input,reviewed:true,expectedOwnerUserId:seeded.alpha.admin.userId}));if(!admitted.ok)throw new Error(admitted.reason);
 const target=await tx(()=>createFirm(ctx(),{name:'Surviving email firm',assignedUserId:seeded.alpha.admin.userId}));if(!target.ok)throw new Error(target.reason);
 expect((await tx(()=>mergeFirms(ctx(),{sourceFirmId:admitted.value.firmId,targetFirmId:target.value.id,journal:recordingSuppressionJournal()}))).ok).toBe(true);
 expect((await readFirmSourcing(ctx(),target.value.id))?.sources[0]).toMatchObject({sourceAvailable:true});
 expect((await tx(()=>recordSourcingFeedback(ctx(),{candidateId:input.candidateId,qualificationRunId:input.qualificationRunId,code:'wrong_firm'}))).ok).toBe(true);
 expect((await readFirmSourcing(ctx(),target.value.id))?.sources[0]).toMatchObject({sourceAvailable:false});
 const preview=await tx(()=>previewDeletion(ctx(),{targetKind:'contact',firmId:target.value.id,contactId:admitted.value.contactId}));if(!preview.ok)throw new Error(preview.reason);
 const deleted=await tx(()=>commitDeletion(ctx(),{requestId:preview.value.requestId,previewHash:preview.value.previewHash,commandId:randomUUID(),journal:recordingSuppressionJournal()}));expect(deleted.ok).toBe(true);
 expect((await db.session.query('SELECT * FROM outreach_email_sources WHERE workspace_id=$1 AND contact_id=$2',[seeded.alpha.workspaceId,admitted.value.contactId])).rows).toHaveLength(0);
});
it('serializes email admission without duplicate contacts or a second prospect at the same firm',async()=>{
 const {admitEmailCandidate}=await import('../../outreach/emailAdmission.ts');const input=await qualified('Concurrent Email PM',{phone:'unknown'});const command={...input,reviewed:true,expectedOwnerUserId:seeded.alpha.admin.userId};
 const session=await db.appRuntimeSession();const second=repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),session);
 const results=await Promise.all([tx(()=>admitEmailCandidate(ctx(),command)),withTransaction(session,()=>admitEmailCandidate(second,command))]);expect(results.every(r=>r.ok)).toBe(true);expect(results.filter(r=>r.ok&&r.value.alreadyAdmitted)).toHaveLength(1);
});
it('enrolls a firm-owned plan without creating an opportunity, preserving its authority on reads',async()=>{
 const {admitEmailCandidate}=await import('../../outreach/emailAdmission.ts');const {createOutreachPlan}=await import('../../outreach/plans.ts');
 const {enrollContact}=await import('../../sequences/enrollments.ts');const {readEnrollment}=await import('../../sequences/rows.ts');const {seedSequences}=await import('../sequences/support/sequenceFixtures.ts');const {setProspectingAuthorization}=await import('../../outreach/authorization.ts');
 const input=await qualified('Firm Owned PM',{phone:'unknown'});const admitted=await tx(()=>admitEmailCandidate(ctx(),{...input,reviewed:true,expectedOwnerUserId:seeded.alpha.admin.userId}));if(!admitted.ok)throw new Error(admitted.reason);
 const mailbox=(await db.session.query<{id:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'owner@example.test','fixture-owner','connected') RETURNING id",[seeded.alpha.workspaceId,seeded.alpha.admin.userId])).rows[0]!.id;
 await tx(()=>setProspectingAuthorization(ctx(),{mailboxId:mailbox,expectedRevision:0,enabled:true,basis:'owner_reported_google_permission'}));
 const plan=await tx(()=>createOutreachPlan(ctx(),{firmId:admitted.value.firmId,contactId:admitted.value.contactId,mailboxId:mailbox,lane:'email_first',qualificationRunId:input.qualificationRunId,expectedOwnerUserId:seeded.alpha.admin.userId}));expect(plan.ok).toBe(true);if(!plan.ok)throw new Error(plan.reason);
 const sequences=await seedSequences(db.session,seeded);
 const enrollment=await tx(()=>enrollContact(ctx(),{originKind:'prospecting',sequenceVersionId:sequences.alpha.publishedVersionId,subject:{kind:'outreach',outreachPlanId:plan.value.id},firmId:admitted.value.firmId,contactId:admitted.value.contactId}));expect(enrollment.ok).toBe(true);if(!enrollment.ok)throw new Error(enrollment.reason);
 expect(await readEnrollment(ctx(),{enrollmentId:enrollment.value.enrollmentId})).toMatchObject({opportunityId:null,outreachPlanId:plan.value.id});
 const {findMatchCandidates}=await import('../../mail/matching.ts');
 const metadata:NormalizedMetadata={providerMessageId:'reply-1',providerThreadId:'thread-1',rfcMessageId:'reply@example.test',direction:'incoming',internalDate:new Date().toISOString(),headerFrom:'info@firmownedpm.example.test',headerTo:['owner@example.test'],headerCc:[],subject:'Re: Maintenance',referenceMessageIds:[],inReplyTo:null,autoSubmitted:null,listId:null,labelIds:[],attachments:[]};
 const {recordMessage}=await import('../../mail/messages.ts');
 const recorded=await tx(()=>recordMessage(ctx(),{mailboxId:mailbox,metadata}));
 const matches=await findMatchCandidates(ctx(),{mailboxId:mailbox,messageId:recorded.message.id,metadata});
 expect(matches).toMatchObject([{firmId:admitted.value.firmId,opportunityId:null,outreachPlanId:plan.value.id,rule:'participant'}]);
 expect((await db.session.query('SELECT id FROM opportunities WHERE firm_id=$1',[admitted.value.firmId])).rows).toHaveLength(0);
 const duplicate=await tx(()=>createOutreachPlan(ctx(),{firmId:admitted.value.firmId,contactId:admitted.value.contactId,mailboxId:mailbox,lane:'email_first',qualificationRunId:input.qualificationRunId,expectedOwnerUserId:seeded.alpha.admin.userId}));expect(duplicate.ok).toBe(false);
 const {recordMatches}=await import('../../mail/matching.ts');
 await tx(()=>recordMatches(ctx(),{messageId:recorded.message.id,candidates:matches}));
 const {applyClassificationEffects,recordDeterministicClassification}=await import('../../mail/effects.ts');
 const {recordingSuppressionJournal}=await import('../../suppression/journal.ts');const {recordingReplyPromoter}=await import('../../mail/replyLane.ts');
 const classification={messageId:recorded.message.id,class:'uncertain' as const,suggestedDisposition:null,signals:[],requiresConfirmation:true};
 await tx(async()=>{await recordDeterministicClassification(ctx(),{messageId:recorded.message.id,classification});await applyClassificationEffects(ctx(),{message:recorded.message,classification,candidates:matches,journal:recordingSuppressionJournal(),replyPromoter:recordingReplyPromoter()});});
 const {readReplyCard}=await import('../../classification/cards.ts');
 expect(await readReplyCard(ctx(),{messageId:recorded.message.id})).toMatchObject({firmId:admitted.value.firmId,opportunityId:null,outreachPlanId:plan.value.id,nextAction:'confirm_disposition',impact:{holds:[{opportunityId:null,reasonCode:'uncertain_reply'}]}});
 expect((await db.session.query('SELECT state FROM outreach_plans WHERE id=$1',[plan.value.id])).rows[0]).toEqual({state:'reply_pending'});
 const {confirmReplyDisposition}=await import('../../classification/confirmations.ts');
 expect(await tx(()=>confirmReplyDisposition(ctx(),{messageId:recorded.message.id,disposition:'interested',grantFollowUp:false,journal:recordingSuppressionJournal()}))).toMatchObject({ok:true,value:{confirmation:{opportunityId:null,outreachPlanId:plan.value.id,consequences:expect.arrayContaining(['outreach_manual'])}}});
 expect(await readReplyCard(ctx(),{messageId:recorded.message.id})).toMatchObject({impact:{controlMode:'manual'},nextAction:'nothing_to_do'});
 const {createFirm}=await import('../../crm/firms.ts');const {mergeFirms}=await import('../../crm/merges.ts');
 const target=await tx(()=>createFirm(ctx(),{name:'Surviving outreach firm',assignedUserId:seeded.alpha.admin.userId}));if(!target.ok)throw new Error(target.reason);
 expect(await tx(()=>mergeFirms(ctx(),{sourceFirmId:admitted.value.firmId,targetFirmId:target.value.id,journal:recordingSuppressionJournal()}))).toMatchObject({ok:true});
 expect((await db.session.query('SELECT firm_id,state FROM outreach_plans WHERE id=$1',[plan.value.id])).rows[0]).toEqual({firm_id:target.value.id,state:'stopped'});
 expect(await readReplyCard(ctx(),{messageId:recorded.message.id})).toMatchObject({firmId:target.value.id,opportunityId:null});


});
