import {describe,expect,it} from 'vitest';
import {callingSubjectSchema,callingWrapCommandSchema,callingFollowUpContentSchema,
 callingFollowUpSaveCommandSchema,callingFollowUpListSchema,callingFollowUpReadSchema,
 callingReceiptInputSchema,callingReceiptSchema,callingWrapResultSchema} from '../src/calling.ts';
const id='b385612c-cac8-43a3-a72d-fc2dd7d8553d';
const envelope={commandId:id,clientVersion:'1.0.0'};
const promisedEmail={draftId:id,nextAction:'promised_email',subject:'The outline we discussed',body:'An editable private outline.'};
const raw={kind:'candidate',candidateId:id,expectedCandidateRevision:1,attemptId:id,...envelope,
 report:{performedByUser:true,channel:'manual_phone',occurrence:{kind:'unknown'},result:'conversation',note:null,callback:null}};
const canonical={kind:'firm',firmId:id,...envelope,report:{performedByUser:true,outcome:'interested'}};
const at='2026-10-26T00:00:00.000Z';
const metadata={draftId:id,revision:1,source:{kind:'firm',firmId:id,callLogId:id},availability:'available',createdAt:at,updatedAt:at};
describe('Calling private follow-up contracts',()=>{
 it('keeps exact candidate and Firm selections disjoint',()=>{
  expect(callingSubjectSchema.safeParse({kind:'candidate',candidateId:id,expectedCandidateRevision:1}).success).toBe(true);
  expect(callingSubjectSchema.safeParse({kind:'firm',firmId:id}).success).toBe(true);
  expect(callingSubjectSchema.safeParse({kind:'candidate',candidateId:id,expectedCandidateRevision:1,firmId:id}).success).toBe(false);
  expect(callingSubjectSchema.safeParse({kind:'firm',firmId:id,candidateId:id}).success).toBe(false);
 });
 it('accepts explicit report with independent promised preparation',()=>{
  for(const value of [raw,canonical]){
   expect(callingWrapCommandSchema.safeParse(value).success).toBe(true);
   expect(callingWrapCommandSchema.safeParse({...value,promisedEmail}).success).toBe(true);
   expect(callingWrapCommandSchema.safeParse({...value,report:{...value.report,performedByUser:false}}).success).toBe(false);
  }
 });
 it('does not fabricate promises from unanswered calls or unknown reports',()=>{
  for(const result of ['unknown','no_answer','busy','voicemail_left','wrong_number','do_not_call','technical_failure']){
   const value={...raw,report:{...raw.report,result}};
   expect(callingWrapCommandSchema.safeParse(value).success).toBe(true);
   expect(callingWrapCommandSchema.safeParse({...value,promisedEmail}).success).toBe(false);
  }
  for(const outcome of ['no_answer','busy','voicemail_left','wrong_number','do_not_call','policy_or_technical_failure'])
   expect(callingWrapCommandSchema.safeParse({...canonical,report:{...canonical.report,outcome},promisedEmail}).success).toBe(false);
 });
 it('preserves reached-not-interested without claiming buying interest or consent',()=>{
  expect(callingWrapCommandSchema.safeParse({...canonical,report:{...canonical.report,outcome:'not_interested'},promisedEmail}).success).toBe(true);
  expect(callingWrapCommandSchema.safeParse({...raw,report:{...raw.report,result:'not_interested'},promisedEmail}).success).toBe(true);
 });
 it('rejects inferred identity, activation, legacy consent and reservation fields',()=>{
  for(const field of ['followUpPermission','ticketId','phoneHandoffAttemptId','commandId','firmId'])
   expect(callingWrapCommandSchema.safeParse({...canonical,report:{...canonical.report,[field]:id}}).success).toBe(false);
  for(const field of ['recipient','emailRouteId','send','approved','templateVersionId','note'])
   expect(callingWrapCommandSchema.safeParse({...canonical,promisedEmail:{...promisedEmail,[field]:id}}).success).toBe(false);
 });
 it('bounds nonblank content and keeps withdrawal body-free with revision CAS',()=>{
  expect(callingFollowUpContentSchema.safeParse({subject:'a'.repeat(160),body:'b'.repeat(4000)}).success).toBe(true);
  for(const content of [{subject:' ',body:'x'},{subject:'a'.repeat(161),body:'x'},{subject:'a',body:'b'.repeat(4001)}])
   expect(callingFollowUpContentSchema.safeParse(content).success).toBe(false);
  const save={operation:'withdraw',draftId:id,expectedRevision:1,...envelope};
  expect(callingFollowUpSaveCommandSchema.safeParse(save).success).toBe(true);
  expect(callingFollowUpSaveCommandSchema.safeParse({...save,body:'private'}).success).toBe(false);
  expect(callingFollowUpSaveCommandSchema.safeParse({...save,expectedRevision:0}).success).toBe(false);
 });
 it('keeps list bounded and content-free and current content explicitly unsent',()=>{
  expect(callingFollowUpListSchema.safeParse({drafts:[metadata],nextAfterId:null}).success).toBe(true);
  expect(callingFollowUpListSchema.safeParse({drafts:Array(21).fill(metadata),nextAfterId:null}).success).toBe(false);
  expect(callingFollowUpListSchema.safeParse({drafts:[{...metadata,subject:'private'}],nextAfterId:null}).success).toBe(false);
  const draft={...metadata,content:{subject:'hello',body:'private'},state:'queued_for_review',recipient:'unresolved',sendAuthority:'not_granted'};
  expect(callingFollowUpReadSchema.safeParse({draft}).success).toBe(true);
  expect(callingFollowUpReadSchema.safeParse({draft:{...draft,availability:'withdrawn'}}).success).toBe(false);
  expect(callingFollowUpReadSchema.safeParse({draft:{...draft,sendAuthority:'granted'}}).success).toBe(false);
 });
 it('keeps acceptance opaque and explicit failed follow-up distinct from queued',()=>{
  const result={kind:'firm',firmId:id,callLogId:id,staleIntroductions:'not_confirmed',attention:['effects_not_applied'],followUp:{state:'not_queued',reason:'effects_not_applied'}};
  expect(callingWrapResultSchema.safeParse(result).success).toBe(true);
  expect(callingReceiptSchema.safeParse({state:'accepted',acceptance:{operation:'wrap',result}}).success).toBe(true);
  expect(callingReceiptSchema.safeParse({state:'accepted',acceptance:{operation:'wrap',result:{...result,note:'private'}}}).success).toBe(false);
  expect(callingReceiptInputSchema.safeParse({operation:'wrap',commandId:id,payloadSHA256:'a'.repeat(64)}).success).toBe(true);
  expect(callingReceiptInputSchema.safeParse({operation:'send',commandId:id,payloadSHA256:'a'.repeat(64)}).success).toBe(false);
 });
});
