import {manualPhoneChoiceSchema,manualPhoneSchema,type ManualPhoneChoice,type ManualProspect} from '@fss/contracts';
import type {z} from 'zod';
import {canonicalizePhone} from '../src/rules/suppressionCanonicalization.ts';
import {V2_ONLY_PHONE_LABEL,isStandalonePublishedLiteral,isWholeManualPhoneLiteral,phoneBlockAllowsV2} from './manualProspectLiteralPhone.ts';
import {projectManualPhone,type ManualPhoneSnapshot} from './manualProspectPhone.ts';
import {preparedPhoneSource} from './preparedPhoneSource.ts';
import {projectProspectPhoneDiscovery} from './prospectPhoneDiscoveryProjection.ts';
import type {PhoneDiscoveryRun} from './prospectPhoneDiscoveryStore.ts';

type Evidence=NonNullable<ManualProspect['phoneEvidence']>;
type ManualPhone=z.infer<typeof manualPhoneSchema>;
/** One retained source for a choice: its exact pages/blocks, the evidence read from them and its own deadline. */
interface ChoiceSource {
 runId:string;evidence:Evidence;expiresAt:string;
 observations:readonly {id:string;url:string;retrievedAt:string;contentHash:string;relevantTextHash:string;blocks:readonly {id:string;text:string}[]}[];
}
/** Explicit human annotation, independent of parser selection and canonical routes. */
export function projectManualPhoneChoice(run:PhoneDiscoveryRun|undefined,raw:unknown,now:number):ManualPhone|null{
 const parsed=manualPhoneChoiceSchema.safeParse(raw);
 if(!parsed.success||!run||run.id!==parsed.data.runId||run.state!=='complete'||!run.content||run.expires_at.getTime()<=now)return null;
 return selectedPhone({runId:run.id,evidence:projectProspectPhoneDiscovery(run,now),expiresAt:run.expires_at.toISOString(),observations:run.content.observations},parsed.data);
}
/** A choice whose runId is the candidate's latest qualification run, read through the pages its
 * current prepared brief cites (ADR0034). Caller supplies a freshly locked, capture-wrapped snapshot. */
export function projectPreparedPhoneChoice(snapshot:ManualPhoneSnapshot|undefined,raw:unknown,now:number):ManualPhone|null{
 const parsed=manualPhoneChoiceSchema.safeParse(raw);
 if(!parsed.success||!snapshot||snapshot.id!==parsed.data.runId)return null;
 const prepared=preparedPhoneSource(snapshot,now),authority=prepared?.authorities[parsed.data.observationId];
 if(!prepared||authority?.kind!=='prepared_capture')return null;
 return selectedPhone({runId:snapshot.id,evidence:projectManualPhone(snapshot,now),expiresAt:authority.expiresAt,observations:prepared.observations},parsed.data);
}
function selectedPhone(source:ChoiceSource,choice:ManualPhoneChoice):ManualPhone|null{
 const evidence=source.evidence;
 if(!['complete','partial'].includes(evidence.coverage?.state??'')||!['observed','conflicting'].includes(evidence.state))return null;
 const observation=source.observations.find(v=>v.id===choice.observationId);
 const block=observation?.blocks.find(v=>v.id===choice.blockId);
 if(!observation||!block||observation.contentHash!==choice.contentHash||observation.relevantTextHash!==choice.relevantTextHash)return null;
 const location=(value:{runId:string;observationId:string;blockId:string;labelStart:number;labelEnd:number}):boolean=>value.runId===choice.runId&&value.observationId===choice.observationId&&value.blockId===choice.blockId&&value.labelStart===choice.labelStart&&value.labelEnd===choice.labelEnd;
 const supported=(evidence.state==='observed'||evidence.state==='conflicting')&&evidence.sources.some(v=>'method'in v&&location(v)&&v.start===choice.start&&v.end===choice.end&&v.normalizedValue!==null);
 const reviewed=evidence.state==='conflicting'&&evidence.diagnostics?.entries.some(v=>v.reason==='unattached_label_content'&&location(v));
 if(!supported&&!reviewed)return null;
 const label=block.text.slice(choice.labelStart,choice.labelEnd),gap=block.text.slice(choice.labelEnd,choice.start),literal=block.text.slice(choice.start,choice.end);
 // A standalone published number is its own label. Only the reviewed v2 grammar produces one, and never beside another line or purpose.
 const standalone=choice.labelStart===choice.start&&choice.labelEnd===choice.end;
 if(standalone&&(!supported||!phoneBlockAllowsV2(block.text)))return null;
 // v2 verb and phone-emoji labels are real spans before the literal.
 // Supported and reviewed-diagnostic paths alike: a v2-only label never attaches beside another line or purpose.
 if(V2_ONLY_PHONE_LABEL.test(label)&&!phoneBlockAllowsV2(block.text))return null;
 if(!standalone&&(!/^(?:office\s+phone|main\s+phone|telephone|phone|tel|call\s+us|please\s+call|call|📞|☎\uFE0F?)$/iu.test(label)||gap.length>80||
  !/^\s*(?::|[.-])?\s*(?:today\s+)?(?:at\s*:?)?\s*$/iu.test(gap))||
  /\b(?:fax|mobile|personal|emergency|vendor|powered\s+by|website\s+by|testimonial|customer\s+review)\b/iu.test(block.text)||
  !/^[0-9+(). \t-]+$/u.test(literal)||!(isWholeManualPhoneLiteral(block.text,choice.start,choice.end)||supported&&isStandalonePublishedLiteral(block.text,choice.start,choice.end)))return null;
 const normalized=canonicalizePhone(literal);
 if(!normalized.ok)return null;
 return manualPhoneSchema.parse({value:normalized.handle.value,choice,sourceUrl:observation.url,retrievedAt:observation.retrievedAt,expiresAt:source.expiresAt});
}

/** Caller already obtained the current source snapshot with its principal/source locks. */
export function currentManualPhoneChoice(run:PhoneDiscoveryRun|undefined,choice:ManualPhoneChoice,now:number):ManualPhoneChoice|null {
 return projectManualPhoneChoice(run,choice,now)?.choice??null;
}
