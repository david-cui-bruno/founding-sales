import {z} from 'zod';
import {uuid} from './foundationRows.ts';
import {manualLiteralPhoneDiagnosticSchema} from './manualLiteralPhone.ts';
import {PROSPECT_PHONE_CAPTURE_LIMITS} from './prospectPhoneObservation.ts';

export const PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH='/sourcing/candidates/phone-discovery/refusal-original/read' as const;
const offset=z.number().int().min(0).max(PROSPECT_PHONE_CAPTURE_LIMITS.maxBlockCharacters);
/** Selects one already-returned refusal location, never an arbitrary URL or a new capture. */
export const prospectPhoneRefusalOriginalInputSchema=z.strictObject({
 candidateId:uuid,expectedRevision:z.number().int().positive(),runId:uuid,observationId:uuid,
 blockId:z.string().min(1).max(80),labelStart:offset,labelEnd:offset,
 reason:z.enum(['unattached_label_content','unsupported_literal','ambiguous_context']),
}).superRefine((value,ctx)=>{
 if(value.labelEnd<=value.labelStart)ctx.addIssue({code:'custom',message:'A current refusal label span is required.'});
});
/** Explicit selected-view read only. Never included in list, receipt, command or browser storage. */
export const prospectPhoneRefusalOriginalSchema=z.strictObject({
 candidateId:uuid,candidateRevision:z.number().int().positive(),
 location:manualLiteralPhoneDiagnosticSchema,
 text:z.string().min(1).max(PROSPECT_PHONE_CAPTURE_LIMITS.maxBlockCharacters),
 purpose:z.literal('manual_refusal_review'),channelAuthority:z.literal('not_granted'),
}).superRefine((value,ctx)=>{
 const location=value.location;
 if(location.authority.kind!=='phone_discovery'||location.authority.runId!==location.runId||location.lineage.kind!=='provider_original')
  ctx.addIssue({code:'custom',message:'Only this discovery run\'s current provider original can be reviewed.'});
 if(value.text.slice(location.labelStart,location.labelEnd)!==location.label)
  ctx.addIssue({code:'custom',message:'The original must retain the exact diagnostic label span.'});
});
export type ProspectPhoneRefusalOriginalInput=z.infer<typeof prospectPhoneRefusalOriginalInputSchema>;
export type ProspectPhoneRefusalOriginal=z.infer<typeof prospectPhoneRefusalOriginalSchema>;
