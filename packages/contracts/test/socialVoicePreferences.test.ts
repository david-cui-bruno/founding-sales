import {describe,expect,it} from 'vitest';
import {socialVoiceEntriesSchema,socialVoiceGuideSchema,socialVoiceReadInputSchema,
 socialVoiceReceiptSchema,socialVoiceSaveCommandSchema,socialVoiceSaveInputSchema} from '../src/socialVoicePreferences.ts';
const id='513f8960-cc58-40ba-80ee-4ddae0d37da7';
const entry={entryId:id,dimension:'tone',guidance:'  Be direct and useful.\n'};
const create={operation:'create',entries:[entry]};
const current={guideId:id,revision:2,createdAt:'2026-10-25T03:40:00.000Z',updatedAt:'2026-10-25T03:41:00.000Z'};
describe('private explicitly curated voice guide',()=>{
 it('preserves exact style guidance without a platform or factual origin',()=>{
  expect(socialVoiceSaveInputSchema.parse(create)).toEqual(create);
  expect(socialVoiceReadInputSchema.parse({})).toEqual({});
 });
 it('rejects blank, oversized, duplicate and unbounded entries',()=>{
  for(const guidance of ['', ' \n','a'.repeat(501)])expect(socialVoiceEntriesSchema.safeParse([{...entry,guidance}]).success).toBe(false);
  expect(socialVoiceEntriesSchema.safeParse([]).success).toBe(false);
  expect(socialVoiceEntriesSchema.safeParse([entry,entry]).success).toBe(false);
  const entries=Array.from({length:21},(_,i)=>({...entry,entryId:`513f8960-cc58-40ba-80ee-${String(i).padStart(12,'0')}`}));
  expect(socialVoiceEntriesSchema.safeParse(entries).success).toBe(false);
  expect(socialVoiceEntriesSchema.safeParse(entries.slice(0,20).map(value=>({...value,guidance:'界'.repeat(500)}))).success).toBe(false);
 });
 it('rejects source, factual, publishing, identity and activation fields',()=>{
  for(const field of ['draftId','sourceId','factId','examples','accountId','publishAt','provider','workspaceId','ownerUserId','generate']){
   expect(socialVoiceSaveInputSchema.safeParse({...create,[field]:id}).success).toBe(false);
  }
  expect(socialVoiceSaveInputSchema.safeParse({...create,entries:[{...entry,before:'private original'}]}).success).toBe(false);
 });
 it('separately names update, physical removal and explicit restart with exact CAS',()=>{
  for(const operation of ['update','remove','restart']){
   const input={operation,guideId:id,expectedRevision:2,...(operation==='remove'?{}:{entries:[entry]})};
   expect(socialVoiceSaveInputSchema.safeParse(input).success).toBe(true);
   for(const expectedRevision of [undefined,0,-1])expect(socialVoiceSaveInputSchema.safeParse({...input,expectedRevision}).success).toBe(false);
  }
  expect(socialVoiceSaveInputSchema.safeParse({operation:'remove',guideId:id,expectedRevision:2,entries:[entry]}).success).toBe(false);
 });
 it('uses normal command identity and rejects undeclared actions',()=>{
  expect(socialVoiceSaveCommandSchema.safeParse({...create,commandId:id,clientVersion:'1.0.0'}).success).toBe(true);
  expect(socialVoiceSaveCommandSchema.safeParse({...create,operation:'train',commandId:id,clientVersion:'1.0.0'}).success).toBe(false);
 });
 it('never returns guidance in absent or removed projections',()=>{
  expect(socialVoiceGuideSchema.safeParse({state:'absent'}).success).toBe(true);
  expect(socialVoiceGuideSchema.safeParse({state:'available',...current,entries:[entry]}).success).toBe(true);
  const removed={state:'removed',...current,removedAt:current.updatedAt};
  expect(socialVoiceGuideSchema.safeParse(removed).success).toBe(true);
  expect(socialVoiceGuideSchema.safeParse({...removed,entries:[entry]}).success).toBe(false);
 });
 it('keeps receipts content-free and absent receipt unknown',()=>{
  const result={guideId:id,revision:3};
  expect(socialVoiceReceiptSchema.safeParse({state:'accepted',result}).success).toBe(true);
  expect(socialVoiceReceiptSchema.safeParse({state:'accepted',result:{...result,entries:[entry]}}).success).toBe(false);
  expect(socialVoiceReceiptSchema.safeParse({state:'unknown'}).success).toBe(true);
  expect(socialVoiceReceiptSchema.safeParse({state:'unknown',result}).success).toBe(false);
 });
});
