import {z} from 'zod';
import {sourceObservationSchema} from './sourcingQualification.ts';

// Representation capacity only. Acquisition pages/bytes and aggregate retention
// remain independently bounded; whole blocks are never split or dropped to fit.
export const PROSPECT_PHONE_CAPTURE_LIMITS=Object.freeze({
 maxBlocks:256,maxBlockCharacters:16000,maxTextCharacters:50000,maxObservationBytes:100000,
});
export const prospectPhoneObservationSchema=sourceObservationSchema.safeExtend({
 publishedAt:z.null(),publishedAtBlockId:z.null(),firstParty:z.literal(true),truncated:z.literal(false),
 blocks:z.array(z.strictObject({id:z.string().min(1).max(80),text:z.string().min(1).max(PROSPECT_PHONE_CAPTURE_LIMITS.maxBlockCharacters)}))
  .min(1).max(PROSPECT_PHONE_CAPTURE_LIMITS.maxBlocks),
}).superRefine((value,ctx)=>{
 const length=value.blocks.reduce((sum,block)=>sum+block.text.length,0)+2*(value.blocks.length-1);
 if(length>PROSPECT_PHONE_CAPTURE_LIMITS.maxTextCharacters)
  ctx.addIssue({code:'custom',message:'Complete phone observation exceeds its text capacity.'});
});
export type ProspectPhoneObservation=z.infer<typeof prospectPhoneObservationSchema>;
