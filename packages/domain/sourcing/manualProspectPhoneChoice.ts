import {manualPhoneChoiceSchema,manualPhoneSchema,type ManualPhoneChoice} from '@fss/contracts';
import type {z} from 'zod';
import {canonicalizePhone} from '../src/rules/suppressionCanonicalization.ts';
import {isWholeManualPhoneLiteral} from './manualProspectLiteralPhone.ts';
import {projectProspectPhoneDiscovery} from './prospectPhoneDiscoveryProjection.ts';
import type {PhoneDiscoveryRun} from './prospectPhoneDiscoveryStore.ts';

/** Explicit human annotation, independent of parser selection and canonical routes. */
export function projectManualPhoneChoice(run:PhoneDiscoveryRun|undefined,raw:unknown,now:number):z.infer<typeof manualPhoneSchema>|null{
 const parsed=manualPhoneChoiceSchema.safeParse(raw);
 if(!parsed.success||!run||run.id!==parsed.data.runId||run.state!=='complete'||!run.content||run.expires_at.getTime()<=now)return null;
 const choice=parsed.data,evidence=projectProspectPhoneDiscovery(run,now);
 if(evidence.coverage?.state!=='complete'||!['observed','conflicting'].includes(evidence.state))return null;
 const observation=run.content.observations.find(v=>v.id===choice.observationId);
 const block=observation?.blocks.find(v=>v.id===choice.blockId);
 if(!observation||!block||observation.contentHash!==choice.contentHash||observation.relevantTextHash!==choice.relevantTextHash)return null;
 const location=(value:{runId:string;observationId:string;blockId:string;labelStart:number;labelEnd:number}):boolean=>value.runId===choice.runId&&value.observationId===choice.observationId&&value.blockId===choice.blockId&&value.labelStart===choice.labelStart&&value.labelEnd===choice.labelEnd;
 const supported=(evidence.state==='observed'||evidence.state==='conflicting')&&evidence.sources.some(v=>'method'in v&&location(v)&&v.start===choice.start&&v.end===choice.end&&v.normalizedValue!==null);
 const reviewed=evidence.state==='conflicting'&&evidence.diagnostics?.entries.some(v=>v.reason==='unattached_label_content'&&location(v));
 if(!supported&&!reviewed)return null;
 const label=block.text.slice(choice.labelStart,choice.labelEnd),gap=block.text.slice(choice.labelEnd,choice.start),literal=block.text.slice(choice.start,choice.end);
 if(!/^(?:office\s+phone|main\s+phone|telephone|phone|tel|call\s+us)$/iu.test(label)||gap.length>80||
  !/^\s*(?::|[.-])?\s*(?:today\s+)?(?:at\s*:?)?\s*$/iu.test(gap)||
  /\b(?:fax|mobile|personal|emergency|vendor|powered\s+by|website\s+by|testimonial|customer\s+review)\b/iu.test(block.text)||
  !/^[0-9+(). \t-]+$/u.test(literal)||!isWholeManualPhoneLiteral(block.text,choice.start,choice.end))return null;
 const normalized=canonicalizePhone(literal);
 if(!normalized.ok)return null;
 return manualPhoneSchema.parse({value:normalized.handle.value,choice,sourceUrl:observation.url,retrievedAt:observation.retrievedAt,expiresAt:run.expires_at.toISOString()});
}

/** Caller already obtained the current source snapshot with its principal/source locks. */
export function currentManualPhoneChoice(run:PhoneDiscoveryRun|undefined,choice:ManualPhoneChoice,now:number):ManualPhoneChoice|null{
 return projectManualPhoneChoice(run,choice,now)?.choice??null;
}
