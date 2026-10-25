import {describe,expect,it} from 'vitest';
import {
 manualProspectActivityContentSchema,manualProspectActivitySaveCommandSchema,
 manualProspectActivityListSchema,manualProspectActivityReadSchema,
 manualProspectActivityReceiptSchema,manualProspectCallbackTimingSchema,
} from '../src/manualProspectActivity.ts';
const id='b385612c-cac8-43a3-a72d-fc2dd7d8553d';
const at='2026-10-25T05:00:00.000Z';
const content={performedByUser:true,channel:'manual_phone',occurrence:{kind:'unknown'},
 result:'unknown',note:null,callback:null};
const metadata={candidateId:id,candidateRevision:1,attemptId:id,activityRevision:1,
 recordedAt:at,updatedAt:at};
const command={...content,operation:'create',candidateId:id,expectedCandidateRevision:1,
 attemptId:id,commandId:id,clientVersion:'1.0.0'};
describe('private user-reported manual activity boundary',()=>{
 it('allows explicit unknown occurrence and result, never inferred performance',()=>{
  expect(manualProspectActivitySaveCommandSchema.safeParse(command).success).toBe(true);
  for(const change of [{performedByUser:false},{performedByUser:undefined},
   {occurrence:{kind:'known'}},{channel:'automatic_call'},{qualification:'qualified'}])
   expect(manualProspectActivitySaveCommandSchema.safeParse({...command,...change}).success).toBe(false);
 });
 it('requires revision CAS only for updates and body-free withdrawal',()=>{
  expect(manualProspectActivitySaveCommandSchema.safeParse({...command,operation:'update',expectedActivityRevision:1}).success).toBe(true);
  expect(manualProspectActivitySaveCommandSchema.safeParse({...command,operation:'update'}).success).toBe(false);
  const withdrawal={operation:'withdraw',candidateId:id,expectedCandidateRevision:1,
   attemptId:id,expectedActivityRevision:2,commandId:id,clientVersion:'1.0.0'};
  expect(manualProspectActivitySaveCommandSchema.safeParse(withdrawal).success).toBe(true);
  expect(manualProspectActivitySaveCommandSchema.safeParse({...withdrawal,note:'retained'}).success).toBe(false);
  expect(manualProspectActivitySaveCommandSchema.safeParse({...command,expectedCandidateRevision:0}).success).toBe(false);
 });
 it('binds callback content exactly to callback_requested',()=>{
  const callback={note:null,timing:{kind:'unknown'}};
  expect(manualProspectActivityContentSchema.safeParse({...content,result:'callback_requested',callback}).success).toBe(true);
  expect(manualProspectActivityContentSchema.safeParse({...content,result:'callback_requested'}).success).toBe(false);
  expect(manualProspectActivityContentSchema.safeParse({...content,callback}).success).toBe(false);
  expect(manualProspectCallbackTimingSchema.safeParse({kind:'confirmed',localDate:'2026-10-26',
   localTime:'09:30',sourceTimeZone:'America/New_York',dueAt:'2026-10-26T13:30:00.000Z'}).success).toBe(true);
  expect(manualProspectCallbackTimingSchema.safeParse({kind:'unknown',dueAt:at}).success).toBe(false);
 });
 it('bounds current prose and rejects external activation fields',()=>{
  expect(manualProspectActivityContentSchema.safeParse({...content,note:'a'.repeat(1000)}).success).toBe(true);
  expect(manualProspectActivityContentSchema.safeParse({...content,note:'a'.repeat(1001)}).success).toBe(false);
  for(const field of ['send','dial','createCallback','consent','phone','firmId'])
   expect(manualProspectActivityContentSchema.safeParse({...content,[field]:true}).success).toBe(false);
 });
 it('keeps list and receipt projections content-free and bounded',()=>{
  const row={...metadata,availability:'available'};
  expect(manualProspectActivityListSchema.safeParse({activities:[row],nextAfterId:null}).success).toBe(true);
  expect(manualProspectActivityListSchema.safeParse({activities:[{...row,note:'private'}],nextAfterId:null}).success).toBe(false);
  expect(manualProspectActivityListSchema.safeParse({activities:Array(21).fill(row),nextAfterId:null}).success).toBe(false);
  const result={candidateId:id,candidateRevision:1,attemptId:id,activityRevision:1};
  expect(manualProspectActivityReceiptSchema.safeParse({state:'accepted',result}).success).toBe(true);
  expect(manualProspectActivityReceiptSchema.safeParse({state:'accepted',result:{...result,result:'conversation'}}).success).toBe(false);
  expect(manualProspectActivityReceiptSchema.safeParse({state:'unknown'}).success).toBe(true);
 });
 it('exposes prose only in current unverified view and never withdrawn content',()=>{
  const activity={...content,...metadata,availability:'available',qualification:'unverified',
   contactAuthority:'not_granted',reportBasis:'user_reported_unverified'};
  expect(manualProspectActivityReadSchema.safeParse({activity}).success).toBe(true);
  expect(manualProspectActivityReadSchema.safeParse({activity:{...activity,contactAuthority:'granted'}}).success).toBe(false);
  expect(manualProspectActivityReadSchema.safeParse({activity:{...metadata,availability:'withdrawn'}}).success).toBe(true);
  expect(manualProspectActivityReadSchema.safeParse({activity:{...metadata,availability:'withdrawn',note:'private'}}).success).toBe(false);
 });
});
